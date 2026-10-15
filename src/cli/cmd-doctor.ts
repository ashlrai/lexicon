/**
 * `lexicon doctor`: one pass over everything that has to line up for dictation
 * to work -- the lexicon files themselves, the Claude registration, the
 * clipboard backend, the voice toolchain, the login service -- reported as a
 * list of checks. `runDoctorReport` returns the structured report (the MCP
 * `lexicon_doctor` tool returns it verbatim); `runDoctor` renders it.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectClipboardBackend } from '../daemon/clipboard-backends.js';
import { DEFAULT_MODEL, resolveModel } from '../voice/models.js';
import { WHISPER_BIN_NAMES, installHint } from '../voice/process.js';
import { findOnPathSync, locateToolSync } from '../util/which.js';
import { isRecord } from '../util/json.js';
import { readDoctorConfigJson, readDoctorConfigText } from './doctor-config-read.js';
import { errorMessage } from '../util/errors.js';
import { packageVersion } from '../util/package.js';
import { getTrustPath, isTrusted, readLexiconFile, resolvePaths } from '../core/index.js';
import { configPathFor } from './cmd-install.js';
import type { LexiconFile, Term, TermScope } from '../core/index.js';
import {
  HOOK_EVENTS,
  claudeConfigDir,
  defaultExec,
  findInstalledLexiconPlugin,
  settingsHasLexiconHook,
} from './claude-settings.js';
import {
  SYSTEMD_UNIT_NAME,
  launchAgentPath,
  programPathFromPlist,
  programPathFromTaskXml,
  programPathFromUnit,
  scheduledTaskName,
  serveLabel,
  systemdUnitPath,
} from './serve-paths.js';
import { dim, green, line, plural, red, resolveCwd, safeLines, yellow } from './io.js';
import type { CommonOptions, IO } from './io.js';

/** Obvious English words that make terrible aliases (they'd fire constantly). */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did',
  'get', 'let', 'say', 'she', 'too', 'use', 'off', 'ash', 'sauce', 'with', 'this', 'that', 'from',
  'they', 'have', 'been', 'will', 'what', 'when', 'your', 'there', 'their', 'about', 'which', 'time',
  'like', 'just', 'over', 'also', 'into', 'some', 'than', 'then', 'them', 'well', 'were', 'more',
]);

/** Clients whose MCP registration lives in a config file `lexicon install` writes. */
const FILE_CLIENTS = ['codex', 'cursor', 'windsurf', 'gemini', 'claude-desktop', 'vscode'] as const;

function declaresTransport(entry: unknown): boolean {
  if (!isRecord(entry) || entry.enabled === false || entry.disabled === true) return false;
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return false;
  if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') return false;
  if (entry.command !== undefined) {
    return typeof entry.command === 'string' && entry.command.trim() !== '' && entry.url === undefined
      && (entry.type === undefined || entry.type === 'stdio')
      && (entry.args === undefined || (Array.isArray(entry.args) && entry.args.every((arg) => typeof arg === 'string')));
  }
  return typeof entry.url === 'string' && entry.url.trim() !== '' && entry.args === undefined
    && (entry.type === undefined || entry.type === 'http' || entry.type === 'sse');
}

function withoutTomlComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== undefined) {
      if (quote === '"' && ch === '\\') i++;
      else if (ch === quote) quote = undefined;
    } else if (ch === '#') return line.slice(0, i).trimEnd();
    else if (ch === '"' || ch === "'") quote = ch;
  }
  return line;
}

/** Scan real table/body lines, ignoring comments and quoted value continuations. */
function codexDeclaration(text: string): Record<string, unknown> | undefined {
  let quote: string | undefined;
  let active = false;
  let entry: Record<string, unknown> | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (quote === undefined) {
      if (/^\s*\[/.test(line)) {
        active = /^\s*\[\s*mcp_servers\s*\.\s*(?:lexicon|"lexicon"|'lexicon')\s*\]\s*(#.*)?$/.test(line);
        if (active) {
          if (entry) return undefined; // Duplicate declarations are ambiguous.
          entry = {};
        }
      } else if (active) {
        const field = /^\s*("(?:[^"\\]|\\.)*"|'[^'\r\n]*'|[A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (field && entry) {
          let key: string;
          try {
            key = field[1].startsWith('"') ? JSON.parse(field[1]) as string
              : field[1].startsWith("'") ? field[1].slice(1, -1) : field[1];
          } catch {
            return undefined;
          }
          if (['command', 'url', 'args', 'type', 'enabled', 'disabled'].includes(key)) {
            if (Object.hasOwn(entry, key)) return undefined;
            const raw = withoutTomlComment(field[2]).trim();
            // Install emits JSON-compatible basic strings/arrays. Literal strings
            // are also conventional TOML. Unknown transport syntax is not proof
            // of a usable declaration; other config fields remain opaque.
            const literal = /^'([^'\r\n]*)'\s*(?:#.*)?$/.exec(raw);
            try {
              entry[key] = literal ? literal[1] : JSON.parse(raw) as unknown;
            } catch {
              return undefined;
            }
          }
        }
      }
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote !== undefined) {
        if (quote.startsWith('"') && ch === '\\') { i++; continue; }
        if (line.startsWith(quote, i)) {
          const closing = quote[0];
          i += quote.length - 1;
          // TOML permits one/two quotes immediately before a triple delimiter.
          if (quote.length === 3) while (line[i + 1] === closing) i++;
          quote = undefined;
        }
      } else if (ch === '#') break;
      else if (ch === '"' || ch === "'") {
        quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length - 1;
      }
    }
  }
  return quote === undefined ? entry : undefined;
}

/** Configuration metadata only; does not prove a client is present or connected. */
export function registersLexicon(client: (typeof FILE_CLIENTS)[number], text: string): boolean {
  if (client === 'codex') return declaresTransport(codexDeclaration(text));
  try {
    const cfg: unknown = JSON.parse(text);
    if (!isRecord(cfg)) return false;
    const servers = client === 'vscode' ? cfg.servers : cfg.mcpServers;
    return isRecord(servers) && declaresTransport(servers.lexicon);
  } catch {
    return false;
  }
}

function parsesAsJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export interface DoctorDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Run a binary and return stdout; must throw on failure. */
  exec?: (file: string, args: readonly string[]) => string;
  /** Claude settings file. Default ~/.claude/settings.json. */
  settingsPath?: string;
  /** Claude's plugin registry. Default ~/.claude/plugins/installed_plugins.json. */
  installedPluginsPath?: string;
  /** Default home for lexicon/client/service paths; explicit env/path overrides still apply. */
  home?: string;
  /** Numeric uid for `launchctl print gui/<uid>/<label>`. Default process.getuid(). */
  uid?: number;
}

export type DoctorLevel = 'ok' | 'fail' | 'warn' | 'info';

export interface DoctorCheck {
  level: DoctorLevel;
  /** Unsanitized: quotes paths, canonicals, aliases and error text. Renderers apply `safeLines`. */
  message: string;
}

/** Structured `lexicon doctor` result; `runDoctor` renders it, the MCP `lexicon_doctor` tool returns it as JSON. */
export interface DoctorReport {
  /** True when no check is at level `fail`. */
  ok: boolean;
  /**
   * True when configuration declares an integration for this user: a
   * lexicon that exists and has at least one term, wired into at least one
   * agent. It does not prove a live client connection. `ok` is not readiness, because
   * a lexicon with no terms and no integration has nothing to fail.
   */
  ready: boolean;
  /** One sentence describing the state, safe to relay to the user verbatim. */
  summary: string;
  /**
   * The single most useful thing to do next, as one line. Always present:
   * when there is nothing to fix it says so and names the way to use the
   * thing instead. A caller that shows the user only `summary` and
   * `nextStep` has told them everything that matters.
   */
  nextStep: string;
  checks: DoctorCheck[];
  paths: {
    global: string;
    project?: string;
    /** Trust registry next to the global lexicon. */
    trust: string;
    /** Claude Code settings.json that was inspected for hooks. */
    settings: string;
    /** Claude Code plugin registry that was inspected. */
    installedPlugins: string;
  };
  versions: {
    lexicon: string;
    node: string;
    platform: NodeJS.Platform;
  };
}


interface LoginServiceProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exec: (file: string, args: readonly string[]) => string;
  home: string;
  uid?: number;
}

const SERVE_REINSTALL_HINT = 'run: lexicon serve --uninstall && lexicon serve --install';

/**
 * One check for the `lexicon serve` login service. darwin: `launchctl print
 * gui/<uid>/<label>` (loaded when it exits 0) and the plist's program path;
 * linux: `systemctl --user is-active lexicon-serve.service` and the unit's
 * ExecStart path. A loaded service whose program file is missing is a `fail`
 * (it crash-loops under KeepAlive and nothing listens on the port); a service
 * file that exists but is not loaded is a `warn`; no service is an `info`.
 */
export async function checkLoginService(probe: LoginServiceProbe): Promise<DoctorCheck> {
  const { platform, env, exec, home } = probe;
  let loaded = false;
  let file: string | undefined;
  let program: string | undefined;
  let name: string;
  if (platform === 'darwin') {
    name = `login service ${serveLabel(env)}`;
    const uid = probe.uid ?? process.getuid?.() ?? 501;
    try {
      exec('launchctl', ['print', `gui/${uid}/${serveLabel(env)}`]);
      loaded = true;
    } catch {
      loaded = false;
    }
    file = launchAgentPath(home, env);
  } else if (platform === 'linux') {
    name = `login service ${SYSTEMD_UNIT_NAME}`;
    try {
      loaded = exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]).trim() === 'active';
    } catch {
      loaded = false;
    }
    file = systemdUnitPath(home, env);
  } else if (platform === 'win32') {
    // No file on disk: a Scheduled Task lives in the Task Scheduler store, so
    // `/Query /XML` is both the "is it registered" probe and the only way to
    // read back the program it runs.
    const taskName = scheduledTaskName(env);
    name = `login service ${taskName}`;
    let xml: string | undefined;
    try {
      xml = exec('schtasks', ['/Query', '/TN', taskName, '/XML']);
      loaded = true;
    } catch {
      loaded = false;
    }
    if (xml !== undefined) program = programPathFromTaskXml(xml);
    if (!loaded) {
      return { level: 'info', message: 'no login service installed (optional; keeps the local API up: lexicon serve --install)' };
    }
    if (program !== undefined && !existsSync(program)) {
      return { level: 'fail', message: `${name} points at a missing file: ${program} (${SERVE_REINSTALL_HINT})` };
    }
    return { level: 'ok', message: `${name} is registered and runs at logon` };
  } else {
    return { level: 'info', message: `login service is not automated on ${platform}; run \`lexicon serve\` from your session startup instead` };
  }
  let fileExists = false;
  try {
    const text = await fs.readFile(file, 'utf8');
    fileExists = true;
    program = platform === 'darwin' ? programPathFromPlist(text) : programPathFromUnit(text);
  } catch {
    fileExists = false;
  }
  if (!loaded && !fileExists) {
    return { level: 'info', message: 'no login service installed (optional; keeps the local API up: lexicon serve --install)' };
  }
  if (program !== undefined && !existsSync(program)) {
    return { level: 'fail', message: `${name} points at a missing file: ${program} (${SERVE_REINSTALL_HINT})` };
  }
  if (!loaded) {
    return { level: 'warn', message: `${name} is installed at ${file} but not loaded (${SERVE_REINSTALL_HINT})` };
  }
  if (!fileExists) {
    // The label is loaded in this login session, but not from the file we were
    // told to inspect, so we cannot say it is ours or that it is healthy. A
    // green tick here claims more than we know -- and reads, to someone who
    // never installed a service, as though setup had installed one anyway.
    // Meaning first: `safe()` caps a rendered check at 200 characters, and the
    // path is the long, skippable part.
    return { level: 'info', message: `${name} is loaded, but not from this install (${SERVE_REINSTALL_HINT}; no service file at ${file})` };
  }
  return { level: 'ok', message: `${name} loaded${program !== undefined ? ` (${program} exists)` : ''}` };
}

/** A lexicon file that exists but could not be read: the path, its scope, and why. */
interface UnreadableLexicon {
  path: string;
  scope: TermScope;
  /** The error from `readLexiconFile`, already naming the file. */
  error: string;
}

/**
 * The parse error with the "... at <path>: " preamble removed and folded onto
 * one line, so `summary` stays one relayable sentence. Both store.ts messages
 * ("Failed to parse lexicon YAML at X: ..." and "Invalid lexicon at X: ...")
 * open by naming the file, and the summary is about that file already;
 * repeating an absolute path here would spend the whole 200-character display
 * budget on something the check line and `nextStep` also carry. Zod's
 * "Invalid lexicon:" errors are a bulleted list, so the cap keeps the first
 * bullets, which are the ones that say where to look.
 */
function parseReason(error: string, filePath: string, max = 110): string {
  const marker = `${filePath}: `;
  const at = error.lastIndexOf(marker);
  const body = at >= 0 ? error.slice(at + marker.length) : error;
  const flat = body.replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `lexicon edit`, with the flag that opens the file that is actually broken. */
function editCommand(scope: TermScope): string {
  return scope === 'project' ? 'lexicon edit --project' : 'lexicon edit';
}

/**
 * Turns the check list into the three fields a caller can act on without
 * reading it: `ready`, one sentence, and one next step.
 *
 * The ordering of `nextStep` is the order a human would fix things in --
 * there is no point registering a client for a lexicon with no terms, and no
 * point adding terms the agent will never see. The first unmet condition
 * wins; everything else waits for the next run.
 */
function summarize(
  checks: readonly DoctorCheck[],
  state: { terms: number; wired: boolean; untrustedProject: boolean; unreadable: readonly UnreadableLexicon[] },
): { ready: boolean; summary: string; nextStep: string } {
  const fails = checks.filter((c) => c.level === 'fail');
  const warns = checks.filter((c) => c.level === 'warn');
  const counts = `${state.terms} term${state.terms === 1 ? '' : 's'}`;
  const ready = state.terms > 0 && state.wired && fails.length === 0;

  // A file that exists but will not parse is not "not set up yet": it has
  // terms, `lexicon setup` cannot repair it, and running setup exits 0 having
  // done nothing. Saying so first, with the file and the parse error, is the
  // difference between a dead end and a two-minute fix.
  if (state.unreadable.length > 0) {
    const first = state.unreadable[0];
    const alsoProject = state.unreadable.length > 1 ? ' The project lexicon does not parse either.' : '';
    return {
      ready: false,
      summary:
        `The ${first.scope} lexicon exists but does not parse, so no corrections are happening: ` +
        `${parseReason(first.error, first.path)}${alsoProject}`,
      // Command first, path second: a rendered line is capped at 200
      // characters and an absolute path can use most of that, so what gets
      // cut has to be the part the check list already showed.
      nextStep:
        `Open it and fix the parse error: ${editCommand(first.scope)}  ` +
        `(lexicon setup will not repair this). The file is ${first.path}`,
    };
  }
  if (state.terms === 0) {
    return {
      ready: false,
      summary: 'Lexicon is not set up yet: there are no terms, so nothing will be corrected.',
      nextStep: 'Run: lexicon setup',
    };
  }
  if (fails.length > 0) {
    return {
      ready: false,
      summary: `Lexicon has ${counts} but ${fails.length} check${fails.length === 1 ? '' : 's'} failed: ${fails[0].message}`,
      // Every failing message ends in its own "(run: ...)" hint, so the first
      // failure carries its fix with it.
      nextStep: `Fix the first failure: ${fails[0].message}`,
    };
  }
  if (!state.wired) {
    return {
      ready: false,
      summary: `Lexicon has ${counts}, but no agent is wired up to use them yet.`,
      nextStep: 'Run: lexicon install claude --apply  (or: lexicon setup, which detects every client you have)',
    };
  }
  if (state.untrustedProject) {
    return {
      ready: true,
      summary: `Lexicon is set up with ${counts}. This repo has a project lexicon that has not been trusted, so it is not merged.`,
      nextStep: 'Review the project lexicon (trust_project with action "status"), then run: lexicon trust',
    };
  }
  return {
    ready: true,
    summary: `Lexicon is configured: ${counts}, with an agent integration declared${warns.length > 0 ? `, with ${warns.length} optional item${warns.length === 1 ? '' : 's'} not configured` : ''}.`,
    nextStep: 'Nothing to fix in the configuration. Dictate a sentence with one of your names to verify the client applies it.',
  };
}

/** Check messages quote paths, canonicals, aliases and error text, so the whole message is sanitized here. */
function renderCheck(c: DoctorCheck): string {
  const message = safeLines(c.message);
  switch (c.level) {
    case 'ok':
      return `${green('✓')} ${message}`;
    case 'fail':
      return `${red('✗')} ${message}`;
    case 'warn':
      return `${yellow('!')} ${message}`;
    default:
      return `${dim('·')} ${message}`;
  }
}

/** Prints a report the way `lexicon doctor` always has: one line per check, a blank line, then the verdict. Returns the exit code. */
export function renderDoctorReport(report: DoctorReport, io: IO): number {
  for (const c of report.checks) line(io, renderCheck(c));
  const failures = report.checks.filter((c) => c.level === 'fail').length;
  line(io);
  line(io, failures === 0 ? green('all checks passed') : red(`${failures} check${failures === 1 ? '' : 's'} failed`));
  // The two lines that matter, after the thirty that might: the same
  // `summary` and `nextStep` the MCP tool hands a model, so the terminal and
  // the agent never tell the user different things.
  line(io, safeLines(report.summary));
  // nextStep quotes check messages, which quote paths, canonicals and aliases
  // from a project file this user may not have written, so it is sanitized
  // like everything else. Each nextStep leads with its command for that
  // reason: the cap can only eat the detail, never the fix.
  const nextStep = safeLines(report.nextStep);
  line(io, report.ready && failures === 0 ? dim(nextStep) : yellow(nextStep));
  return failures === 0 ? 0 : 1;
}

export async function runDoctor(opts: CommonOptions, io: IO, deps: DoctorDeps = {}): Promise<number> {
  return renderDoctorReport(await runDoctorReport(opts, deps), io);
}

/**
 * Runs every doctor check and returns them as data (no output). `runDoctor`
 * is this plus rendering; the MCP server hands the report to the model as is.
 */
export async function runDoctorReport(opts: CommonOptions, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const exec = deps.exec ?? defaultExec;
  const cwd = resolveCwd(opts);
  const checks: DoctorCheck[] = [];
  const push = (level: DoctorLevel, message: string): void => {
    checks.push({ level, message });
  };
  // Set as the checks run; `summarize` turns them into ready/summary/nextStep.
  /** Declared plugin/hook/MCP configuration, not proof of a live connection. */
  let wired = false;
  /** True when this repo has a .lexicon.yaml the user has not approved, so its terms are not being applied. */
  let untrustedProject = false;
  /** Lexicon files that exist but do not parse. These make every other verdict wrong, so they are reported first. */
  const unreadable: UnreadableLexicon[] = [];

  // --- lexicon files -------------------------------------------------------
  const paths = resolvePaths({ cwd, env, home });
  const files: LexiconFile[] = [];

  try {
    const g = await readLexiconFile(paths.global, 'global');
    if (g.exists) {
      push('ok', `global lexicon parses: ${paths.global} (${plural(g.lexicon.terms.length, 'term')})`);
      files.push(g);
    } else {
      push('fail', `global lexicon missing: ${paths.global} (run: lexicon init)`);
    }
  } catch (err) {
    const error = errorMessage(err);
    unreadable.push({ path: paths.global, scope: 'global', error });
    // The fix comes before the detail: a rendered check is capped at 200
    // characters, and the parse error plus an absolute path will reach that.
    push('fail', `global lexicon does not parse (run: ${editCommand('global')}): ${error}`);
  }

  if (paths.project) {
    try {
      const p = await readLexiconFile(paths.project, 'project');
      push('ok', `project lexicon parses: ${paths.project} (${plural(p.lexicon.terms.length, 'term')})`);
      const trust = await isTrusted(p, { cwd });
      if (trust === 'trusted') {
        push('ok', 'project lexicon is trusted and merged');
        files.push(p);
      } else if (trust === 'changed') {
        untrustedProject = true;
        push('warn', `project lexicon content changed since trusted; not merged (run lexicon trust again)`);
      } else {
        untrustedProject = true;
        push('warn', `project lexicon is untrusted and not merged: ${paths.project} (review it, then run: lexicon trust)`);
      }
    } catch (err) {
      const error = errorMessage(err);
      unreadable.push({ path: paths.project, scope: 'project', error });
      push('fail', `project lexicon does not parse (run: ${editCommand('project')}): ${error}`);
    }
  } else {
    push('info', 'no project lexicon (.lexicon.yaml) found from ' + cwd);
  }

  // --- term-level checks -----------------------------------------------------
  const canonicalOwners = new Map<string, { term: Term; scope: TermScope }[]>();
  const allTerms: { term: Term; scope: TermScope }[] = [];
  for (const f of files) {
    for (const term of f.lexicon.terms) {
      const entry = { term, scope: f.scope };
      allTerms.push(entry);
      const key = term.canonical.trim().toLowerCase();
      const list = canonicalOwners.get(key) ?? [];
      list.push(entry);
      canonicalOwners.set(key, list);
    }
  }
  push('info', `${canonicalOwners.size} unique terms across ${files.length} file${files.length === 1 ? '' : 's'}`);

  for (const [, owners] of canonicalOwners) {
    const scopes = new Set(owners.map((o) => o.scope));
    if (scopes.size > 1) {
      push('warn', `"${owners[0].term.canonical}" is defined in both global and project lexicons (project wins, aliases merge)`);
    } else if (owners.length > 1) {
      push('fail', `"${owners[0].term.canonical}" is defined ${owners.length} times in the ${owners[0].scope} lexicon`);
    }
  }

  const aliasOwners = new Map<string, Term[]>();
  for (const { term } of allTerms) {
    for (const alias of term.aliases) {
      const key = alias.trim().toLowerCase();
      if (!key) continue;
      const other = canonicalOwners.get(key);
      if (other && !other.some((o) => o.term === term) && key !== term.canonical.trim().toLowerCase()) {
        push('fail', `alias "${alias}" of "${term.canonical}" equals the canonical of "${other[0].term.canonical}" (conflict)`);
      }
      if (COMMON_WORDS.has(key)) {
        push('warn', `alias "${alias}" of "${term.canonical}" is a common English word and will fire on ordinary text`);
      }
      const list = aliasOwners.get(key) ?? [];
      list.push(term);
      aliasOwners.set(key, list);
    }
  }
  for (const [alias, owners] of aliasOwners) {
    const distinct = new Set(owners.map((t) => t.canonical.toLowerCase()));
    if (distinct.size > 1) {
      push('warn', `alias "${alias}" belongs to several terms: ${[...distinct].join(', ')} (ambiguous)`);
    }
  }
  if (allTerms.length > 0 && !checks.some((c) => c.level === 'fail' && c.message.includes('conflict'))) {
    push('ok', 'no alias/canonical conflicts');
  }

  // --- Claude Code plugin / hooks -------------------------------------------------
  const settingsPath = deps.settingsPath ?? path.join(claudeConfigDir(env, home), 'settings.json');
  const installedPluginsPath =
    deps.installedPluginsPath ?? path.join(claudeConfigDir(env, home), 'plugins', 'installed_plugins.json');
  const settings = await readDoctorConfigJson(settingsPath);
  const installed = await readDoctorConfigJson(installedPluginsPath);
  if (settings.error) push('warn', `Claude settings configuration is unconfirmed (${settings.error})`);
  if (installed.error) push('warn', `Claude installed-plugin configuration is unconfirmed (${installed.error})`);
  const pluginId = findInstalledLexiconPlugin(settings.value, installed.value);
  if (pluginId) {
    wired = true;
    push('ok', `lexicon plugin installed as ${pluginId} (its hooks and MCP server are used)`);
  } else {
    for (const event of HOOK_EVENTS) {
      if (settingsHasLexiconHook(settings.value, event)) {
        wired = true;
        push('ok', `${event} hook found in ${settingsPath}`);
      } else {
        push(
          'warn',
          `${event} hook not found in ${settingsPath} (fine if you use the plugin; otherwise run: lexicon install claude --apply)`,
        );
      }
    }
  }

  // --- other MCP clients ----------------------------------------------------------
  // `lexicon setup --clients cursor` and `lexicon install <client>` write these
  // files; without this a Cursor- or Codex-only user would be told to register
  // Claude. User-level files only, the ones `install` writes by default.
  const otherClients: string[] = [];
  for (const client of FILE_CLIENTS) {
    let file: string;
    try {
      file = configPathFor(client, { home, cwd, platform, env, project: false });
    } catch {
      continue;
    }
    const read = await readDoctorConfigText(file);
    if (read.status === 'missing') continue;
    if (read.status === 'unconfirmed') {
      push('warn', `${client} client configuration is unconfirmed (${read.reason})`);
      continue;
    }
    const text = read.text;
    if (client !== 'codex' && !parsesAsJson(text)) {
      push('warn', `could not parse ${client} client configuration as JSON, so a lexicon entry there was not checked`);
      continue;
    }
    if (registersLexicon(client, text)) {
      otherClients.push(client);
      wired = true;
      push('ok', `lexicon MCP server configuration found for ${client}: ${file}`);
    }
  }

  // --- claude CLI ---------------------------------------------------------------
  const claudeBin = findOnPathSync('claude', { env });
  if (!claudeBin) {
    push('warn', 'claude CLI not found on PATH (MCP + hook integration unavailable)');
  } else {
    push('ok', `claude CLI found: ${claudeBin}`);
    try {
      const out = exec('claude', ['mcp', 'list']);
      if (/lexicon/i.test(out)) {
        wired = true;
        push('ok', 'lexicon MCP server is registered with claude');
      } else if (pluginId) push('warn', `lexicon MCP server not listed by "claude mcp list"; the ${pluginId} plugin provides it when enabled`);
      else if (otherClients.length > 0) push('warn', `lexicon MCP server not registered with claude (using ${otherClients.join(', ')}; to add claude too, run: lexicon install claude --apply)`);
      else push('fail', 'lexicon MCP server not registered with claude (run: lexicon install claude --apply)');
    } catch (err) {
      push('warn', `could not run "claude mcp list": ${errorMessage(err)}`);
    }
  }

  // --- login service (lexicon serve --install) ------------------------------------
  checks.push(await checkLoginService({ platform, env, exec, home, ...(deps.uid !== undefined ? { uid: deps.uid } : {}) }));

  // --- clipboard -----------------------------------------------------------------
  try {
    const backend = await detectClipboardBackend(platform, env, async (bin) => findOnPathSync(bin, { env }) !== undefined);
    push('ok', `clipboard backend: ${backend.name}${backend.description ? ` (${backend.description})` : ''}`);
  } catch (err) {
    push('warn', `no clipboard backend found (${errorMessage(err)})`);
  }

  // --- voice (lexicon voice: ffmpeg -> whisper.cpp) ------------------------------
  // Warnings only: dictation is optional and the rest of the tool works without it.
  const whisperOverride = env.LEXICON_WHISPER_BIN;
  const whisperCli = whisperOverride ? (existsSync(whisperOverride) ? whisperOverride : undefined) : locateToolSync(WHISPER_BIN_NAMES, env, platform);
  if (whisperCli) push('ok', `whisper-cli found: ${whisperCli}`);
  else push('warn', `whisper-cli not found (needed by lexicon voice; ${installHint(platform, { ffmpeg: false, whisper: true })})`);
  const ffmpegOverride = env.LEXICON_FFMPEG_BIN;
  const ffmpegBin = ffmpegOverride ? (existsSync(ffmpegOverride) ? ffmpegOverride : undefined) : locateToolSync(['ffmpeg'], env, platform);
  if (ffmpegBin) push('ok', `ffmpeg found: ${ffmpegBin}`);
  else push('warn', `ffmpeg not found (needed by lexicon voice; ${installHint(platform, { ffmpeg: true, whisper: false })})`);
  const model = resolveModel(DEFAULT_MODEL, { globalPath: paths.global, env });
  push('info', model.present ? `whisper model ${DEFAULT_MODEL} present: ${model.path}` : `whisper model ${DEFAULT_MODEL} absent (lexicon voice downloads it to ${model.path} on first run)`);
  if (platform === 'darwin') {
    push('info', 'lexicon voice records the microphone: the terminal or launcher running it needs Microphone permission (System Settings > Privacy & Security > Microphone)');
  }

  const verdict = summarize(checks, { terms: canonicalOwners.size, wired, untrustedProject, unreadable });
  return {
    ok: !checks.some((c) => c.level === 'fail'),
    ready: verdict.ready,
    summary: verdict.summary,
    nextStep: verdict.nextStep,
    checks,
    paths: {
      global: paths.global,
      ...(paths.project ? { project: paths.project } : {}),
      trust: getTrustPath({ cwd }),
      settings: settingsPath,
      installedPlugins: installedPluginsPath,
    },
    versions: { lexicon: packageVersion(import.meta.url), node: process.version, platform },
  };
}
