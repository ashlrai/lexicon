/**
 * The resident expander (`lexicon daemon --expander`): one long-lived process
 * that holds the lexicon in memory and answers over a local socket, so a
 * keyboard shortcut or a key-capture helper gets a correction in a few
 * milliseconds instead of a Node cold start per request. It is opt-in and
 * separate from the clipboard watcher: nothing starts it but the flag.
 *
 * Transport: a Unix domain socket (`expander.sock` in `$XDG_RUNTIME_DIR/lexicon`,
 * else `$XDG_STATE_HOME/lexicon`), mode 0600 in a 0700 directory, so only the
 * same user can connect; on Windows a named pipe per user. There is no TCP
 * port and no token: file permissions are the access control, as for
 * ssh-agent.
 *
 * Protocol: newline-delimited JSON, one request per line, one response per
 * line in order. Every request may carry an `id`, echoed back. Responses are
 * `{ id, ok: true, ... }` or `{ id, ok: false, error }`.
 *
 *   {"op":"ping"}                        -> { version, terms }
 *   {"op":"normalize","text":"..."}      -> { output, changed, replacements }
 *   {"op":"type","text":"a"}             -> { action: ExpansionAction | null }
 *   {"op":"key","key":"Backspace"}       -> { action: ExpansionAction | null }
 *   {"op":"reset"}                       -> {}
 *   {"op":"clipboard","paste":true}      -> { changed, written, corrections, pasted }
 *
 * `type`/`key`/`reset` drive the expansion core (./expander.ts); each
 * connection is one keyboard source with its own buffer. `clipboard` is
 * `lexicon daemon --once [--paste]` without the cold start, e.g. from a
 * shortcut: `echo '{"op":"clipboard","paste":true}' | nc -U <socket>`.
 *
 * Typed text is never logged: a key source sees passwords too.
 */
import net from 'node:net';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildIndex, loadLexicon, normalizeWithIndex, sanitizeForDisplayMax } from '../core/index.js';
import type { LoadedLexicon, MatcherIndex } from '../core/index.js';
import { LEXICON_RELOAD_MS, MAX_CLIPBOARD_CHARS, lexiconFilesStamp, runClipboardOnce } from './clipboard.js';
import type { ClipboardCommonOptions, ClipboardDaemonStop, ClipboardOnceResult } from './clipboard.js';
import { Expander, isExpanderNamedKey } from './expander.js';
import type { ExpanderOptions, ExpansionAction } from './expander.js';
import { cliReadContext, defaultExpanderSocketPath, isFastRead } from './fast-client.js';
import { packageVersion } from '../util/package.js';

export { defaultExpanderSocketPath } from './fast-client.js';

export interface ExpanderServerOptions extends ClipboardCommonOptions {
  /** Socket path (named pipe on Windows). Default defaultExpanderSocketPath(). */
  socketPath?: string;
  /** Abort to stop (in addition to SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Options for every connection's Expander. */
  expanderOptions?: ExpanderOptions;
  /** Called once the socket accepts connections; tests connect from here. */
  onListening?: (socketPath: string) => void;
  /** Lexicon loader. Default loadLexicon for `cwd`, untrusted project files unparsed. */
  load?: (cwd: string) => Promise<LoadedLexicon>;
}

/** Longest request line, in characters. A longer one closes the connection. */
export const MAX_EXPANDER_REQUEST_CHARS = 4 * MAX_CLIPBOARD_CHARS;
/** Longest `type` chunk: a dictation tool may inject a sentence, not a document. */
export const MAX_EXPANDER_TYPE_CHARS = 4096;
/** Most bytes a Unix socket path may have (macOS and the BSDs: 104 with the NUL). */
const MAX_UNIX_SOCKET_PATH_BYTES = 103;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `s` safe for the terminal: a path or an error can carry escape sequences. */
function shown(s: string): string {
  return sanitizeForDisplayMax(s, 4096);
}

function isCode(e: unknown, code: string): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}

/** True when something answers on `socketPath`. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

/**
 * Make `socketPath` ready to listen on (POSIX): its directory exists, belongs
 * to this user and is private, and a stale socket left by a crash is removed.
 * A live expander, or a path that is not a socket, is refused, never removed.
 */
export async function prepareSocketPath(socketPath: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new Error(`socket path is longer than ${MAX_UNIX_SOCKET_PATH_BYTES} bytes, the most a Unix socket allows: ${socketPath}; pass a shorter one with --socket <path>`);
  }
  const dir = path.dirname(socketPath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const st = await fs.stat(dir);
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${dir} belongs to another user, so the expander socket would not be private; pass --socket <path> in a directory you own`);
  }
  if ((st.mode & 0o077) !== 0) {
    // Ours, but group or world can reach it: tighten instead of exposing the socket.
    await fs.chmod(dir, 0o700);
  }
  let existing;
  try {
    existing = await fs.lstat(socketPath);
  } catch (e) {
    if (isCode(e, 'ENOENT')) return;
    throw e;
  }
  if (!existing.isSocket()) {
    throw new Error(`${socketPath} exists and is not a socket; it was left alone. Remove it, or pass --socket <path>`);
  }
  if (await answers(socketPath)) {
    throw new Error(`an expander is already listening on ${socketPath}; stop it first, or pass --socket <path>`);
  }
  await fs.unlink(socketPath);
}

/** The lexicon a resident process serves, reloaded when its files change. */
interface LexiconCache {
  get(): Promise<{ loaded: LoadedLexicon; index: MatcherIndex; generation: number }>;
}

function lexiconCache(cwd: string, load: (cwd: string) => Promise<LoadedLexicon>, report: (s: string) => void): LexiconCache {
  let current: { loaded: LoadedLexicon; index: MatcherIndex; generation: number } | undefined;
  let stamp: string | undefined;
  let loadedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    const now = Date.now();
    const next = lexiconFilesStamp(cwd);
    if (current && next === stamp && now - loadedAt < LEXICON_RELOAD_MS) return;
    try {
      const loaded = await load(cwd);
      current = { loaded, index: buildIndex(loaded.merged), generation: (current?.generation ?? 0) + 1 };
    } catch (e) {
      // Keep serving the previous lexicon while the file is broken.
      if (!current) throw e;
      report(`expander: lexicon reload failed, using previous: ${shown(errorMessage(e))}\n`);
    }
    stamp = next;
    loadedAt = now;
  };
  return {
    async get() {
      // One reload at a time: concurrent requests share it.
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      await pending;
      return current!;
    },
  };
}

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What one connection needs from the server. */
interface ConnectionContext {
  lexicon: LexiconCache;
  expanderOptions: ExpanderOptions;
  version: string;
  clipboard: (paste: boolean) => Promise<ClipboardOnceResult>;
}

/** Per-connection request handler; exported for tests that skip the socket. */
export function createExpanderSession(ctx: ConnectionContext): (req: unknown) => Promise<Json> {
  let expander: Expander | undefined;
  let generation = 0;

  const withExpander = async (refresh: boolean): Promise<Expander> => {
    // A keystroke with no whitespace cannot expand, so it skips the stat of
    // the lexicon files; the next word boundary picks up any edit.
    if (expander && !refresh) return expander;
    const lex = await ctx.lexicon.get();
    if (!expander) expander = new Expander(lex.index, ctx.expanderOptions);
    else if (lex.generation !== generation) expander.setIndex(lex.index);
    generation = lex.generation;
    return expander;
  };

  const actionJson = (action: ExpansionAction | undefined): Json => ({ action: action ?? null });

  return async (req: unknown): Promise<Json> => {
    if (!isRecord(req) || typeof req.op !== 'string') throw new Error('request must be a JSON object with an "op"');
    switch (req.op) {
      case 'cli-read': {
        // Use the CLI's fresh load, never the expander's stale-on-error cache.
        if (req.context !== cliReadContext() || !Array.isArray(req.argv) ||
            !req.argv.every((a: unknown) => typeof a === 'string') || !isFastRead(req.argv)) {
          throw new Error('CLI read context or command not supported');
        }
        const argv = req.argv as string[];
        const { runStats } = await import('../cli/cmd-learn.js');
        const { buildProgram } = await import('../cli/program.js');
        const commands = await import('../cli/commands.js');
        const { cwdOptionProblem } = await import('../cli/io.js');
        let stdout = '', stderr = '', code = 0;
        const io = { stdout: (s: string) => { stdout += s; }, stderr: (s: string) => { stderr += s; } };
        const program = buildProgram(io).configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
        const command = program.commands.find((c) => c.name() === argv[0] || c.aliases().includes(argv[0]))!;
        command.configureOutput({ writeOut: io.stdout, writeErr: io.stderr }).exitOverride().action(async (...args: unknown[]) => {
          const opts: Record<string, unknown> & { cwd: string } = { ...command.opts(), cwd: program.opts().cwd ?? process.cwd() };
          const problem = cwdOptionProblem(opts.cwd);
          if (problem) throw problem;
          // Inspect parsed options, so abbreviations and --out=file cannot write.
          if (opts.out !== undefined) throw new Error('CLI file exports use the direct path');
          switch (command.name()) {
            case 'list': code = await commands.runList(opts, io); break;
            case 'stats': code = await runStats(opts, io); break;
            case 'path': code = await commands.runPath(opts, io); break;
            case 'export': code = await commands.runExport(args[0] as string | undefined, opts, io); break;
          }
        });
        await program.parseAsync(argv, { from: 'user' });
        return { stdout, stderr, code };
      }
      case 'ping': {
        const lex = await ctx.lexicon.get();
        return { version: ctx.version, terms: lex.loaded.merged.terms.length };
      }
      case 'normalize': {
        if (typeof req.text !== 'string') throw new Error('normalize expects "text" (a string)');
        if (req.text.length > MAX_CLIPBOARD_CHARS) throw new Error(`text is longer than ${MAX_CLIPBOARD_CHARS} characters`);
        const lex = await ctx.lexicon.get();
        const result = normalizeWithIndex(req.text, lex.index);
        return {
          output: result.output,
          changed: result.changed,
          replacements: result.replacements.map((r) => ({
            original: r.original,
            replacement: r.replacement,
            canonical: r.canonical,
            reason: r.reason,
            confidence: r.confidence,
          })),
        };
      }
      case 'type': {
        if (typeof req.text !== 'string') throw new Error('type expects "text" (a string)');
        if (req.text.length > MAX_EXPANDER_TYPE_CHARS) throw new Error(`type text is longer than ${MAX_EXPANDER_TYPE_CHARS} characters`);
        const e = await withExpander(/\s/u.test(req.text));
        return actionJson(e.type(req.text));
      }
      case 'key': {
        if (typeof req.key !== 'string' || !isExpanderNamedKey(req.key)) {
          throw new Error('key expects "key": Backspace, Enter, Tab, Escape, Delete, Left, Right, Up, Down, Home, End, PageUp, PageDown or reset');
        }
        const e = await withExpander(false);
        return actionJson(e.key(req.key));
      }
      case 'reset':
        expander?.reset();
        return {};
      case 'clipboard': {
        if (req.paste !== undefined && typeof req.paste !== 'boolean') throw new Error('clipboard "paste" must be true or false');
        return { ...(await ctx.clipboard(req.paste === true)) };
      }
      default:
        throw new Error(`unknown op; expected ping, normalize, type, key, reset, clipboard or cli-read`);
    }
  };
}

/**
 * Run the resident expander until SIGINT, SIGTERM or `signal`. Resolves with
 * what stopped it (daemonStopExitCode turns that into the exit status).
 */
export async function runExpanderServer(opts: ExpanderServerOptions = {}): Promise<ClipboardDaemonStop> {
  const cwd = opts.cwd ?? process.cwd();
  const quiet = opts.quiet ?? false;
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  const platform = opts.platform ?? process.platform;
  const socketPath = opts.socketPath ?? defaultExpanderSocketPath(opts.env ?? process.env, platform);
  const load = opts.load ?? ((dir: string) => loadLexicon({ cwd: dir, parseSkipped: false }));
  const lexicon = lexiconCache(cwd, load, (s) => {
    if (!quiet) err(s);
  });
  // Fail before listening: a lexicon that will not load is the user's to fix now.
  const first = await lexicon.get();

  if (opts.signal?.aborted) return 'abort';
  if (platform !== 'win32') await prepareSocketPath(socketPath);

  // One clipboard read-correct-write at a time: two shortcuts pressed together
  // would otherwise interleave reads and writes of the same clipboard.
  let clipboardQueue: Promise<unknown> = Promise.resolve();
  const clipboard = (paste: boolean): Promise<ClipboardOnceResult> => {
    const run = clipboardQueue.then(() =>
      runClipboardOnce({
        ...opts,
        cwd,
        paste,
        quiet: true,
        out: () => undefined,
        err: (s) => {
          if (!quiet) err(`expander: ${shown(s.trimEnd())}\n`);
        },
        lexicon: async () => (await lexicon.get()).loaded,
      }),
    );
    clipboardQueue = run.catch(() => undefined);
    return run;
  };

  const ctx: ConnectionContext = {
    lexicon,
    expanderOptions: opts.expanderOptions ?? {},
    version: packageVersion(import.meta.url),
    clipboard,
  };

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    const handle = createExpanderSession(ctx);
    let buffered = '';
    // Requests on one connection are answered in order: a key source's
    // Backspace must not overtake the space typed before it.
    let chain: Promise<void> = Promise.resolve();
    const send = (body: Json): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(body)}\n`);
    };
    const onData = (data: string): void => {
      buffered += data;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, nl).replace(/\r$/, '');
        buffered = buffered.slice(nl + 1);
        if (line.trim() === '') continue;
        chain = chain.then(async () => {
          let id: unknown;
          try {
            const req: unknown = JSON.parse(line);
            if (isRecord(req)) id = req.id;
            const body = await handle(req);
            send({ ...(id === undefined ? {} : { id }), ok: true, ...body });
          } catch (e) {
            const error = e instanceof SyntaxError ? 'request is not valid JSON' : errorMessage(e);
            send({ ...(id === undefined ? {} : { id }), ok: false, error });
          }
        });
      }
      if (buffered.length > MAX_EXPANDER_REQUEST_CHARS) {
        buffered = '';
        // Answer, then end our side. Whatever else the client sends is read
        // and dropped, never buffered; destroying the socket here instead made
        // a client still writing fail with EPIPE before it read the answer.
        socket.off('data', onData);
        socket.on('data', () => undefined);
        void chain.then(() => {
          send({ ok: false, error: `request is longer than ${MAX_EXPANDER_REQUEST_CHARS} characters` });
          socket.end();
        });
      }
    };
    socket.on('data', onData);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (platform !== 'win32') await fs.chmod(socketPath, 0o600);

  if (!quiet) {
    out(`lexicon expander listening on ${shown(socketPath)} (${first.loaded.merged.terms.length} terms); ctrl-C to stop\n`);
  }
  opts.onListening?.(socketPath);

  return await new Promise<ClipboardDaemonStop>((resolve) => {
    let stopped = false;
    const onAbort = (): void => stop('abort');
    const onInt = (): void => stop('SIGINT');
    const onTerm = (): void => stop('SIGTERM');
    const stop = (by: ClipboardDaemonStop): void => {
      if (stopped) return;
      stopped = true;
      opts.signal?.removeEventListener('abort', onAbort);
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      for (const s of sockets) s.destroy();
      server.close(() => {
        // net removes its own socket file on close; this covers one it did not.
        if (platform === 'win32') {
          resolve(by);
          return;
        }
        void fs.unlink(socketPath).catch(() => undefined).finally(() => resolve(by));
      });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    // Aborted while the socket was being set up (or by the listening message).
    if (opts.signal?.aborted) stop('abort');
  });
}
