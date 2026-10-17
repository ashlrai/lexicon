/**
 * Lexicon storage: path resolution, YAML read/write, global+project merge and
 * the mutating helpers (addTerm / removeTerm / recordHits) used by the MCP
 * server, CLI and hooks.
 *
 * One rule shapes several functions here and is worth stating once. A global
 * lexicon is one person's file in their own config directory. A project
 * lexicon is a file a team commits, and the product recommends it as the way
 * to share vocabulary. `hits` is a per-user usage counter. The two do not mix:
 * a counter written into the shared file dirties the working tree on every
 * session, conflicts for every contributor who happens to say the word, and
 * publishes which words one maintainer dictates most. So hits are counted in
 * a per-user sidecar next to the global lexicon (`hits.json`, see below), no
 * lexicon file is ever written a counter it did not already carry, and
 * `loadLexicon` adds the two together so everything downstream still sees one
 * number. That holds for the global file too: the prompt hook counts on every
 * matching prompt, and rewriting (and backing up) the user's whole YAML file
 * for a counter cost more than the rest of the hook put together.
 */
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { emptyLexicon, parseLexicon } from './schema.js';
import { isTrusted, refreshTrust, trustProject } from './trust.js';
import type { TrustStatus } from './trust.js';
import { errorMessage, isEnoent } from '../util/errors.js';
import { withFileLock, writeFileAtomic } from '../util/atomic.js';
import { formatJson } from '../util/json.js';
import { xdgConfigHome } from '../util/xdg.js';
import type {
  Lexicon,
  LexiconFile,
  LexiconSettings,
  LoadedLexicon,
  Term,
  TermScope,
} from './types.js';

export interface StoreOptions {
  /** Directory to start the project-file walk-up from. Default process.cwd(). */
  cwd?: string;
  /** Explicit global lexicon path; overrides $LEXICON_PATH and XDG defaults. */
  globalPath?: string;
  /** Environment consulted for $LEXICON_PATH and $XDG_CONFIG_HOME. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Home directory for the XDG fallback. Default os.homedir(). */
  home?: string;
}

export interface LoadOptions extends StoreOptions {
  /**
   * Merge the project file even when it is not trusted (see core/trust.ts).
   * Default false: an untrusted or changed project file is reported via
   * `LoadedLexicon.skippedProject` and NOT merged.
   */
  includeUntrusted?: boolean;
}

export const PROJECT_FILE_NAME = '.lexicon.yaml';

/**
 * Largest lexicon file we will parse. A project file comes from an arbitrary
 * repository; refusing huge files keeps a hostile repo from stalling the hook.
 */
export const MAX_LEXICON_BYTES = 2 * 1024 * 1024;

const HEADER_COMMENT = [
  'Lexicon: personal vocabulary for voice-to-agents.',
  'canonical: the spelling you want; aliases: what STT actually hears.',
  '',
  'Each term may also carry: phonetic (pronunciation hint), category',
  '(brand|person|product|acronym|identifier|place|other), notes (shown to the',
  'agent), never (words that must not be rewritten to this canonical).',
  'settings: minConfidence, phonetic, fuzzy, protectedWords, skipCode.',
].join('\n');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Walk up from `start` until a directory containing `.git` (inclusive) or the filesystem root. */
function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function findProjectFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, PROJECT_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    // The git root is the outermost directory we consider part of the project.
    if (existsSync(path.join(dir, '.git'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolvePaths(opts: StoreOptions = {}): { global: string; project?: string } {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const configHome = xdgConfigHome(env, opts.home ?? os.homedir());
  const global = opts.globalPath || env.LEXICON_PATH || path.join(configHome, 'lexicon', 'lexicon.yaml');
  const project = findProjectFile(cwd);
  return project ? { global, project } : { global };
}

/** Where a new project lexicon should be created for `cwd`: the git root if inside a repo, else cwd. */
export function defaultProjectPath(cwd: string = process.cwd()): string {
  return path.join(findGitRoot(cwd) ?? path.resolve(cwd), PROJECT_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readLexiconFile(filePath: string, scope: TermScope): Promise<LexiconFile> {
  const read = await readLexiconText(filePath);
  if (read === undefined) return { path: filePath, scope, lexicon: emptyLexicon(), exists: false };
  return parseLexiconText(read.text, filePath, scope);
}

/** The file's text and permission bits, or undefined when it does not exist. Enforces MAX_LEXICON_BYTES. */
async function readLexiconText(filePath: string): Promise<{ text: string; mode: number } | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_LEXICON_BYTES) {
      throw new Error(
        `Refusing to read lexicon at ${filePath}: ${stat.size} bytes exceeds the ${MAX_LEXICON_BYTES} byte limit`,
      );
    }
    return { text: await fs.readFile(filePath, 'utf8'), mode: stat.mode & 0o777 };
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

function parseLexiconText(text: string, filePath: string, scope: TermScope): LexiconFile {
  let raw: unknown;
  try {
    // prettyErrors embeds up to ~80 characters of the offending source line,
    // verbatim, in the thrown message. A project .lexicon.yaml is untrusted
    // input that may be shown to an agent, so the reason is all we want: a
    // deliberate syntax error after a line of instructions must not become a
    // way to get that line quoted back into a model's context.
    raw = parseYaml(text, { prettyErrors: false });
  } catch (err) {
    throw new Error(`Failed to parse lexicon YAML at ${filePath}: ${errorMessage(err)}`);
  }
  // An empty file is a valid, empty lexicon.
  if (raw === null || raw === undefined) {
    return { path: filePath, scope, lexicon: emptyLexicon(), exists: true };
  }
  let lexicon: Lexicon;
  try {
    lexicon = parseLexicon(raw);
  } catch (err) {
    throw new Error(`Invalid lexicon at ${filePath}: ${errorMessage(err)}`);
  }
  return { path: filePath, scope, lexicon, exists: true };
}

/**
 * The parsed global lexicon, kept beside it (`parse-cache.json`) together
 * with the exact YAML text it came from.
 *
 * The prompt hook loads the lexicon on every prompt, and parsing the YAML of a
 * lexicon with the starter packs installed was the largest single cost left in
 * it (tens of milliseconds against a 200 ms budget). An entry whose `text` is
 * the file's current text, character for character, is reused; anything else
 * (a hand edit, another writer, a corrupt or foreign cache) falls through to
 * the real parse, which then refreshes the entry. Comparing the text instead
 * of a hash of it is exact and keeps `node:crypto`, whose load alone cost the
 * hook about as much as the comparison saves, off the prompt path. The cached
 * value still goes through `parseLexicon`, so it can never hold something the
 * reader would have rejected. It is written with the lexicon's own permission
 * bits, since it holds the same names.
 *
 * Only `loadLexicon`'s read of the global file uses it, and only once that
 * file reaches PARSE_CACHE_MIN_BYTES: a project file is someone else's,
 * usually small, and is hashed by the trust check anyway; a small global file
 * parses in a few milliseconds, and skipping it keeps a cache file from
 * appearing beside every hand-written lexicon a test or a script points at.
 */
export const PARSE_CACHE_FILE_NAME = 'parse-cache.json';

/** Smallest global lexicon (bytes of YAML) worth caching; one starter pack is past it. */
export const PARSE_CACHE_MIN_BYTES = 8 * 1024;

/** Entry format; 1 was keyed by a sha256 of the text and is simply reparsed and replaced. */
const PARSE_CACHE_VERSION = 2;

async function readGlobalLexiconCached(filePath: string): Promise<LexiconFile> {
  const read = await readLexiconText(filePath);
  if (read === undefined) return { path: filePath, scope: 'global', lexicon: emptyLexicon(), exists: false };
  if (read.text.length < PARSE_CACHE_MIN_BYTES) return parseLexiconText(read.text, filePath, 'global');
  const cachePath = path.join(path.dirname(filePath), PARSE_CACHE_FILE_NAME);
  const key = path.resolve(filePath);
  try {
    const cached: unknown = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (isPlainObject(cached) && cached.version === PARSE_CACHE_VERSION && cached.path === key && cached.text === read.text) {
      return { path: filePath, scope: 'global', lexicon: parseLexicon(cached.lexicon), exists: true };
    }
  } catch {
    // missing, unreadable or stale: parse for real below
  }
  const file = parseLexiconText(read.text, filePath, 'global');
  try {
    await writeFileAtomic(cachePath, JSON.stringify({ version: PARSE_CACHE_VERSION, path: key, text: read.text, lexicon: file.lexicon }), {
      mode: read.mode,
    });
  } catch {
    // a cache, not state: the next read parses again
  }
  return file;
}

/**
 * Serialize, check the result reads back, then replace the file.
 *
 * The check is the whole point of the ordering. An import of a mis-decoded
 * file (a UTF-16LE dictionary read as UTF-8, say) produces terms full of NUL
 * bytes; those serialize happily and only fail on the way back in, so writing
 * first and validating afterwards left a lexicon that no command could read
 * and no command could repair. Nothing is replaced until the bytes we are
 * about to write have been through the reader's own pipeline, and the previous
 * contents are kept at `<path>.bak` either way.
 *
 * The write takes the file's lock, so a caller that only writes is still safe
 * against a concurrent writer. A caller that *reads, edits and writes* has to
 * hold the lock across all three: see `withLexiconLock` below, which this
 * re-enters rather than deadlocking on.
 *
 * `pinCommittedHits` runs first, inside that lock, so no writer can raise a
 * counter in the file: counts live in `hits.json`.
 */
export async function writeLexiconFile(file: LexiconFile): Promise<void> {
  const header = HEADER_COMMENT.split('\n')
    .map((line) => (line ? `# ${line}` : '#'))
    .join('\n');
  await withLexiconLock(file.path, async () => {
    await pinCommittedHits(file);
    const body = stringifyYaml(orderLexicon(file.lexicon), { lineWidth: 0 });
    const text = `${header}\n\n${body}`;
    assertReadsBack(text, file.path);
    await writeFileAtomic(file.path, text, { backup: true });
  });
  file.exists = true;
}

/**
 * Force every term's `hits` back to the value the file on disk already holds,
 * and drop it entirely for a term the file does not have yet.
 *
 * This is the single choke point that keeps counters out of the lexicon files
 * (a shared, committed project file and the user's own global one alike: both
 * are counted in `hits.json`), and it is deliberately a clamp rather than a rule each
 * caller has to remember. `addTerm` will happily take a `hits` from whoever
 * called it; `merge: false` spreads a caller's term wholesale; and terms read
 * off `LoadedLexicon.merged` carry this user's own counts, because
 * `loadLexicon` adds them there. Any of those reaching a write is how the
 * counters got into git in the first place, so the write path refuses them all
 * rather than trusting nine call sites to agree.
 *
 * Counts already committed are kept, not stripped: they are somebody's data,
 * they stop growing the moment this lands, and deleting them from a tracked
 * file is the user's edit to make, not ours. `loadLexicon` treats them as a
 * floor and adds this user's own counts on top.
 *
 * A file that cannot be read (new, or being repaired after a bad write) has no
 * counts to preserve, so every `hits` is dropped.
 */
async function pinCommittedHits(file: LexiconFile): Promise<void> {
  const onDisk = new Map<string, number>();
  try {
    const current = await readLexiconFile(file.path, file.scope);
    for (const term of current.lexicon.terms) {
      if (term.hits !== undefined) onDisk.set(hitKey(term.canonical), term.hits);
    }
  } catch {
    // Unreadable or absent: nothing on disk to preserve.
  }
  for (const term of file.lexicon.terms) {
    const committed = onDisk.get(hitKey(term.canonical));
    if (committed === undefined) delete term.hits;
    else term.hits = committed;
  }
}

/**
 * Put `text` through exactly what `readLexiconFile` would do to it and throw
 * before any file is touched when that fails. Checking the serialized bytes
 * rather than the in-memory object is deliberate: the round trip is where a
 * value that YAML cannot express, or that the schema rejects, actually shows
 * up.
 */
function assertReadsBack(text: string, filePath: string): void {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: false });
  } catch (err) {
    throw new Error(
      `Refusing to write lexicon at ${filePath}: the YAML it produced does not parse back: ${errorMessage(err)}`,
    );
  }
  try {
    parseLexicon(raw ?? emptyLexicon());
  } catch (err) {
    throw new Error(`Refusing to write lexicon at ${filePath}: ${errorMessage(err)}`);
  }
}

/**
 * Run `fn` with exclusive access to a lexicon file, across processes. Wrap the
 * whole read-modify-write in it, not just the write: five writers share these
 * files (MCP server, UserPromptSubmit hook, `lexicon serve`, the clipboard
 * daemon, the menu bar app) and two of them reading before either writes is
 * how a `learn_correction` used to disappear behind a hit counter.
 *
 * Re-entrant for the same path, so nested `writeLexiconFile` calls are free.
 * A writer that cannot get the lock throws (`FileLockError`) rather than
 * overwriting; `recordHits` is the one caller that swallows that, because a
 * lost hit count is bookkeeping and it may never throw by contract.
 */
export function withLexiconLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return withFileLock(filePath, fn);
}

const TERM_KEY_ORDER: (keyof Term)[] = [
  'canonical',
  'aliases',
  'phonetic',
  'category',
  'notes',
  'caseSensitive',
  'never',
  'scope',
  'source',
  'createdAt',
  'hits',
];

/**
 * Drop `undefined` values and empty lists. The schema materializes an empty
 * array for every optional word list (`protectedWords`, `packs`), so without
 * this a plain `lexicon add` would litter a hand-edited file with `packs: []`.
 */
function orderLexicon(lexicon: Lexicon): Record<string, unknown> {
  const out: Record<string, unknown> = { version: lexicon.version };
  if (lexicon.settings && Object.keys(stripUndefined(lexicon.settings)).length > 0) {
    out.settings = stripUndefined(lexicon.settings);
  }
  out.terms = lexicon.terms.map((term) => {
    const ordered: Record<string, unknown> = {};
    for (const key of TERM_KEY_ORDER) {
      const value = term[key];
      if (value !== undefined) ordered[key] = value;
    }
    // Any keys not in the fixed order (future additions) go last.
    for (const [key, value] of Object.entries(term)) {
      if (!(key in ordered) && value !== undefined) ordered[key] = value;
    }
    return ordered;
  });
  return out;
}

function stripUndefined<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-user hit counts for project terms
// ---------------------------------------------------------------------------

/**
 * Usage counters live here, next to the global lexicon, for the same reason
 * the trust registry does: it is this user's file, on this user's machine, and
 * nothing in a repository should be rewritten to hold it.
 *
 * Shape: project terms keyed by absolute (symlink-resolved) project file path
 * and then by lowercased canonical; global terms by lowercased canonical:
 *
 *   { "version": 1,
 *     "projects": { "/repo/.lexicon.yaml": { "ashlr.ai": 11 } },
 *     "global": { "vercel": 4 } }
 *
 * Global terms used to be counted in the global lexicon itself. Rewriting that
 * file on every matching prompt made the hook miss its budget and churned the
 * user's backups, so they are counted here too. A `hits` value already in a
 * lexicon file is kept as a floor (`pinCommittedHits`) and these counts are
 * added on top.
 */
export const HITS_FILE_NAME = 'hits.json';

export interface HitsRegistry {
  version: 1;
  /** Project file path -> lowercased canonical -> count. */
  projects: Record<string, Record<string, number>>;
  /** Global-scope terms: lowercased canonical -> count. Absent until the first one is counted. */
  global?: Record<string, number>;
}

/** `<dirname(global lexicon)>/hits.json`; follows LEXICON_PATH and XDG_CONFIG_HOME. */
export function getHitsPath(opts: StoreOptions = {}): string {
  return path.join(path.dirname(resolvePaths(opts).global), HITS_FILE_NAME);
}

/** The key a canonical is counted under. Matches `sameCanonical`. */
function hitKey(canonical: string): string {
  return canonical.trim().toLowerCase();
}

/** Absolute path with symlinks resolved when the file exists (macOS /var vs /private/var). */
async function canonicalPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function emptyHitsRegistry(): HitsRegistry {
  return { version: 1, projects: {} };
}

/**
 * Read the registry. Missing, unparseable or malformed all yield an empty one:
 * these are counters, and the safe failure mode for a counter is zero.
 */
async function readHitsRegistry(opts: StoreOptions): Promise<HitsRegistry> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(getHitsPath(opts), 'utf8'));
  } catch {
    return emptyHitsRegistry();
  }
  const out = emptyHitsRegistry();
  const projects = isPlainObject(raw) ? raw.projects : undefined;
  if (isPlainObject(projects)) {
    for (const [file, counts] of Object.entries(projects)) {
      if (isPlainObject(counts)) out.projects[file] = validCounts(counts);
    }
  }
  const global = isPlainObject(raw) ? raw.global : undefined;
  if (isPlainObject(global)) out.global = validCounts(global);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validCounts(counts: Record<string, unknown>): Record<string, number> {
  const entry: Record<string, number> = {};
  for (const [canonical, n] of Object.entries(counts)) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) entry[canonical] = n;
  }
  return entry;
}

/**
 * This user's counts for global-scope terms, keyed by lowercased canonical.
 * Never throws; an unreadable registry reads as no counts. Like
 * `readProjectHits`, `loadLexicon` already folds these into `merged`.
 */
export async function readGlobalHits(opts: StoreOptions = {}): Promise<Record<string, number>> {
  try {
    return (await readHitsRegistry(opts)).global ?? {};
  } catch {
    return {};
  }
}

/**
 * The sidecar counts for the terms of `file`: `readProjectHits` for a project
 * file, `readGlobalHits` for the global one. Pair with `effectiveHits`.
 */
export async function readHitsFor(
  file: Pick<LexiconFile, 'path' | 'scope'>,
  opts: StoreOptions = {},
): Promise<Record<string, number>> {
  return file.scope === 'project' ? readProjectHits(file.path, opts) : readGlobalHits(opts);
}

/**
 * This user's own counts for the terms of `projectPath`, keyed by lowercased
 * canonical. Never throws; an unreadable registry reads as no counts.
 *
 * `loadLexicon` folds these into `merged` for you. Reach for this directly
 * only where a term has to stay exactly as it is on disk because it is about
 * to be written back, and the count is still needed to decide something:
 * `uninstallPack`'s "the user has used this, keep it" guard and `lexicon
 * review --never-hit` are the two.
 */
export async function readProjectHits(
  projectPath: string,
  opts: StoreOptions = {},
): Promise<Record<string, number>> {
  try {
    const registry = await readHitsRegistry(opts);
    return registry.projects[await canonicalPath(projectPath)] ?? {};
  } catch {
    return {};
  }
}

/** What `term` has actually been used: the file's committed floor plus `counts` from `readProjectHits`. */
export function effectiveHits(term: Term, counts: Record<string, number>): number {
  return (term.hits ?? 0) + (counts[hitKey(term.canonical)] ?? 0);
}

/**
 * Forget this user's count for one canonical of `projectPath`. Called when the
 * term is removed, so re-adding it later starts from zero instead of
 * resurrecting a tally for a word that is no longer in the file. Best effort.
 */
async function dropProjectHits(projectPath: string, canonical: string, opts: StoreOptions): Promise<void> {
  try {
    const hitsPath = getHitsPath(opts);
    const key = await canonicalPath(projectPath);
    await withFileLock(hitsPath, async () => {
      const registry = await readHitsRegistry(opts);
      const entry = registry.projects[key];
      if (!entry || !(hitKey(canonical) in entry)) return;
      delete entry[hitKey(canonical)];
      await writeFileAtomic(hitsPath, formatJson(registry));
    });
  } catch {
    // bookkeeping
  }
}

/** Forget this user's count for one global canonical (the term was removed). Best effort. */
async function dropGlobalHits(canonical: string, opts: StoreOptions): Promise<void> {
  try {
    const hitsPath = getHitsPath(opts);
    await withFileLock(hitsPath, async () => {
      const registry = await readHitsRegistry(opts);
      if (!registry.global || !(hitKey(canonical) in registry.global)) return;
      delete registry.global[hitKey(canonical)];
      await writeFileAtomic(hitsPath, formatJson(registry));
    });
  } catch {
    // bookkeeping
  }
}

/**
 * Add this user's counts to the merged view, so `lexicon stats`, the
 * exporters' ordering and the stale-term suggester all still see one number
 * per term.
 *
 * Only `merged` is touched. `LoadedLexicon.project.lexicon` stays exactly what
 * `readLexiconFile` returned, which is what every read-modify-write path in
 * the codebase writes back, and `mergeLexicons` shallow-copies every term, so
 * the two cannot alias each other.
 */
async function hydrateHits(merged: Lexicon, project: LexiconFile | undefined, opts: StoreOptions): Promise<void> {
  let registry: HitsRegistry;
  try {
    registry = await readHitsRegistry(opts);
  } catch {
    return;
  }
  const projectCounts = project ? (registry.projects[await canonicalPath(project.path)] ?? {}) : {};
  const globalCounts = registry.global ?? {};
  if (Object.keys(projectCounts).length === 0 && Object.keys(globalCounts).length === 0) return;
  // A term the project file owns takes only the project count: `recordHits`
  // credits the project file first, so a global term of the same name was
  // never counted there and must not pick the count up, and the reverse.
  const owned = new Set(project ? project.lexicon.terms.map((t) => hitKey(t.canonical)) : []);
  for (const term of merged.terms) {
    const key = hitKey(term.canonical);
    const n = owned.has(key) ? projectCounts[key] : globalCounts[key];
    if (n) term.hits = (term.hits ?? 0) + n;
  }
}

// ---------------------------------------------------------------------------
// Load + merge
// ---------------------------------------------------------------------------

/**
 * Load global + project and merge them. The project file is merged ONLY when
 * it is trusted (`lexicon trust`, or `LEXICON_TRUST_ALL=1`), unless
 * `opts.includeUntrusted` is set. Otherwise the result is global-only with
 * `skippedProject` and `projectTrust` describing what was left out, so callers
 * can tell the user without ever injecting the file's contents.
 *
 * An untrusted project file that fails to parse is skipped the same way rather
 * than thrown, so a hostile or broken repo file cannot disable the global
 * lexicon in the hook.
 */
export async function loadLexicon(opts: LoadOptions = {}): Promise<LoadedLexicon> {
  const paths = resolvePaths(opts);
  const global = await readGlobalLexiconCached(paths.global);
  if (!paths.project) return { merged: await hydrated(mergeLexicons(global.lexicon)), global };

  let project: LexiconFile;
  try {
    project = await readLexiconFile(paths.project, 'project');
  } catch (err) {
    const placeholder: LexiconFile = { path: paths.project, scope: 'project', lexicon: emptyLexicon(), exists: true };
    const trust = await isTrusted(placeholder, opts);
    if (trust === 'trusted' || opts.includeUntrusted) throw err;
    return { merged: await hydrated(mergeLexicons(global.lexicon)), global, projectTrust: trust, skippedProject: placeholder };
  }

  const projectTrust = await isTrusted(project, opts);
  if (projectTrust === 'trusted' || opts.includeUntrusted) {
    const merged = mergeLexicons(global.lexicon, project.lexicon);
    await hydrateHits(merged, project, opts);
    return { merged, global, project, projectTrust };
  }
  return { merged: await hydrated(mergeLexicons(global.lexicon)), global, projectTrust, skippedProject: project };

  async function hydrated(merged: Lexicon): Promise<Lexicon> {
    await hydrateHits(merged, undefined, opts);
    return merged;
  }
}

/**
 * Merge a project lexicon over a global one. Project terms replace global terms
 * with the same canonical (case-insensitive) but aliases are unioned; settings
 * override per key; protectedWords are unioned.
 */
export function mergeLexicons(global: Lexicon, project?: Lexicon): Lexicon {
  const terms: Term[] = global.terms.map((t) => ({ ...t, aliases: [...t.aliases], scope: t.scope ?? 'global' }));
  if (project) {
    for (const pt of project.terms) {
      const idx = terms.findIndex((t) => sameCanonical(t.canonical, pt.canonical));
      const replacement: Term = { ...pt, scope: pt.scope ?? 'project' };
      if (idx === -1) {
        terms.push({ ...replacement, aliases: [...pt.aliases] });
      } else {
        replacement.aliases = dedupeAliases([...pt.aliases, ...terms[idx].aliases], pt.canonical);
        terms[idx] = replacement;
      }
    }
  }
  const settings = mergeSettings(global.settings, project?.settings);
  const merged: Lexicon = { version: 1, terms };
  if (settings) merged.settings = settings;
  return merged;
}

function mergeSettings(
  global?: LexiconSettings,
  project?: LexiconSettings,
): LexiconSettings | undefined {
  if (!global && !project) return undefined;
  const out: LexiconSettings = { ...(global ?? {}), ...(project ?? {}) };
  const protectedWords = dedupeCaseInsensitive([
    ...(global?.protectedWords ?? []),
    ...(project?.protectedWords ?? []),
  ]);
  if (protectedWords.length > 0) out.protectedWords = protectedWords;
  else delete out.protectedWords;
  return out;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Thrown when a write would target an existing project lexicon that the user
 * has not approved (or that changed since they did). Writing would read the
 * unreviewed file, merge into it and re-pin the whole thing as trusted, which
 * launders a hostile repo file into the model's context.
 */
export class ProjectTrustError extends Error {
  readonly path: string;
  readonly status: Exclude<TrustStatus, 'trusted'>;

  constructor(projectPath: string, status: Exclude<TrustStatus, 'trusted'>) {
    const why = status === 'changed' ? 'has changed since it was trusted' : 'is untrusted';
    super(
      `project lexicon at ${projectPath} ${why}; review it and run \`lexicon trust\` first, or write to the global lexicon instead`,
    );
    this.name = 'ProjectTrustError';
    this.path = projectPath;
    this.status = status;
  }
}

/**
 * True for a `ProjectTrustError` (a project-scope write refused because the
 * repo's .lexicon.yaml is unreviewed). Duck-typed by name rather than with
 * `instanceof`, so it still holds when a caller is running against a mocked
 * core or a second copy of this package.
 */
export function isProjectTrustError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ProjectTrustError';
}

/**
 * Gate for every project-scope write. A file that does not exist yet may be
 * created (the user is authoring it, and writeAndTrust pins it). An existing
 * file must already be 'trusted' (registry match, LEXICON_TRUST_ALL, or inside
 * the global config dir); 'untrusted' and 'changed' throw before anything is
 * read or merged. Callers that must never throw (recordHits) skip the file
 * instead of calling this.
 */
async function assertProjectWritable(projectPath: string, opts: StoreOptions): Promise<void> {
  if (!existsSync(projectPath)) return;
  const status = await isTrusted(
    { path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true },
    opts,
  );
  if (status !== 'trusted') throw new ProjectTrustError(projectPath, status);
}

export async function addTerm(
  term: Term,
  opts: StoreOptions & {
    scope?: TermScope;
    merge?: boolean;
    /**
     * Aliases for a term this call creates with none of its own (the callers'
     * `suggestAliases` fallback). Ignored when the term already exists, so
     * adding a never word, phonetic, category or notes appends nothing.
     */
    defaultAliases?: readonly string[];
  } = {},
): Promise<{ file: LexiconFile; term: Term; created: boolean }> {
  const scope: TermScope = opts.scope ?? 'global';
  // The trust gate stays ahead of every other check, as it was when this
  // resolved the file rather than the path.
  const targetPath = await resolveScopeWritePath(scope, opts);
  const canonical = term.canonical.trim();
  if (!canonical) throw new Error('addTerm: canonical must not be empty');

  const incoming: Term = {
    ...term,
    canonical,
    aliases: dedupeAliases(term.aliases ?? [], canonical),
  };

  // Read, edit and write inside one lock: a concurrent add that read the same
  // file before this one wrote would otherwise rename its own copy over the
  // top and take the new term with it.
  return withLexiconLock(targetPath, async () => {
    const file = await readLexiconFile(targetPath, scope);

    const existing = findTerm(file.lexicon, canonical);
    if (existing && opts.merge !== false) {
      existing.aliases = dedupeAliases([...existing.aliases, ...incoming.aliases], existing.canonical);
      existing.phonetic ??= incoming.phonetic;
      existing.category ??= incoming.category;
      existing.notes ??= incoming.notes;
      existing.caseSensitive ??= incoming.caseSensitive;
      if (incoming.never?.length) {
        existing.never = dedupeCaseInsensitive([...(existing.never ?? []), ...incoming.never]);
      }
      await writeAndTrust(file, opts);
      return { file, term: existing, created: false };
    }

    if (existing) {
      // merge === false: replace outright, keeping the original creation time.
      const replaced: Term = {
        ...incoming,
        scope,
        source: incoming.source ?? 'user',
        createdAt: existing.createdAt ?? incoming.createdAt ?? new Date().toISOString(),
      };
      const idx = file.lexicon.terms.indexOf(existing);
      file.lexicon.terms[idx] = replaced;
      await writeAndTrust(file, opts);
      return { file, term: replaced, created: false };
    }

    const created: Term = {
      ...incoming,
      ...(incoming.aliases.length === 0 && opts.defaultAliases?.length
        ? { aliases: dedupeAliases([...opts.defaultAliases], canonical) }
        : {}),
      scope,
      source: incoming.source ?? 'user',
      createdAt: incoming.createdAt ?? new Date().toISOString(),
    };
    file.lexicon.terms.push(created);
    await writeAndTrust(file, opts);
    return { file, term: created, created: true };
  });
}

/**
 * Write a lexicon file and, for a project file, register it as trusted: the
 * user (or an agent acting on their explicit add/harvest request) just wrote
 * it, which is the same judgment `lexicon trust` records. Only reached for a
 * file that was new or already trusted (see assertProjectWritable), so this
 * re-pins the user's own edit and never blesses pre-existing untrusted
 * content. Global files need no trust entry.
 */
async function writeAndTrust(file: LexiconFile, opts: StoreOptions): Promise<void> {
  await writeLexiconFile(file);
  if (file.scope === 'project') await trustProject(file.path, opts);
}

/**
 * Remove `canonical` from the first file that holds it (project, then global,
 * or just the requested scope). Throws ProjectTrustError when the term lives
 * in an untrusted/changed project file: rewriting that file would look like a
 * user edit and must not happen until the user has reviewed it.
 */
export async function removeTerm(
  canonical: string,
  opts: StoreOptions & { scope?: TermScope } = {},
): Promise<boolean> {
  for (const target of candidatePaths(opts, opts.scope)) {
    const removed = await withLexiconLock(target.path, async () => {
      const file = await readLexiconFile(target.path, target.scope);
      if (!file.exists) return false;
      const remaining = file.lexicon.terms.filter((t) => !sameCanonical(t.canonical, canonical));
      if (remaining.length === file.lexicon.terms.length) return false;
      if (file.scope === 'project') await assertProjectWritable(file.path, opts);
      file.lexicon.terms = remaining;
      await writeLexiconFile(file);
      if (file.scope === 'project') {
        // The user's own edit must not flip an already-trusted file to 'changed'.
        await refreshTrust(file.path, opts);
        // The term is gone; so is this user's tally for it, or re-adding the
        // word later would inherit a count it never earned.
        await dropProjectHits(file.path, canonical, opts);
      } else {
        await dropGlobalHits(canonical, opts);
      }
      return true;
    });
    if (removed) return true;
  }
  return false;
}

/**
 * Count one use of each canonical. Never throws.
 *
 * Every count lands in the per-user sidecar (`hits.json`); no lexicon file is
 * written. A project-scope term is counted under its project file, which is
 * read (to learn which canonicals it owns, and that it is trusted) and never
 * written: the file a team commits stops changing under them, the trust pin
 * over its sha256 stops being invalidated by other people's dictation, and
 * nobody's usage pattern ends up in a public repository. Everything else is
 * counted under `global`, and only for a term the global file actually holds,
 * so a stray canonical (one from an unreviewed project file, say) is never
 * recorded as in use.
 *
 * Pass `loaded` (the `loadLexicon` result the canonicals came from) and
 * neither file is read again: the prompt hook does, because it calls this on
 * every matching prompt, and re-parsing (and, before this, rewriting and
 * backing up) the user's whole YAML file for a counter was most of its time.
 */
export async function recordHits(
  canonicals: string[],
  opts: StoreOptions & { loaded?: Pick<LoadedLexicon, 'global' | 'project' | 'projectTrust'> } = {},
): Promise<void> {
  try {
    if (canonicals.length === 0) return;
    const counts = new Map<string, number>();
    for (const c of canonicals) {
      const key = hitKey(c);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (counts.size === 0) return;

    const paths = resolvePaths(opts);
    let projectFile: LexiconFile | undefined;
    if (opts.loaded) {
      // Only a trusted project file was merged, so only it can have produced a hit.
      if (opts.loaded.project && opts.loaded.projectTrust === 'trusted') projectFile = opts.loaded.project;
    } else if (paths.project) {
      const file = await readLexiconFile(paths.project, 'project');
      // Hits only come from merged terms, so an untrusted project file cannot
      // have produced any; skip it silently (this function never throws, so it
      // cannot use assertProjectWritable) and never auto-trust it here.
      if (file.exists && (await isTrusted(file, opts)) === 'trusted') projectFile = file;
    }
    let project: { key: string; counts: Map<string, number> } | undefined;
    if (projectFile) {
      const mine = new Map<string, number>();
      for (const term of projectFile.lexicon.terms) {
        const key = hitKey(term.canonical);
        const n = counts.get(key);
        if (n === undefined) continue;
        mine.set(key, n);
        // Project file is consulted first; do not double-count in global.
        counts.delete(key);
      }
      if (mine.size > 0) project = { key: await canonicalPath(projectFile.path), counts: mine };
    }
    if (counts.size > 0) {
      const globalFile = opts.loaded?.global ?? (await readLexiconFile(paths.global, 'global'));
      const owned = new Set(globalFile.lexicon.terms.map((t) => hitKey(t.canonical)));
      for (const key of [...counts.keys()]) if (!owned.has(key)) counts.delete(key);
    }
    if (!project && counts.size === 0) return;

    // A lock we cannot get lands in the catch below, which is the right trade
    // here and nowhere else (a lost hit count is bookkeeping; a lost term is
    // not).
    const hitsPath = getHitsPath(opts);
    await withFileLock(hitsPath, async () => {
      const registry = await readHitsRegistry(opts);
      if (project) {
        const entry = { ...(registry.projects[project.key] ?? {}) };
        for (const [canonical, n] of project.counts) entry[canonical] = (entry[canonical] ?? 0) + n;
        registry.projects[project.key] = entry;
      }
      if (counts.size > 0) {
        const global = { ...(registry.global ?? {}) };
        for (const [canonical, n] of counts) global[canonical] = (global[canonical] ?? 0) + n;
        registry.global = global;
      }
      await fs.mkdir(path.dirname(hitsPath), { recursive: true });
      await writeFileAtomic(hitsPath, formatJson(registry));
    });
  } catch {
    // best effort by contract
  }
}

export function findTerm(lexicon: Lexicon, canonical: string): Term | undefined {
  return lexicon.terms.find((t) => sameCanonical(t.canonical, canonical));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The path a scoped write targets. For project scope the trust gate runs here,
 * before the file is locked or read.
 *
 * Exported because a caller that performs several writes as one operation has
 * to lock the same path this resolves, and resolving it a second way would be
 * a second chance to disagree. `installPack` is the case: it adds every term
 * and then rewrites `settings.packs`, and those have to be one transaction.
 */
export async function resolveScopeWritePath(scope: TermScope, opts: StoreOptions): Promise<string> {
  const paths = resolvePaths(opts);
  if (scope === 'global') return paths.global;
  const projectPath = paths.project ?? defaultProjectPath(opts.cwd ?? process.cwd());
  await assertProjectWritable(projectPath, opts);
  return projectPath;
}

/**
 * Files to search for a term: project first (if any), then global; or just the
 * requested scope. Paths only, because each one is read inside its own lock
 * rather than all of them up front.
 */
function candidatePaths(opts: StoreOptions, scope?: TermScope): { path: string; scope: TermScope }[] {
  const paths = resolvePaths(opts);
  if (scope === 'global') return [{ path: paths.global, scope: 'global' }];
  if (scope === 'project') return paths.project ? [{ path: paths.project, scope: 'project' }] : [];
  const targets: { path: string; scope: TermScope }[] = [];
  if (paths.project) targets.push({ path: paths.project, scope: 'project' });
  targets.push({ path: paths.global, scope: 'global' });
  return targets;
}

function sameCanonical(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Trim, drop empties and anything equal to the canonical, dedupe case-insensitively (first spelling wins). */
export function dedupeAliases(aliases: string[], canonical: string): string[] {
  const canon = canonical.trim().toLowerCase();
  return dedupeCaseInsensitive(aliases).filter((a) => a.toLowerCase() !== canon);
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

