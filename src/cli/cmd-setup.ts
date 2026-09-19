/**
 * `lexicon setup`: the one command a new user runs. Walks through six steps,
 * each printing a one-line result, and never re-implements an installer:
 *
 *   a. global lexicon (runInit) seeded with the git user as a person term and
 *      the company/product name (suggested from the cwd package scope or the
 *      git remote org) with suggested aliases and an optional phonetic hint
 *   b. repo harvest into the project lexicon (top 10, min-count 5)
 *   c. agent clients detected on this machine, installed via runInstall
 *   d. the local API as a login service via runServeInstall
 *   e. an export for the user's dictation app, written to ~/Desktop
 *   f. a summary card (or JSON with --json)
 *
 * Interactive on a terminal (prompt.ts); `--yes` takes every default, and
 * off a TTY without `--yes` the defaults are used as well. Every step is
 * idempotent: addTerm merges, the installers skip what is already there and
 * exports overwrite the same file. All process spawning and filesystem
 * probing goes through `SetupDeps` so tests never touch the machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { findOnPath } from '../daemon/clipboard-backends.js';
import {
  EXPORT_FORMAT_INFO,
  ProjectTrustError,
  addTerm,
  exportLexicon,
  harvestRepo,
  loadLexicon,
  readLexiconFile,
  resolvePaths,
  suggestAliases,
} from '../core/index.js';
import type { ExportFormat, HarvestCandidate, HarvestOptions, Term, TermCategory } from '../core/index.js';
import { INSTALL_CLIENTS, configPathFor, runInstall } from './cmd-install.js';
import type { InstallClient, InstallOptions } from './cmd-install.js';
import { runServeInstall } from './cmd-serve.js';
import type { ServeDeps, ServeOptions } from './cmd-serve.js';
import { renderTable, runInit, safe, safeLines } from './commands.js';
import type { CommonOptions, IO } from './commands.js';
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
  /** `--no-harvest`: skip the repo harvest. */
  harvest?: boolean;
  /** `--no-serve`: skip the local API login service. */
  serve?: boolean;
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
  detail?: string;
}

export interface SetupSummary {
  lexiconPath: string;
  termsAdded: string[];
  clients: SetupClientResult[];
  serve: 'installed' | 'skipped' | 'failed';
  exports: { format: string; path: string }[];
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
  /** Installs one client with `--apply`. Default runInstall. */
  installClient?: (client: SetupClient, opts: InstallOptions, io: IO) => Promise<number>;
  /** Installs the local API login service. Default runServeInstall. */
  installServe?: (opts: ServeOptions, io: IO) => Promise<number>;
  /** Repo scanner. Default harvestRepo. */
  harvest?: (root: string, opts: HarvestOptions) => Promise<HarvestCandidate[]>;
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
  summary: SetupSummary;
}

const APP_LABELS: Record<Exclude<SetupApp, 'none'>, { label: string; where: string }> = {
  wispr: { label: 'Wispr Flow', where: 'Wispr Flow > Dictionary > Import' },
  superwhisper: { label: 'Superwhisper', where: 'Superwhisper > Settings > Replacements > Import' },
  macos: { label: 'macOS Text Replacement', where: 'System Settings > Keyboard > Text Replacements (drag the file in)' },
};

function stepHeading(ctx: Ctx, n: number, title: string): void {
  ctx.say(bold(`${n}. ${title}`));
}

async function seedTerm(ctx: Ctx, term: Term): Promise<void> {
  const result = await addTerm(term, { scope: 'global', cwd: ctx.cwd });
  const aliases = result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : dim('(no aliases)');
  ctx.say(`   ${result.created ? 'added' : 'merged'} ${bold(safe(result.term.canonical))} (${term.category ?? 'other'}): ${aliases}`);
  if (result.created) ctx.summary.termsAdded.push(result.term.canonical);
}

/** Step a: the global lexicon and the person/company seed. */
async function stepLexicon(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 1, 'Global lexicon');
  const global = resolvePaths({ cwd: ctx.cwd }).global;
  ctx.summary.lexiconPath = global;
  if (ctx.exists(global)) {
    ctx.say(`   exists: ${safe(tildify(global, ctx.home))}`);
  } else {
    const captured = captureIO();
    await runInit({ cwd: ctx.cwd }, captured);
    ctx.say(`   created ${safe(tildify(global, ctx.home))}`);
  }

  const before = (await readLexiconFile(global, 'global')).lexicon.terms.length;
  if (before >= SEEDED_TERMS && !ctx.opts.reseed) {
    ctx.say(dim(`   already has ${before} terms; skipping the seed (use --reseed to add more)`));
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

/** Step b: harvest the repo into the project lexicon. */
async function stepHarvest(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 2, 'Repo harvest');
  if (ctx.opts.harvest === false) {
    ctx.say(dim('   skipped (--no-harvest)'));
    return;
  }
  const root = findGitRoot(ctx.cwd, ctx.exists);
  if (!root) {
    ctx.say(dim('   not a git repository; run `lexicon harvest --add` inside one later'));
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
  if (candidates.length === 0) {
    ctx.say(dim(`   nothing worth adding in ${safe(tildify(root, ctx.home))}`));
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

/** Step c: detect and install the agent clients. */
async function stepClients(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 3, 'Agent clients');
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
    ((client: SetupClient, opts: InstallOptions, io: IO) =>
      runInstall(client, opts, io, {
        platform: ctx.platform,
        env: ctx.env,
        ...(ctx.deps.cliDir ? { cliDir: ctx.deps.cliDir } : {}),
      }));
  for (const client of chosen) {
    const captured = captureIO();
    const opts: InstallOptions = { apply: true, cwd: ctx.cwd, ...(ctx.homeOverridden ? { home: ctx.home } : {}) };
    let code: number;
    let detail: string;
    try {
      code = await install(client, opts, captured);
      detail = lastLine(captured.out) || lastLine(captured.err);
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

/** Step d: the local API as a login service. */
async function stepServe(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 4, 'Local API (lexicon serve)');
  if (ctx.opts.serve === false) {
    ctx.say(dim('   skipped (--no-serve)'));
    return;
  }
  const supported = ctx.platform === 'darwin' || ctx.platform === 'linux';
  if (!supported) {
    ctx.say(dim(`   not automated on ${ctx.platform}; see: lexicon serve --install`));
    return;
  }
  if (ctx.prompter) {
    const ok = await ctx.prompter.confirm(
      '   install the local API (browser extension, Claude Desktop, menu bar app) as a login service?',
      true,
    );
    if (!ok) {
      ctx.say(dim('   skipped; later: lexicon serve --install'));
      return;
    }
  }
  const install =
    ctx.deps.installServe ??
    ((opts: ServeOptions, io: IO) => {
      const serveDeps: ServeDeps = { platform: ctx.platform, env: ctx.env };
      if (ctx.homeOverridden) serveDeps.home = ctx.home;
      return runServeInstall(opts, io, serveDeps);
    });
  const captured = captureIO();
  let code: number;
  try {
    code = await install({ cwd: ctx.cwd }, captured);
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

/** Step e: export for the dictation app. */
async function stepExport(ctx: Ctx): Promise<void> {
  stepHeading(ctx, 5, 'Dictation app');
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
  const loaded = await loadLexicon({ cwd: ctx.cwd });
  const text = exportLexicon(loaded.merged, format);
  const desktop = path.join(ctx.home, 'Desktop');
  const dir = ctx.opts.exportDir ?? (ctx.exists(desktop) ? desktop : path.dirname(ctx.summary.lexiconPath));
  const file = path.join(dir, `lexicon-${format}.${EXPORT_FORMAT_INFO[format].ext}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  ctx.summary.exports.push({ format, path: file });
  ctx.say(`   wrote ${safe(tildify(file, ctx.home))} (${loaded.merged.terms.length} terms)`);
  ctx.say(`   import it in ${APP_LABELS[app].where}`);
}

/** Step f: the summary card. */
function printSummary(ctx: Ctx): void {
  const s = ctx.summary;
  ctx.say();
  ctx.say(bold('Done.'));
  ctx.say(`   lexicon: ${safe(tildify(s.lexiconPath, ctx.home))}`);
  ctx.say(`   terms added: ${s.termsAdded.length > 0 ? safe(s.termsAdded.join(', ')) : dim('none')}`);
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
 * or the serve install failed; the steps still all run.
 */
export async function runSetup(
  opts: SetupOptions,
  io: IO,
  deps: SetupDeps = {},
): Promise<{ code: number; summary: SetupSummary }> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const home = opts.home ? path.resolve(opts.home) : (deps.home ?? os.homedir());
  // Validate the flags before any step writes anything.
  if (opts.clients !== undefined) parseClientList(opts.clients);
  if (opts.app !== undefined && !isSetupApp(opts.app.trim().toLowerCase())) {
    throw new Error(`unknown app "${opts.app}" (expected one of: ${SETUP_APPS.join(', ')})`);
  }
  const interactive = !opts.yes && !opts.json && (deps.isInteractive ?? isInteractive)();
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
    summary: { lexiconPath: '', termsAdded: [], clients: [], serve: 'skipped', exports: [] },
  };
  if (prompter) ctx.prompter = prompter;

  say(bold('lexicon setup'));
  if (!interactive && !opts.yes && !opts.json) say(dim('(no terminal: taking the defaults, as with --yes)'));
  say();
  try {
    await stepLexicon(ctx);
    say();
    await stepHarvest(ctx);
    say();
    await stepClients(ctx);
    say();
    await stepServe(ctx);
    say();
    await stepExport(ctx);
    printSummary(ctx);
  } finally {
    if (ownPrompter) prompter?.close();
  }
  if (opts.json) io.stdout(`${JSON.stringify(ctx.summary, null, 2)}\n`);
  const failed = ctx.summary.serve === 'failed' || ctx.summary.clients.some((c) => c.status === 'failed');
  return { code: failed ? 1 : 0, summary: ctx.summary };
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
    .option('--no-harvest', 'skip the repo harvest')
    .option('--no-serve', 'skip installing the local API login service')
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
