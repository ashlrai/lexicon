/**
 * The resident expander (`lexicon daemon --expander`): one long-lived process
 * that holds the lexicon in memory and answers over a local socket, so a
 * keyboard shortcut or a key-capture helper gets a correction in a few
 * milliseconds instead of a Node cold start per request. It is opt-in and
 * separate from the clipboard watcher: nothing starts it but the flag.
 *
 * Transport: a Unix domain socket (`expander.sock` in `$XDG_RUNTIME_DIR/lexicon`,
 * else `$XDG_STATE_HOME/lexicon`), mode 0600 in a 0700 directory, so only the
 * same user can connect. Windows is refused until private pipe ACLs can be
 * enforced. There is no TCP
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
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { buildIndex, loadLexicon, normalizeWithIndex, sanitizeForDisplayMax } from '../core/index.js';
import type { LoadedLexicon, MatcherIndex } from '../core/index.js';
import { LEXICON_RELOAD_MS, MAX_CLIPBOARD_CHARS, lexiconFilesStamp, runClipboardOnce } from './clipboard.js';
import type { ClipboardCommonOptions, ClipboardDaemonStop, ClipboardOnceResult } from './clipboard.js';
import { Expander, isExpanderNamedKey } from './expander.js';
import type { ExpanderOptions, ExpansionAction } from './expander.js';
import { xdgStateHome } from '../util/xdg.js';
import { packageVersion } from '../util/package.js';
import { errorMessage, isEnoent } from '../util/errors.js';

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

/** Where `lexicon daemon --expander` listens unless `--socket` says otherwise. */
export function defaultExpanderSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (platform === 'win32') {
    let user = 'user';
    try {
      user = os.userInfo().username;
    } catch {
      // Naming only; running on Windows is refused until private ACLs are enforced.
    }
    return `\\\\.\\pipe\\lexicon-expander-${user.replace(/[^\w.-]/g, '_')}`;
  }
  const runtime = env.XDG_RUNTIME_DIR?.trim();
  const base = runtime && path.isAbsolute(runtime) ? runtime : xdgStateHome(env, home);
  return path.join(base, 'lexicon', 'expander.sock');
}

/** `s` safe for the terminal: a path or an error can carry escape sequences. */
function shown(s: string): string {
  return sanitizeForDisplayMax(s, 4096);
}

/** True when something answers on `socketPath`. */
function answers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.setTimeout(1000, () => {
      probe.destroy();
      // A full backlog is not evidence that the socket is stale.
      resolve(true);
    });
    probe.once('error', (e: NodeJS.ErrnoException) => {
      probe.destroy();
      resolve(e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT');
    });
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
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`${dir} must be a real private directory, not a symlink; pass --socket <path> in a dedicated directory you own`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`${dir} belongs to another user, so the expander socket would not be private; pass --socket <path> in a directory you own`);
  }
  if ((st.mode & 0o077) !== 0) {
    // A custom path may name a shared directory. Never change its permissions.
    throw new Error(`${dir} is not private; create a dedicated directory with mode 0700 and pass --socket <directory>/expander.sock`);
  }
  let existing;
  try {
    existing = await fs.lstat(socketPath);
  } catch (e) {
    if (isEnoent(e)) return;
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
  let generation = 0;
  let loadedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const refresh = async (): Promise<void> => {
    const now = Date.now();
    const next = lexiconFilesStamp(cwd);
    if (current && next === stamp && now - loadedAt < LEXICON_RELOAD_MS) return;
    try {
      const loaded = await load(cwd);
      current = { loaded, index: buildIndex(loaded.merged), generation: ++generation };
    } catch (e) {
      // A failed reload may coincide with revoked project trust. Never keep
      // using the old index across an unverified trust boundary.
      current = undefined;
      report(`expander: lexicon reload failed: ${shown(errorMessage(e))}\n`);
      throw e;
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
    let lex: Awaited<ReturnType<LexiconCache['get']>>;
    try {
      lex = await ctx.lexicon.get();
    } catch (e) {
      // The field already received the chunk we could not process. Forget
      // its old tail so recovery cannot erase the wrong text.
      expander?.reset();
      throw e;
    }
    if (!expander) expander = new Expander(lex.index, ctx.expanderOptions);
    else if (lex.generation !== generation) expander.setIndex(lex.index);
    generation = lex.generation;
    return expander;
  };

  const actionJson = (action: ExpansionAction | undefined): Json => ({ action: action ?? null });

  return async (req: unknown): Promise<Json> => {
    if (!isRecord(req) || typeof req.op !== 'string') throw new Error('request must be a JSON object with an "op"');
    switch (req.op) {
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
        throw new Error(`unknown op; expected ping, normalize, type, key, reset or clipboard`);
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
  if (platform === 'win32') {
    throw new Error('the resident expander is unavailable on Windows until private named-pipe ACLs can be enforced; use lexicon daemon --once instead');
  }
  const socketPath = opts.socketPath ?? defaultExpanderSocketPath(opts.env ?? process.env, platform);
  const load = opts.load ?? ((dir: string) => loadLexicon({ cwd: dir, parseSkipped: false }));
  const lexicon = lexiconCache(cwd, load, (s) => {
    if (!quiet) err(s);
  });
  // Fail before listening: a lexicon that will not load is the user's to fix now.
  const first = await lexicon.get();

  if (opts.signal?.aborted) return 'abort';
  await prepareSocketPath(socketPath);
  let stopped = false;

  // One clipboard read-correct-write at a time: two shortcuts pressed together
  // would otherwise interleave reads and writes of the same clipboard.
  let clipboardQueue: Promise<unknown> = Promise.resolve();
  const clipboard = (paste: boolean): Promise<ClipboardOnceResult> => {
    const run = clipboardQueue.then(() => {
      if (stopped) throw new Error('expander is stopping');
      return runClipboardOnce({
        ...opts,
        cwd,
        paste,
        quiet: true,
        out: () => undefined,
        err: (s) => {
          if (!quiet) err(`expander: ${shown(s.trimEnd())}\n`);
        },
        lexicon: async () => (await lexicon.get()).loaded,
      });
    });
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
  // Each source processes one request at a time. Bound both queued text and
  // sources, including clients that never read their answers.
  const maxQueued = 64;
  const maxQueuedChars = 2 * MAX_EXPANDER_REQUEST_CHARS;
  const maxResponseBytes = 1_000_000;
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (stopped || sockets.size >= 32) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setEncoding('utf8');
    const handle = createExpanderSession(ctx);
    let buffered = '';
    let queued = 0;
    let queuedChars = 0;
    let closing = false;
    let chain: Promise<void> = Promise.resolve();
    const send = async (body: Json): Promise<void> => {
      if (socket.destroyed || stopped) return;
      let line = `${JSON.stringify(body)}\n`;
      const oversized = Buffer.byteLength(line) > maxResponseBytes;
      if (oversized) {
        closing = true;
        buffered = '';
        socket.off('data', onData);
        socket.on('data', () => undefined);
        line = `${JSON.stringify({ ok: false, error: 'response is too large; normalize a smaller text' })}\n`;
      }
      // Await the actual write, rather than growing the writable buffer while
      // a client stops reading. A stalled writer is disconnected after 5 s.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => socket.destroy(), 5000);
        const done = (): void => {
          clearTimeout(timer);
          socket.off('close', done);
          resolve();
        };
        socket.once('close', done);
        socket.write(line, done);
      });
      // An omitted action leaves the source and this session out of sync.
      // Disconnect so the source must begin with a new empty buffer.
      if (oversized) socket.end();
    };
    const closeWithError = (error: string): void => {
      if (closing) return;
      closing = true;
      buffered = '';
      socket.off('data', onData);
      // Drain already-sent bytes so the peer can read the error before EOF.
      socket.on('data', () => undefined);
      chain = chain.then(async () => {
        await send({ ok: false, error });
        socket.end();
      });
    };
    const onData = (data: string): void => {
      buffered += data;
      let nl: number;
      while ((nl = buffered.indexOf('\n')) !== -1) {
        if (nl > MAX_EXPANDER_REQUEST_CHARS) {
          closeWithError(`request is longer than ${MAX_EXPANDER_REQUEST_CHARS} characters`);
          return;
        }
        const line = buffered.slice(0, nl).replace(/\r$/, '');
        buffered = buffered.slice(nl + 1);
        if (line.trim() === '') continue;
        if (queued >= maxQueued || queuedChars + line.length > maxQueuedChars) {
          closeWithError('too many queued requests; wait for responses before sending more');
          return;
        }
        queued += 1;
        queuedChars += line.length;
        chain = chain.then(async () => {
          try {
            if (stopped || socket.destroyed || socket.writableEnded) return;
            let id: unknown;
            let parsing = true;
            try {
              const req: unknown = JSON.parse(line);
              parsing = false;
              if (isRecord(req)) id = req.id;
              const body = await handle(req);
              await send({ ...(id === undefined ? {} : { id }), ok: true, ...body });
            } catch (e) {
              const error = parsing && e instanceof SyntaxError ? 'request is not valid JSON' : errorMessage(e);
              await send({ ...(id === undefined ? {} : { id }), ok: false, error });
            }
          } finally {
            queued -= 1;
            queuedChars -= line.length;
          }
        });
      }
      if (buffered.length > MAX_EXPANDER_REQUEST_CHARS) {
        closeWithError(`request is longer than ${MAX_EXPANDER_REQUEST_CHARS} characters`);
      }
    };
    socket.on('data', onData);
    socket.on('end', () => {
      // nc and socket.end(request) half-close their input before an async
      // request finishes. Keep our output open until every response is sent.
      chain = chain.then(async () => {
        if (!closing && buffered.trim() !== '') await send({ ok: false, error: 'request must end with a newline' });
        socket.end();
      });
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });

  let finish!: (by: ClipboardDaemonStop) => void;
  let fail!: (e: Error) => void;
  const done = new Promise<ClipboardDaemonStop>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  // Attach before listening: a startup failure may reject before we await it.
  void done.catch(() => undefined);
  const stop = (by: ClipboardDaemonStop): void => {
    if (stopped) return;
    stopped = true;
    finish(by);
  };
  const onAbort = (): void => stop('abort');
  const onInt = (): void => stop('SIGINT');
  const onTerm = (): void => stop('SIGTERM');
  const onError = (e: Error): void => {
    stopped = true;
    fail(e);
  };
  server.on('error', onError);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (opts.signal?.aborted) stop('abort');
    if (!stopped) {
      await fs.chmod(socketPath, 0o600);
      if (!quiet) out(`lexicon expander listening on ${shown(socketPath)} (${first.loaded.merged.terms.length} terms); ctrl-C to stop\n`);
      opts.onListening?.(socketPath);
    }
    return await done;
  } finally {
    stopped = true;
    opts.signal?.removeEventListener('abort', onAbort);
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      // net removes the socket it owns. An extra unlink could delete a new
      // server's socket created at this path after ours has closed.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    server.off('error', onError);
    // Queued clipboard work is cancelled by `stopped`; work already running
    // finishes before the caller can observe a completed shutdown.
    await clipboardQueue;
  }
}
