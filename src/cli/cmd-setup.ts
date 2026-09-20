/**
 * `lexicon setup`: the one command a new user runs. Walks through seven steps,
 * each printing a one-line result, and never re-implements an installer:
 *
 *   a. global lexicon (runInit) seeded with the git user as a person term and
 *      the company/product name (suggested from the cwd package scope or the
 *      git remote org) with suggested aliases and an optional phonetic hint
 *   b. starter packs (core/packs.ts): a checklist with developer, ai and
 *      voice-tools checked and business offered; `--packs a,b` / `--no-packs`
 *   c. repo harvest into the project lexicon (top 10, min-count 5)
 *   d. agent clients detected on this machine, installed via runInstall
 *   e. the local API as a login service via runServeInstall
 *   f. an export for the user's dictation app, written to ~/Desktop
 *   g. a summary card (or JSON with --json)
 *
 * Interactive on a terminal (prompt.ts); `--yes` takes every default, and
 * off a TTY without `--yes` the defaults are used as well. Four things are
 * never done silently: the starter packs (step b, a hundred-odd global terms),
 * the repo harvest (step c) and the login service (step e) are performed under
 * `--yes` only with an explicit `--packs` / `--harvest` / `--serve` (a harvest
 * is a write plus a trust decision, a service replaces whatever is under its
 * label), and `--dry-run` runs every detection and suggestion but
 * writes nothing, returning a `SetupPlan` of what a real run would do (the
 * MCP `setup_lexicon` tool previews with it; the plan lists the harvest
 * candidates either way so the caller can offer them). Every step is
 * idempotent: addTerm merges, the installers skip what is already there and
 * exports overwrite the same file; a person or company already in the global
 * lexicon, or a harvest candidate already covered by a global term, is
 * reported and not added again. All process spawning and filesystem probing
 * goes through `SetupDeps` so tests never touch the machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { findOnPath } from '../daemon/clipboard-backends.js';
import {
  DEFAULT_PACKS,
  EXPORT_FORMAT_INFO,
  ProjectTrustError,
  addTerm,
  exportLexicon,
  harvestRepo,
  installPack,
  installedPacks,
  listPacks,
  loadLexicon,
  loadPack,
  readLexiconFile,
  resolvePaths,
  suggestAliases,
} from '../core/index.js';
import type {
  ExportFormat,
  HarvestCandidate,
  HarvestOptions,
  InstallPackResult,
  PackInfo,
  StoreOptions,
  Term,
  TermCategory,
  TermScope,
} from '../core/index.js';
import { INSTALL_CLIENTS, configPathFor, runInstall } from './cmd-install.js';
import type { InstallClient, InstallOptions } from './cmd-install.js';
import { runServeInstall } from './cmd-serve.js';
import type { ServeDeps, ServeOptions } from './cmd-serve.js';
import { renderTable, runInit, safe, safeLines } from './commands.js';
import type { CommonOptions, IO, InstallOutcome } from './commands.js';
import { createPrompter, isInteractive, styler } from './prompt.js';
import type { Prompter } from './prompt.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Clients `setup` knows how to detect and install (everything but `generic`). */
export const SETUP_CLIENTS = INSTALL_CLIENTS.filter((c): c is Exclude<InstallClient, 'generic'> => c !== 'generic');
export type SetupClient = (typeof SETUP_CLIENTS)[number];

/** Dictation apps `setup` can export for, with the export format behind each. */
export const SETUP_APPS = ['wispr', 'superwhisper', 'macos', 'none'] as const;
export type SetupApp = (typeof SETUP_APPS)[number];

export const HARVEST_LIMIT = 10;
export const HARVEST_MIN_COUNT = 5;
/** A lexicon with at least this many terms is considered seeded already. */
export const SEEDED_TERMS = 3;

export interface SetupOptions extends CommonOptions {
  /** Take every default without prompting. */
  yes?: boolean;
  /** Print the SetupSummary as JSON on stdout (progress goes to stderr). */
  json?: boolean;
  /** Seed person/company even when the lexicon already has terms. */
  reseed?: boolean;
  /** Comma-separated client names, or `none`. Skips detection and the checklist. */
  clients?: string;
  /** Company or product name to seed (non-interactive default for the prompt). */
  company?: string;
  /** Person name to seed (default: `git config --global user.name`). */
  person?: string;
  /** Pronunciation hint for the company term. */
  phonetic?: string;
  /**
   * `--harvest` / `--no-harvest`: add the repo's top names to the project
   * lexicon. With a prompter, undefined shows the candidates and asks
   * (default yes); without one (`--yes`, no TTY, MCP) undefined skips the
   * write: a harvest is a write plus a trust decision and is never done
   * silently. A dry run lists the candidates in the plan either way.
   */
  harvest?: boolean;
  /**
   * `--serve` / `--no-serve`: install the local API login service. With a
   * prompter, undefined asks (default yes); without one (`--yes`, no TTY,
   * MCP) undefined skips it: a login service is never created silently.
   */
  serve?: boolean;
  /**
   * `--packs <list>` / `--no-packs`: starter packs to install into the global
   * lexicon (`lexicon pack add`). A comma-separated list (or `none`) installs
   * exactly those; `false` skips the step without a prompt; undefined shows the
   * checklist on a terminal (developer, ai, voice-tools checked) and installs
   * nothing without one (`--yes`, no TTY, MCP): a pack is a hundred-odd terms
   * and is never added silently. A dry run lists the defaults in
   * `wouldInstallPacks` unless `packs === false`.
   */
  packs?: string | false;
  /** Run detection and suggestions only; write nothing and fill in `SetupPlan`. */
  dryRun?: boolean;
  /** Dictation app to export for: wispr|superwhisper|macos|none. */
  app?: string;
  /** Directory for the dictation export (default ~/Desktop, else the config dir). */
  exportDir?: string;
  /** Treat <dir> as the home directory (forwarded to the installers). */
  home?: string;
}

export interface SetupClientResult {
  name: string;
  status: 'installed' | 'skipped' | 'failed';
  /**
   * For `installed`: the config file(s) the installer wrote, comma separated,
   * `(unchanged)` after one that already had the entry. For `failed`: the
   * installer's last error line.
   */
  detail?: string;
}

export interface SetupPackResult {
  name: string;
  /** Terms created by the pack. */
  added: number;
  /** Terms that already existed and only gained aliases. */
  merged: number;
}

export interface SetupSummary {
  lexiconPath: string;
  /** Seeded and harvested terms created by this run (pack terms are counted in `packs`). */
  termsAdded: string[];
  /** Starter packs installed by this run (a pack that was already installed is not listed). */
  packs: SetupPackResult[];
  clients: SetupClientResult[];
  serve: 'installed' | 'skipped' | 'failed';
  exports: { format: string; path: string }[];
}

/** What `runSetup` would do, computed by a dry run that writes nothing. */
export interface SetupPlan {
  plan: true;
  lexiconPath: string;
  /** False when the global lexicon would be created. */
  lexiconExists: boolean;
  /** Canonicals that would be seeded into the global lexicon (person, company). */
  wouldSeed: string[];
  /**
   * Starter packs that would be installed: the `--packs` list, else the
   * defaults (developer, ai, voice-tools) a terminal would show checked, so a
   * caller can offer them; empty under `--no-packs`. A non-interactive apply
   * installs only an explicit `--packs` list.
   */
  wouldInstallPacks: string[];
  /** Repo names that would be added to the project lexicon (names the packs cover are left out). */
  wouldHarvest: string[];
  /** Every client found on this machine, whether or not it would be installed. */
  detectedClients: string[];
  /** Clients that would get the MCP server (and hooks) written. */
  wouldInstallClients: string[];
  wouldInstallServe: boolean;
  wouldExport: { format: string; path: string }[];
}

/** Runs a command and returns trimmed stdout; throws when it fails. */
export type SetupExec = (file: string, args: readonly string[]) => string;

export interface SetupDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Home directory used for detection and forwarded to the installers. Default os.homedir(). */
  home?: string;
  /** Filesystem probe for detection. Default existsSync. */
  exists?: (p: string) => boolean;
  /** Runs `git config` / `git remote`. Default execFileSync with a short timeout. */
  exec?: SetupExec;
  /** Directory containing the built CLI (dist/cli), forwarded to the installers. */
  cliDir?: string;
  isInteractive?: () => boolean;
  createPrompter?: () => Prompter;
  /**
   * Installs one client with `--apply`. Default runInstall. `onWritten` is
   * called for every config file the installer touched; the summary's
   * `detail` is built from it (falling back to the installer's last line).
   */
  installClient?: (client: SetupClient, opts: InstallOptions, io: IO, onWritten: (file: string, outcome: InstallOutcome) => void) => Promise<number>;
  /**
   * Installs the local API login service. Default runServeInstall, called
   * with `deps`: platform, env, home (when overridden) and `cliPath`
   * (`<cliDir>/index.js` when `cliDir` is set; the installer resolves it
   * otherwise and refuses a path that does not exist).
   */
  installServe?: (opts: ServeOptions, io: IO, deps: ServeDeps) => Promise<number>;
  /** Repo scanner. Default harvestRepo. */
  harvest?: (root: string, opts: HarvestOptions) => Promise<HarvestCandidate[]>;
  /** The starter packs on offer. Default listPacks (the package's packs/). */
  listPacks?: () => Promise<PackInfo[]>;
  /** Installs one pack. Default installPack. */
  installPack?: (name: string, opts: StoreOptions & { scope: TermScope }) => Promise<InstallPackResult>;
}

export interface DetectedClient {
  name: SetupClient;
  detected: boolean;
  /** What was found (a directory, an app bundle or a binary), for the checklist. */
  evidence?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const { bold, dim } = styler(process.stdout);

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** An IO that collects everything, so an installer's multi-line report becomes one line here. */
function captureIO(): IO & { out: string; err: string } {
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

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function tildify(p: string, home: string): string {
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function isSetupClient(value: string): value is SetupClient {
  return (SETUP_CLIENTS as readonly string[]).includes(value);
}

function isSetupApp(value: string): value is SetupApp {
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

function findGitRoot(start: string, exists: (p: string) => boolean): string | undefined {
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
 * yields anything.
 */
export function suggestCompany(packageName: string | undefined, remoteUrl: string | undefined): string | undefined {
  const scope = packageName?.match(/^@([A-Za-z0-9][\w.-]*)\//)?.[1];
  if (scope) return scope.charAt(0).toUpperCase() + scope.slice(1);
  if (remoteUrl) {
    // https://github.com/org/repo(.git), git@github.com:org/repo.git, ssh://git@host/org/repo
    const m = remoteUrl.trim().match(/[:/]([A-Za-z0-9][\w.-]*)\/[\w.-]+?(?:\.git)?\/?$/);
    if (m && !/^(users?|orgs?)$/i.test(m[1])) return m[1];
  }
  return undefined;
}

async function readPackageName(cwd: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name?: unknown };
    return typeof pkg.name === 'string' ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

const defaultSetupExec: SetupExec = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function tryExec(exec: SetupExec, file: string, args: readonly string[]): string | undefined {
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

function configDirFor(client: SetupClient, ctx: DetectContext): string {
  if (client === 'claude') return path.join(ctx.home, '.claude');
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
    home: deps.home ?? os.homedir(),
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
        exists: async (candidate) => ctx.exists(candidate),
      });
      if (bin) evidence = bin;
    }
    out.push(evidence ? { name, detected: true, evidence } : { name, detected: false });
  }
  return out;
}

// ---------------------------------------------------------------------------
// runSetup
// ---------------------------------------------------------------------------

interface Ctx {
  opts: SetupOptions;
  deps: SetupDeps;
  /** Progress output: stdout normally, stderr under --json. */
  say: (s?: string) => void;
  warn: (s: string) => void;
  io: IO;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  exec: SetupExec;
  /** Undefined when running with defaults (--yes or no terminal). */
  prompter?: Prompter;
  /** True when --home or deps.home overrides os.homedir(); forwarded to the installers. */
  homeOverridden: boolean;
  /** The company term seeded in step 1, for the summary card. */
  company?: string;
  /** Canonicals seeded (or found already present) in step 1; the harvest skips these. */
  seeded: string[];
  /** Canonicals the packs of a dry run would add; the planned harvest leaves them out. */
  packCanonicals: string[];
  summary: SetupSummary;
  /** Present under `dryRun`: every step records what it would do here instead of doing it. */
  plan?: SetupPlan;
}

const APP_LABELS: Record<Exclude<SetupApp, 'none'>, { label: string; where: string }> = {
  wispr: { label: 'Wispr Flow', where: 'Wispr Flow > Dictionary > Import' },
  superwhisper: { label: 'Superwhisper', where: 'Superwhisper > Settings > Replacements > Import' },
  macos: { label: 'macOS Text Replacement', where: 'System Settings > Keyboard > Text Replacements (drag the file in)' },
};

function stepHeading(ctx: Ctx, n: number, title: string): void {
  ctx.say(bold(`${n}. ${title}`));
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Canonicals already in the global lexicon (case-insensitive), so a seed never duplicates one. */
async function globalCanonicals(ctx: Ctx): Promise<string[]> {
  const global = resolvePaths({ cwd: ctx.cwd }).global;
  if (!ctx.exists(global)) return [];
  try {
    return (await readLexiconFile(global, 'global')).lexicon.terms.map((t) => t.canonical);
  } catch {
    return [];
  }
}

/**
 * Adds one term to the global lexicon unless a term with that canonical is
 * already there (case-insensitive): then nothing is written and the existing
 * spelling is reported, so `--person` equal to `git config user.name`, or a
 * company the user already added, never shows up twice.
 */
async function seedTerm(ctx: Ctx, term: Term): Promise<void> {
  const existing = (await globalCanonicals(ctx)).find((c) => sameName(c, term.canonical));
  if (existing !== undefined) {
    ctx.say(dim(`   already present: ${safe(existing)} (${term.category ?? 'other'})`));
    ctx.seeded.push(existing);
    return;
  }
  const result = await addTerm(term, { scope: 'global', cwd: ctx.cwd });
  const aliases = result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(no aliases)');
  ctx.say(`   ${result.created ? 'added' : 'merged'} ${bold(safe(result.term.canonical))} (${term.category ?? 'other'}): ${aliases}`);
  ctx.seeded.push(result.term.canonical);
  if (result.created) ctx.summary.termsAdded.push(result.term.canonical);
}

/** Step a: the global lexicon and the person/company seed. */
async function stepLexicon(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 1, 'Global lexicon');
  const global = resolvePaths({ cwd: ctx.cwd }).global;
  ctx.summary.lexiconPath = global;
  if (ctx.plan) ctx.plan.lexiconPath = global;
  const existed = ctx.exists(global);
  if (existed) {
    ctx.say(`   exists: ${safe(tildify(global, ctx.home))}`);
  } else if (ctx.plan) {
    ctx.say(`   would create ${safe(tildify(global, ctx.home))}`);
  } else {
    const captured = captureIO();
    await runInit({ cwd: ctx.cwd }, captured);
    ctx.say(`   created ${safe(tildify(global, ctx.home))}`);
  }
  if (ctx.plan) ctx.plan.lexiconExists = existed;

  const before = existed ? (await readLexiconFile(global, 'global')).lexicon.terms.length : 0;
  if (before >= SEEDED_TERMS && !ctx.opts.reseed) {
    ctx.say(dim(`   already has ${before} terms; skipping the seed (use --reseed to add more)`));
    return;
  }
  if (ctx.plan) {
    // Same defaults as the non-interactive path below, without the writes.
    const person = ctx.opts.person ?? tryExec(ctx.exec, 'git', ['config', '--global', 'user.name']);
    const company =
      ctx.opts.company ??
      suggestCompany(await readPackageName(ctx.cwd), tryExec(ctx.exec, 'git', ['-C', ctx.cwd, 'remote', 'get-url', 'origin']));
    const present = await globalCanonicals(ctx);
    for (const [canonical, category] of [
      [person, 'person'],
      [company, 'brand'],
    ] as const) {
      if (!canonical) continue;
      const already = present.find((c) => sameName(c, canonical));
      if (already !== undefined || ctx.plan.wouldSeed.some((c) => sameName(c, canonical))) {
        ctx.say(dim(`   already present: ${safe(already ?? canonical)} (${category})`));
        continue;
      }
      ctx.plan.wouldSeed.push(canonical);
      const aliases = suggestAliases(canonical);
      ctx.say(`   would add ${bold(safe(canonical))} (${category}): ${aliases.length > 0 ? safe(aliases.join(', ')) : dim('(no aliases)')}`);
    }
    if (ctx.plan.wouldSeed.length === 0) ctx.say(dim('   nothing to seed (no git user.name, no company guess)'));
    return;
  }

  // Person: the git user, confirmed on a terminal.
  const gitName = ctx.opts.person ?? tryExec(ctx.exec, 'git', ['config', '--global', 'user.name']);
  let person = gitName;
  if (ctx.prompter && gitName && !ctx.opts.person) {
    person = (await ctx.prompter.confirm(`   add "${safe(gitName)}" as a person term (how you want your name spelled)?`, true))
      ? gitName
      : undefined;
  }
  if (person) {
    await seedTerm(ctx, { canonical: person, aliases: suggestAliases(person), category: 'person', source: 'user' });
  } else {
    ctx.say(dim('   no person term (git user.name is unset; add one later: lexicon add "Your Name" --category person)'));
  }

  // Company: suggested from the package scope or the git remote.
  const suggestion =
    ctx.opts.company ??
    suggestCompany(await readPackageName(ctx.cwd), tryExec(ctx.exec, 'git', ['-C', ctx.cwd, 'remote', 'get-url', 'origin']));
  let company: string | undefined = ctx.opts.company ?? (ctx.prompter ? undefined : suggestion);
  let phonetic: string | undefined = ctx.opts.phonetic;
  if (ctx.prompter && !ctx.opts.company) {
    company = (
      await ctx.prompter.ask('   Your company or product name (as you want it spelled; Enter to skip)', {
        default: suggestion ?? '',
      })
    ).trim();
  }
  if (!company) {
    ctx.say(dim('   no company term (add one later: lexicon add "Your Co" --category brand)'));
    return;
  }
  const aliases = suggestAliases(company);
  if (ctx.prompter) {
    if (aliases.length > 0) ctx.say(dim(`   STT will likely write: ${safe(aliases.join(', '))}`));
    if (!phonetic) {
      phonetic = (await ctx.prompter.ask('   phonetic hint (e.g. ASH-ler, Enter for none)', { default: '' })).trim() || undefined;
    }
  }
  const term: Term = { canonical: company, aliases, category: 'brand', source: 'user' };
  if (phonetic) term.phonetic = phonetic;
  await seedTerm(ctx, term);
  ctx.company = company;

  // More terms, one at a time, on a terminal only.
  while (ctx.prompter && (await ctx.prompter.confirm('   add another term?', false))) {
    const name = (await ctx.prompter.ask('   name (as you want it spelled; Enter to stop)', { default: '' })).trim();
    if (!name) break;
    const hint = (await ctx.prompter.ask('   phonetic hint (Enter for none)', { default: '' })).trim();
    const categoryAnswer = (await ctx.prompter.ask('   category (brand|person|product|acronym|identifier|place|other)', { default: 'brand' }))
      .trim()
      .toLowerCase();
    const category = (['brand', 'person', 'product', 'acronym', 'identifier', 'place', 'other'] as TermCategory[]).find(
      (c) => c === categoryAnswer,
    );
    const extra: Term = { canonical: name, aliases: suggestAliases(name), category: category ?? 'other', source: 'user' };
    if (hint) extra.phonetic = hint;
    await seedTerm(ctx, extra);
  }
}

/**
 * Step b: the starter packs. On a terminal a checklist of the default packs
 * (all checked) followed by one yes/no per remaining pack (default no); with
 * `--packs` exactly that list; otherwise nothing, since a pack is a
 * hundred-odd terms. A pack the file already lists is reported, not re-added.
 */
async function stepPacks(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 2, 'Starter packs');
  if (ctx.opts.packs === false) {
    ctx.say(dim('   skipped (--no-packs)'));
    return;
  }
  let available: PackInfo[];
  try {
    available = await (ctx.deps.listPacks ?? listPacks)();
  } catch (err) {
    ctx.warn(`   could not read the packs: ${safeLines(errorMessage(err))}`);
    return;
  }
  if (available.length === 0) {
    ctx.say(dim('   no packs shipped with this install'));
    return;
  }
  const byName = new Map(available.map((p) => [p.name, p]));
  const describe = (name: string): string => {
    const p = byName.get(name);
    return p ? `${name} ${dim(`(${p.terms} terms)`)}` : name;
  };
  const explicit = typeof ctx.opts.packs === 'string' ? parsePackList(ctx.opts.packs, available.map((p) => p.name)) : undefined;
  const defaults = DEFAULT_PACKS.filter((name) => byName.has(name));

  if (ctx.plan) {
    const chosen = explicit ?? [...defaults];
    ctx.plan.wouldInstallPacks = chosen;
    if (chosen.length === 0) {
      ctx.say(dim('   would install: none'));
      return;
    }
    ctx.say(`   would install: ${chosen.map(describe).join(', ')}`);
    if (explicit === undefined) ctx.say(dim('   (the defaults; pass --packs <list> to install them without a terminal)'));
    for (const name of chosen) {
      try {
        ctx.packCanonicals.push(...(await loadPack(name)).lexicon.terms.map((t) => t.canonical));
      } catch {
        // the harvest preview just loses the overlap check
      }
    }
    return;
  }

  let chosen: string[];
  if (explicit !== undefined) {
    chosen = explicit;
    if (chosen.length === 0) {
      ctx.say(dim('   skipped (--packs none)'));
      return;
    }
  } else if (ctx.prompter) {
    chosen = await ctx.prompter.choose(
      '   add starter packs to the global lexicon (Enter keeps the checked ones):',
      defaults.map((name) => ({ label: `${name}  ${dim(safe(`${byName.get(name)?.title ?? ''}, ${byName.get(name)?.terms ?? 0} terms`))}`, value: name })),
      { multi: true },
    );
    for (const p of available) {
      if (defaults.includes(p.name)) continue;
      if (await ctx.prompter.confirm(`   also add ${safe(p.name)} (${safe(p.title)}, ${p.terms} terms)?`, false)) chosen.push(p.name);
    }
    if (chosen.length === 0) {
      ctx.say(dim('   skipped; later: lexicon pack add developer'));
      return;
    }
  } else {
    ctx.say(dim(`   skipped (not requested); add --packs ${defaults.join(',')} to install the defaults, or later: lexicon pack add <name>`));
    return;
  }

  const installed = installedPacks(await loadLexicon({ cwd: ctx.cwd }));
  const install = ctx.deps.installPack ?? installPack;
  for (const name of chosen) {
    if (installed.includes(name)) {
      ctx.say(dim(`   already installed: ${name}`));
      continue;
    }
    const result = await install(name, { cwd: ctx.cwd, scope: 'global' });
    ctx.summary.packs.push({ name, added: result.added, merged: result.merged });
    ctx.say(`   installed ${bold(name)}: ${result.added} added, ${result.merged} merged`);
  }
}

/** Step c: harvest the repo into the project lexicon. */
async function stepHarvest(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 3, 'Repo harvest');
  if (ctx.opts.harvest === false) {
    ctx.say(dim('   skipped (--no-harvest)'));
    return;
  }
  const root = findGitRoot(ctx.cwd, ctx.exists);
  if (!root) {
    ctx.say(dim('   not a git repository; run `lexicon harvest --add` inside one later'));
    return;
  }
  if (!ctx.plan && !ctx.prompter && ctx.opts.harvest !== true) {
    // No terminal to show the candidates on: a project write is only made when asked for explicitly.
    ctx.say(dim('   skipped (not requested); add --harvest to add repo names, or later: lexicon harvest --add'));
    return;
  }
  const harvest = ctx.deps.harvest ?? harvestRepo;
  let candidates: HarvestCandidate[];
  try {
    candidates = await harvest(root, { limit: HARVEST_LIMIT, minCount: HARVEST_MIN_COUNT });
  } catch (err) {
    ctx.warn(`   harvest failed: ${safeLines(errorMessage(err))}`);
    return;
  }
  // A name the global lexicon already covers (the git author seeded as the person term,
  // the company) would only show up as a duplicate in `lexicon doctor`.
  const covered = [...(await globalCanonicals(ctx)), ...ctx.seeded, ...(ctx.plan?.wouldSeed ?? []), ...ctx.packCanonicals];
  const skipped = candidates.filter((c) => covered.some((name) => sameName(name, c.canonical)));
  candidates = candidates.filter((c) => !skipped.includes(c));
  if (skipped.length > 0) ctx.say(dim(`   already in the global lexicon: ${safe(skipped.map((c) => c.canonical).join(', '))}`));
  if (candidates.length === 0) {
    ctx.say(dim(`   nothing worth adding in ${safe(tildify(root, ctx.home))}`));
    return;
  }
  if (ctx.plan) {
    ctx.plan.wouldHarvest = candidates.map((c) => c.canonical);
    ctx.say(
      `   would add ${candidates.length} name${candidates.length === 1 ? '' : 's'} to ${safe(path.join(tildify(root, ctx.home), '.lexicon.yaml'))}: ${safe(ctx.plan.wouldHarvest.join(', '))}`,
    );
    return;
  }
  if (ctx.prompter) {
    ctx.say(`   found ${candidates.length} names in ${safe(tildify(root, ctx.home))}:`);
    const rows = candidates.map((c) => [c.canonical, c.category, String(c.count), c.suggestedAliases.slice(0, 3).join(', ')]);
    ctx.say(renderTable(rows, ['canonical', 'category', 'count', 'suggested aliases']).replace(/\n$/, ''));
    if (!(await ctx.prompter.confirm(`   add them to the project lexicon (${safe(path.join(tildify(root, ctx.home), '.lexicon.yaml'))})?`, true))) {
      ctx.say(dim('   skipped; pick them one by one later with: lexicon harvest --add'));
      return;
    }
  }
  let created = 0;
  let merged = 0;
  let file: string | undefined;
  try {
    for (const c of candidates) {
      const term: Term = { canonical: c.canonical, aliases: c.suggestedAliases, category: c.category, source: c.source };
      const result = await addTerm(term, { scope: 'project', cwd: root });
      file = result.file.path;
      if (result.created) {
        created += 1;
        ctx.summary.termsAdded.push(result.term.canonical);
      } else merged += 1;
    }
  } catch (err) {
    if (err instanceof ProjectTrustError) {
      ctx.warn(`   skipped: ${safeLines(err.message)}`);
      return;
    }
    throw err;
  }
  ctx.say(`   added ${created} new term${created === 1 ? '' : 's'}, merged ${merged} in ${safe(tildify(file ?? root, ctx.home))} (trusted)`);
}

/** Step d: detect and install the agent clients. */
async function stepClients(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 4, 'Agent clients');
  if (ctx.plan) {
    // Always detect for the plan (it is what the caller needs to ask the user), even under --clients none.
    const detected = (await detectClients({ ...ctx.deps, home: ctx.home }, ctx.cwd)).filter((c) => c.detected);
    ctx.plan.detectedClients = detected.map((c) => c.name);
    ctx.say(
      detected.length > 0
        ? `   detected: ${detected.map((c) => `${c.name} ${dim(safe(tildify(c.evidence ?? '', ctx.home)))}`).join(', ')}`
        : dim('   none detected'),
    );
    const chosen = ctx.opts.clients !== undefined ? parseClientList(ctx.opts.clients) : detected.map((c) => c.name);
    ctx.plan.wouldInstallClients = chosen;
    ctx.say(chosen.length > 0 ? `   would install into: ${chosen.join(', ')}` : dim('   would install into: none'));
    return;
  }
  let chosen: SetupClient[];
  if (ctx.opts.clients !== undefined) {
    chosen = parseClientList(ctx.opts.clients);
    if (chosen.length === 0) {
      ctx.say(dim('   skipped (--clients none)'));
      return;
    }
  } else {
    const detected = (await detectClients({ ...ctx.deps, home: ctx.home }, ctx.cwd)).filter((c) => c.detected);
    if (detected.length === 0) {
      ctx.say(dim(`   none detected; later: lexicon install <${SETUP_CLIENTS.join('|')}> --apply`));
      return;
    }
    if (ctx.prompter) {
      chosen = await ctx.prompter.choose(
        '   install the lexicon MCP server (and hooks) into:',
        detected.map((c) => ({ label: `${c.name}  ${dim(safe(tildify(c.evidence ?? '', ctx.home)))}`, value: c.name })),
        { multi: true },
      );
      if (chosen.length === 0) {
        ctx.say(dim('   skipped'));
        return;
      }
    } else {
      chosen = detected.map((c) => c.name);
    }
  }

  const install =
    ctx.deps.installClient ??
    ((client: SetupClient, opts: InstallOptions, io: IO, onWritten: (file: string, outcome: InstallOutcome) => void) =>
      runInstall(client, opts, io, {
        platform: ctx.platform,
        env: ctx.env,
        onWritten,
        ...(ctx.deps.cliDir ? { cliDir: ctx.deps.cliDir } : {}),
      }));
  for (const client of chosen) {
    const captured = captureIO();
    const opts: InstallOptions = { apply: true, cwd: ctx.cwd, ...(ctx.homeOverridden ? { home: ctx.home } : {}) };
    const written: string[] = [];
    const onWritten = (file: string, outcome: InstallOutcome): void => {
      written.push(outcome === 'unchanged' ? `${tildify(file, ctx.home)} (unchanged)` : tildify(file, ctx.home));
    };
    let code: number;
    let detail: string;
    try {
      code = await install(client, opts, captured, onWritten);
      detail = written.length > 0 ? written.join(', ') : lastLine(captured.out) || lastLine(captured.err);
    } catch (err) {
      code = 1;
      detail = errorMessage(err);
    }
    if (code === 0) {
      ctx.summary.clients.push({ name: client, status: 'installed', detail });
      ctx.say(`   ${client}: installed ${dim(safe(detail))}`);
    } else {
      const failure = lastLine(captured.err) || detail || `exit ${code}`;
      ctx.summary.clients.push({ name: client, status: 'failed', detail: failure });
      ctx.warn(`   ${client}: failed ${safe(failure)}`);
      ctx.warn(`   (retry with: lexicon install ${client} --apply)`);
    }
  }
}

/** Step e: the local API as a login service. */
async function stepServe(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 5, 'Local API (lexicon serve)');
  if (ctx.opts.serve === false) {
    ctx.say(dim('   skipped (--no-serve)'));
    return;
  }
  const supported = ctx.platform === 'darwin' || ctx.platform === 'linux';
  if (!supported) {
    ctx.say(dim(`   not automated on ${ctx.platform}; see: lexicon serve --install`));
    return;
  }
  if (ctx.prompter && ctx.opts.serve !== true) {
    const ok = await ctx.prompter.confirm(
      '   install the local API (browser extension, Claude Desktop, menu bar app) as a login service?',
      true,
    );
    if (!ok) {
      ctx.say(dim('   skipped; later: lexicon serve --install'));
      return;
    }
  } else if (ctx.opts.serve !== true) {
    // No terminal to ask on: a login service is only created when asked for explicitly.
    ctx.say(dim('   skipped (not requested); add --serve to install it, or later: lexicon serve --install'));
    return;
  }
  if (ctx.plan) {
    ctx.plan.wouldInstallServe = true;
    ctx.say('   would install the login service (lexicon serve --install)');
    return;
  }
  const install = ctx.deps.installServe ?? runServeInstall;
  const serveDeps: ServeDeps = { platform: ctx.platform, env: ctx.env };
  if (ctx.homeOverridden) serveDeps.home = ctx.home;
  // The MCP server passes the package's dist/cli (the bundle runs from plugin/, where
  // "next to this module" would be plugin/index.js); runServeInstall resolves the path
  // otherwise and refuses one that does not exist, so a broken plist is never written.
  if (ctx.deps.cliDir) serveDeps.cliPath = path.join(ctx.deps.cliDir, 'index.js');
  const captured = captureIO();
  let code: number;
  try {
    code = await install({ cwd: ctx.cwd }, captured, serveDeps);
  } catch (err) {
    code = 1;
    captured.err += `${errorMessage(err)}\n`;
  }
  if (code === 0) {
    ctx.summary.serve = 'installed';
    ctx.say(`   installed ${dim(safe(lastLine(captured.out)))}`);
  } else {
    ctx.summary.serve = 'failed';
    ctx.warn(`   failed ${safe(lastLine(captured.err) || lastLine(captured.out))}`);
    ctx.warn('   (retry with: lexicon serve --install)');
  }
}

/** Step f: export for the dictation app. */
async function stepExport(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 6, 'Dictation app');
  let app: SetupApp | undefined;
  if (ctx.opts.app !== undefined) {
    const value = ctx.opts.app.trim().toLowerCase();
    if (!isSetupApp(value)) throw new Error(`unknown app "${ctx.opts.app}" (expected one of: ${SETUP_APPS.join(', ')})`);
    app = value;
  } else if (ctx.prompter) {
    const choices = [
      ...(Object.keys(APP_LABELS) as Exclude<SetupApp, 'none'>[]).map((k) => ({ label: APP_LABELS[k].label, value: k as SetupApp })),
      { label: 'none / something else', value: 'none' as SetupApp },
    ];
    [app] = await ctx.prompter.choose('   which dictation app do you use?', choices);
  } else {
    app = 'none';
  }
  if (!app || app === 'none') {
    ctx.say(dim('   skipped; later: lexicon export wispr|superwhisper|macos --out <file>'));
    return;
  }
  const format: ExportFormat = app;
  const desktop = path.join(ctx.home, 'Desktop');
  const dir = ctx.opts.exportDir ?? (ctx.exists(desktop) ? desktop : path.dirname(ctx.summary.lexiconPath));
  const file = path.join(dir, `lexicon-${format}.${EXPORT_FORMAT_INFO[format].ext}`);
  if (ctx.plan) {
    ctx.plan.wouldExport.push({ format, path: file });
    ctx.say(`   would write ${safe(tildify(file, ctx.home))} for ${APP_LABELS[app].label}`);
    return;
  }
  const loaded = await loadLexicon({ cwd: ctx.cwd });
  const text = exportLexicon(loaded.merged, format);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  ctx.summary.exports.push({ format, path: file });
  ctx.say(`   wrote ${safe(tildify(file, ctx.home))} (${loaded.merged.terms.length} terms)`);
  ctx.say(`   import it in ${APP_LABELS[app].where}`);
}

/** Step g (dry run): the plan card. */
function printPlan(ctx: Ctx, p: SetupPlan): void {
  ctx.say();
  ctx.say(bold('Plan (nothing written).'));
  ctx.say(`   lexicon: ${safe(tildify(p.lexiconPath, ctx.home))}${p.lexiconExists ? '' : dim(' (would be created)')}`);
  ctx.say(`   would seed: ${p.wouldSeed.length > 0 ? safe(p.wouldSeed.join(', ')) : dim('nothing')}`);
  ctx.say(`   would install packs: ${p.wouldInstallPacks.length > 0 ? p.wouldInstallPacks.join(', ') : dim('none')}`);
  ctx.say(`   would harvest: ${p.wouldHarvest.length > 0 ? safe(p.wouldHarvest.join(', ')) : dim('nothing')}`);
  ctx.say(`   detected clients: ${p.detectedClients.length > 0 ? p.detectedClients.join(', ') : dim('none')}`);
  ctx.say(`   would install into: ${p.wouldInstallClients.length > 0 ? p.wouldInstallClients.join(', ') : dim('none')}`);
  ctx.say(`   login service: ${p.wouldInstallServe ? 'would install' : dim('skipped')}`);
  ctx.say(`   would export: ${p.wouldExport.length > 0 ? safe(p.wouldExport.map((e) => tildify(e.path, ctx.home)).join(', ')) : dim('nothing')}`);
  ctx.say();
  ctx.say(dim('   run again without --dry-run to apply.'));
}

/** Step g: the summary card. */
function printSummary(ctx: Ctx): void {
  const s = ctx.summary;
  ctx.say();
  ctx.say(bold('Done.'));
  ctx.say(`   lexicon: ${safe(tildify(s.lexiconPath, ctx.home))}`);
  ctx.say(`   terms added: ${s.termsAdded.length > 0 ? safe(s.termsAdded.join(', ')) : dim('none')}`);
  ctx.say(`   packs: ${s.packs.length > 0 ? s.packs.map((p) => `${p.name} (${p.added} added)`).join(', ') : dim('none')}`);
  const installed = s.clients.filter((c) => c.status === 'installed').map((c) => c.name);
  const failed = s.clients.filter((c) => c.status === 'failed').map((c) => c.name);
  ctx.say(
    `   clients: ${installed.length > 0 ? installed.join(', ') : dim('none')}${failed.length > 0 ? ` (failed: ${failed.join(', ')})` : ''}`,
  );
  ctx.say(`   local API: ${s.serve}`);
  ctx.say(`   exports: ${s.exports.length > 0 ? safe(s.exports.map((e) => tildify(e.path, ctx.home)).join(', ')) : dim('none')}`);
  ctx.say();
  ctx.say(bold('Next:'));
  const company = ctx.company;
  ctx.say(`   1. Open Claude Code and dictate a sentence${company ? ` with "${safe(company)}" in it` : ''}; the hook fixes it before Claude reads it.`);
  ctx.say('   2. After a week: lexicon suggest (finds names you keep correcting) and lexicon stats.');
  ctx.say('   3. Local push-to-talk: lexicon voice --list-devices, then lexicon voice --copy.');
}

/**
 * The testable handler behind `lexicon setup`. Returns the exit code and the
 * summary (also printed as JSON under `opts.json`). Exit 1 when any client
 * or the serve install failed; the steps still all run. Under `opts.dryRun`
 * nothing is written, the summary stays empty and `plan` says what a real
 * run with the same options would do (printed as the JSON under `--json`).
 */
export async function runSetup(
  opts: SetupOptions,
  io: IO,
  deps: SetupDeps = {},
): Promise<{ code: number; summary: SetupSummary; plan?: SetupPlan }> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const home = opts.home ? path.resolve(opts.home) : (deps.home ?? os.homedir());
  // Validate the flags before any step writes anything.
  if (opts.clients !== undefined) parseClientList(opts.clients);
  if (opts.app !== undefined && !isSetupApp(opts.app.trim().toLowerCase())) {
    throw new Error(`unknown app "${opts.app}" (expected one of: ${SETUP_APPS.join(', ')})`);
  }
  if (typeof opts.packs === 'string') parsePackList(opts.packs, (await (deps.listPacks ?? listPacks)()).map((p) => p.name));
  // A dry run never prompts: it reports the non-interactive defaults.
  const interactive = !opts.yes && !opts.json && !opts.dryRun && (deps.isInteractive ?? isInteractive)();
  const ownPrompter = interactive && !deps.createPrompter;
  const prompter = interactive
    ? (deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout })))()
    : undefined;

  const say = (s = ''): void => {
    if (opts.json) io.stderr(`${s}\n`);
    else io.stdout(`${s}\n`);
  };
  const ctx: Ctx = {
    opts,
    deps,
    say,
    homeOverridden: Boolean(opts.home || deps.home),
    warn: (s) => io.stderr(`${s}\n`),
    io,
    cwd,
    home,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    exists: deps.exists ?? existsSync,
    exec: deps.exec ?? defaultSetupExec,
    seeded: [],
    packCanonicals: [],
    summary: { lexiconPath: '', termsAdded: [], packs: [], clients: [], serve: 'skipped', exports: [] },
  };
  if (prompter) ctx.prompter = prompter;
  if (opts.dryRun) {
    ctx.plan = {
      plan: true,
      lexiconPath: '',
      lexiconExists: false,
      wouldSeed: [],
      wouldInstallPacks: [],
      wouldHarvest: [],
      detectedClients: [],
      wouldInstallClients: [],
      wouldInstallServe: false,
      wouldExport: [],
    };
  }

  say(bold(opts.dryRun ? 'lexicon setup (dry run)' : 'lexicon setup'));
  if (!interactive && !opts.yes && !opts.json && !opts.dryRun) say(dim('(no terminal: taking the defaults, as with --yes)'));
  say();
  try {
    await stepLexicon(ctx);
    say();
    await stepPacks(ctx);
    say();
    await stepHarvest(ctx);
    say();
    await stepClients(ctx);
    say();
    await stepServe(ctx);
    say();
    await stepExport(ctx);
    if (ctx.plan) printPlan(ctx, ctx.plan);
    else printSummary(ctx);
  } finally {
    if (ownPrompter) prompter?.close();
  }
  if (opts.json) io.stdout(`${JSON.stringify(ctx.plan ?? ctx.summary, null, 2)}\n`);
  const failed = ctx.summary.serve === 'failed' || ctx.summary.clients.some((c) => c.status === 'failed');
  return { code: failed ? 1 : 0, summary: ctx.summary, ...(ctx.plan ? { plan: ctx.plan } : {}) };
}

export function registerSetupCommands(program: Command, io: IO): void {
  program
    .command('setup')
    .description('guided first-run: seed the lexicon, harvest the repo, install into your agents and dictation app')
    .option('-y, --yes', 'take every default without prompting')
    .option('--clients <list>', `comma-separated clients to install into, or none (default: detect; one of ${SETUP_CLIENTS.join(', ')})`)
    .option('--company <name>', 'company or product name to seed (as you want it spelled)')
    .option('--person <name>', 'your name to seed (default: git config --global user.name)')
    .option('--phonetic <hint>', 'pronunciation hint for the company term, e.g. ASH-ler')
    .option('--app <app>', `dictation app to export for: ${SETUP_APPS.join('|')}`)
    .option('--export-dir <dir>', 'where to write the dictation export (default: ~/Desktop)')
    .option('--harvest', 'add the repo names to the project lexicon (with --yes it is skipped unless this is passed)')
    .option('--packs <list>', 'comma-separated starter packs to install, or none (default: a checklist on a terminal, nothing with --yes; one of developer, ai, business, voice-tools)')
    .option('--no-packs', 'skip the starter packs (no prompt)')
    .option('--no-harvest', 'skip the repo harvest (no prompt)')
    .option('--serve', 'install the local API login service (with --yes it is skipped unless this is passed)')
    .option('--no-serve', 'skip installing the local API login service (no prompt)')
    .option('--dry-run', 'detect and suggest only; write nothing and print what a run would do')
    .option('--reseed', 'seed person/company terms even if the lexicon already has terms')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print a machine-readable summary on stdout (progress goes to stderr)')
    .action(async (opts: SetupOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const merged: SetupOptions = cwd ? { ...opts, cwd } : opts;
      const { code } = await runSetup(merged, io);
      if (code !== 0) process.exitCode = code;
    });
}
