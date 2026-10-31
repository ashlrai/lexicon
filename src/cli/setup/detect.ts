/**
 * What `lexicon setup` can work out about this machine before it changes
 * anything: which agent clients are installed, what the company is probably
 * called, where the repo root is -- plus the parsers for the list-valued
 * flags. Nothing here writes, and nothing spawns a process except through the
 * injected `SetupExec`, so a test can describe a machine instead of having one.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { homeDir } from '../../util/xdg.js';
import path from 'node:path';
import { LIMITS, UNENCODABLE_NOTE, findUnencodableChar, hasControlChars, stripInvisible } from '../../core/index.js';
import { findOnPath } from '../../util/which.js';
import type { IO } from '../io.js';
import { claudeConfigDir } from '../claude-settings.js';
import { configPathFor } from '../cmd-install.js';
import { SETUP_APPS, SETUP_CLIENTS } from './types.js';
import type { DetectedClient, SetupApp, SetupClient, SetupDeps, SetupExec } from './types.js';
/** An IO that collects everything, so an installer's multi-line report becomes one line here. */
export function captureIO(): IO & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(s: string) {
      sink.out += s;
    },
    stderr(s: string) {
      sink.err += s;
    },
  };
  return sink;
}

export function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

/**
 * What is wrong with a company or person name given to setup (`--company`,
 * `--person`, MCP `setup_lexicon`), or undefined when it can be seeded: it
 * must not be blank, must be one line with no control characters, and must
 * fit the term cap (LIMITS.word) once invisible characters are stripped and
 * it is trimmed. Checked before any step runs, so a name the write would
 * refuse (with errors about generated aliases the caller never passed) is
 * refused up front, in a dry run as well.
 */
export function setupNameProblem(value: string): string | undefined {
  const name = stripInvisible(value).trim();
  if (name === '') return 'must not be blank';
  if (hasControlChars(name)) return 'must be one line, with no control characters';
  const unencodable = findUnencodableChar(name);
  if (unencodable) return `must not contain ${unencodable} (${UNENCODABLE_NOTE})`;
  if (name.length > LIMITS.word) return `must be at most ${LIMITS.word} characters (it has ${name.length})`;
  return undefined;
}

/**
 * What is wrong with a phonetic hint given to setup (`--phonetic`, or typed
 * at the prompt), or undefined when it can be written. Blank is fine (no
 * hint); otherwise it must be one line with no control characters and fit
 * LIMITS.text once invisible characters are stripped and it is trimmed.
 * Checked before any step runs, so a hint the write would refuse no longer
 * fails only after the lexicon was created and the person term seeded.
 */
export function setupHintProblem(value: string): string | undefined {
  const hint = stripInvisible(value).trim();
  if (hint === '') return undefined;
  if (hasControlChars(hint)) return 'must be one line, with no control characters';
  const unencodable = findUnencodableChar(hint);
  if (unencodable) return `must not contain ${unencodable} (${UNENCODABLE_NOTE})`;
  if (hint.length > LIMITS.text) return `must be at most ${LIMITS.text} characters (it has ${hint.length})`;
  return undefined;
}

export function isSetupClient(value: string): value is SetupClient {
  return (SETUP_CLIENTS as readonly string[]).includes(value);
}

export function isSetupApp(value: string): value is SetupApp {
  return (SETUP_APPS as readonly string[]).includes(value);
}

/** `a,b, c` or `none` -> validated client list. Throws on an unknown name. */
export function parseClientList(value: string): SetupClient[] {
  const out: SetupClient[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name || name === 'none') continue;
    if (!isSetupClient(name)) {
      throw new Error(`unknown client "${raw.trim()}" (expected one of: ${SETUP_CLIENTS.join(', ')}, none)`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** `a,b, c` or `none` -> validated pack list against the packs on offer. Throws on an unknown name. */
export function parsePackList(value: string, available: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of value.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name || name === 'none') continue;
    if (!available.includes(name)) {
      throw new Error(`unknown pack "${raw.trim()}" (expected one of: ${available.join(', ')}, none)`);
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function findGitRoot(start: string, exists: (p: string) => boolean): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * A company name guess from the working directory: the scope of the
 * package.json name (`@ashlr/lexicon` -> `Ashlr`), else the org of the git
 * remote (`github.com/ashlrai/lexicon` -> `ashlrai`). Undefined when neither
 * yields anything. Dots and casing in the scope are preserved apart from its
 * first character (`@Ashlr.AI/lexicon` -> `Ashlr.AI`). A matching dotted
 * package author can supply the brand's spelling (`@ashlr/lexicon`, author
 * `Ashlr.AI` -> `Ashlr.AI`).
 */
export function suggestCompany(packageName: string | undefined, remoteUrl: string | undefined, author?: string): string | undefined {
  const scope = packageName?.match(/^@([A-Za-z0-9][\w.-]*)\//)?.[1];
  if (scope) {
    const brand = author?.trim();
    // Only restore a spelling present in the manifest, never invent a suffix
    // or use an unrelated author's name as the company.
    if (brand && /^[A-Za-z0-9][\w-]*(?:\.[A-Za-z0-9][\w-]*)+$/.test(brand)) {
      const normalizedBrand = brand.toLowerCase();
      const normalizedScope = scope.toLowerCase();
      if (normalizedBrand === normalizedScope || normalizedBrand.startsWith(`${normalizedScope}.`)) return brand;
    }
    return scope.charAt(0).toUpperCase() + scope.slice(1);
  }
  if (remoteUrl) {
    // https://github.com/org/repo(.git), git@github.com:org/repo.git, ssh://git@host/org/repo.
    // The delimiter must not be the // after a scheme: without that guard a
    // remote like https://github.com/octocat would read the host as the org.
    const m = remoteUrl.trim().match(/(?<!\/)[:\/]([A-Za-z0-9][\w.-]*)\/[\w.-]+?(?:\.git)?\/?$/);
    if (m && !/^(users?|orgs?)$/i.test(m[1])) return m[1];
  }
  return undefined;
}

export async function readPackageIdentity(cwd: string): Promise<{ name?: string; author?: string }> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg: unknown = JSON.parse(raw);
    if (!pkg || typeof pkg !== 'object') return {};
    const name = 'name' in pkg ? pkg.name : undefined;
    const author = 'author' in pkg ? pkg.author : undefined;
    // npm also accepts "Name <email> (url)" as an author string. Keep only
    // the name so the same brand matching applies as for an author object.
    const authorName = author && typeof author === 'object' && 'name' in author
      ? author.name
      : typeof author === 'string'
        ? author.match(/^\s*([^<>()\r\n]+?)\s*(?:<[^<>\r\n]+>\s*)?(?:\([^()\r\n]+\)\s*)?$/)?.[1]
        : undefined;
    return {
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof authorName === 'string' ? { author: authorName } : {}),
    };
  } catch {
    return {};
  }
}

export const defaultSetupExec: SetupExec = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function tryExec(exec: SetupExec, file: string, args: readonly string[]): string | undefined {
  try {
    const out = exec(file, args).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Client detection
// ---------------------------------------------------------------------------

interface DetectContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
}

const APP_BUNDLES: Partial<Record<SetupClient, string>> = {
  'claude-desktop': 'Claude.app',
  cursor: 'Cursor.app',
  vscode: 'Visual Studio Code.app',
  windsurf: 'Windsurf.app',
};

const CLI_NAMES: Partial<Record<SetupClient, string>> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  vscode: 'code',
  cursor: 'cursor',
  windsurf: 'windsurf',
};

export function configDirFor(client: SetupClient, ctx: DetectContext): string {
  if (client === 'claude') return claudeConfigDir(ctx.env, ctx.home);
  const file = configPathFor(client, { home: ctx.home, cwd: ctx.cwd, platform: ctx.platform, env: ctx.env, project: false });
  // The client's own directory: ~/.codex, ~/.cursor, ~/.codeium/windsurf, ~/.gemini,
  // ~/Library/Application Support/Claude, ~/Library/Application Support/Code.
  return client === 'vscode' ? path.dirname(path.dirname(file)) : path.dirname(file);
}

/**
 * Which clients exist on this machine: the config directory is present, the
 * app bundle sits in /Applications (macOS), or the CLI is on PATH. Never
 * spawns a process.
 */
export async function detectClients(deps: SetupDeps = {}, cwd = process.cwd()): Promise<DetectedClient[]> {
  const ctx: DetectContext = {
    home: deps.home ?? homeDir(),
    cwd,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    exists: deps.exists ?? existsSync,
  };
  const out: DetectedClient[] = [];
  for (const name of SETUP_CLIENTS) {
    let evidence: string | undefined;
    const dir = configDirFor(name, ctx);
    if (ctx.exists(dir)) evidence = dir;
    if (!evidence && ctx.platform === 'darwin' && APP_BUNDLES[name]) {
      const bundle = path.join('/Applications', APP_BUNDLES[name] as string);
      if (ctx.exists(bundle)) evidence = bundle;
    }
    if (!evidence && CLI_NAMES[name]) {
      const bin = await findOnPath(CLI_NAMES[name] as string, {
        env: ctx.env,
        platform: ctx.platform,
        exists: async (candidate: string) => ctx.exists(candidate),
      });
      if (bin) evidence = bin;
    }
    out.push(evidence ? { name, detected: true, evidence } : { name, detected: false });
  }
  return out;
}
