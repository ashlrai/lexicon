/**
 * Lexicon storage: path resolution, YAML read/write, global+project merge and
 * the mutating helpers (addTerm / removeTerm / removeAlias / recordHits) used
 * by the MCP server, CLI and hooks.
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
import { promises as fs, existsSync, lstatSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
import type { Document, YAMLMap } from 'yaml';
import { emptyLexicon, parseLexicon } from './schema.js';
import { buildIndex } from './matcher.js';
import type { MatcherIndex } from './matcher.js';
import { INDEX_FORMAT_VERSION, deserializeIndex, indexKey, serializeIndex } from './matcher/serialize.js';
import { isTrusted, refreshTrust, trustProject } from './trust.js';
import { recalledParsedHash, rememberParsedBytes, rememberParsedHash, shareParsedHash } from './parsed-hash.js';
import type { TrustStatus } from './trust.js';
import { InputError, errorMessage, isEnoent } from '../util/errors.js';
import { withFileLock, writeFileAtomic } from '../util/atomic.js';
import { isBoundedReadError, readBoundedRegularFile } from '../util/bounded-read.js';
import { formatJson } from '../util/json.js';
import { globalLexiconPath } from '../util/xdg.js';
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
  /**
   * Parse a project file the trust gate leaves out. Default true, so
   * `skippedProject.lexicon` holds its terms (learn and remove name the
   * skipped file when it claims a word). With `false` (the prompt hook) trust
   * is checked first, against the registry and the sha256 of the bytes read,
   * and an untrusted or changed file is never parsed: `skippedProject` then
   * carries its path with an empty lexicon. Ignored with `includeUntrusted`.
   */
  parseSkipped?: boolean;
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

/**
 * True when a `.lexicon.yaml` found by the walk may be announced as this
 * project's: on POSIX the entry (and, for a symlink, its target) must belong
 * to the current user or to root, the rule OpenSSH applies to its config files
 * and git (`safe.directory`) to repositories. Without a `.git` the walk goes
 * up to `/`, so a file another local account planted in `/tmp` or `/home`
 * was reported as "this repo has an untrusted .lexicon.yaml" to every user
 * working below it. Windows has no meaningful uid in `stat`, so every file is
 * accepted there, as before. A file that cannot be stat'ed is skipped.
 */
function ownedByUserOrRoot(candidate: string): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid === undefined) return true;
  try {
    const ok = (owner: number): boolean => owner === uid || owner === 0;
    return ok(lstatSync(candidate).uid) && ok(statSync(candidate).uid);
  } catch {
    return false;
  }
}

/**
 * Walk up from `start` to the first `.lexicon.yaml` owned by the current user
 * or root (see ownedByUserOrRoot; one owned by anyone else is passed over and
 * the walk goes on), stopping at the git root or the filesystem root.
 */
function findProjectFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, PROJECT_FILE_NAME);
    if (existsSync(candidate) && ownedByUserOrRoot(candidate)) return candidate;
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
  const global = opts.globalPath || globalLexiconPath(env, opts.home ?? os.homedir());
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
  const file = parseLexiconText(read.text, filePath, scope);
  // The trust gate checks these bytes, not a second read (see parsed-hash.ts).
  if (scope === 'project') rememberParsedBytes(file, read.bytes);
  return file;
}

/**
 * The file's text and permission bits, or undefined when it does not exist.
 * Enforces MAX_LEXICON_BYTES on the bytes actually read, and reads only a
 * regular file: a repository's `.lexicon.yaml` may be a symlink to
 * `/dev/zero` or `/dev/stdin`, which a size check on `stat` cannot see (see
 * util/bounded-read.ts).
 */
async function readLexiconText(filePath: string): Promise<{ text: string; mode: number; bytes: Buffer } | undefined> {
  try {
    const { bytes, mode } = await readBoundedRegularFile(filePath, MAX_LEXICON_BYTES);
    return { text: bytes.toString('utf8'), mode, bytes };
  } catch (err) {
    if (isEnoent(err)) return undefined;
    if (isBoundedReadError(err)) {
      throw new Error(
        err.reason === 'not-regular'
          ? `Refusing to read lexicon at ${filePath}: not a regular file`
          : `Refusing to read lexicon at ${filePath}: ${err.size ?? 'more than'} bytes exceeds the ${MAX_LEXICON_BYTES} byte limit`,
      );
    }
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
 * hook about as much as the comparison saves, off the prompt path. It is
 * written with the lexicon's own permission bits, since it holds the same
 * names.
 *
 * The cached lexicon is stored as the JSON text `parseLexicon` produced,
 * beside a checksum of that text (`sum`, FNV-1a; see `cacheChecksum`). An
 * entry whose text does not hash to its `sum` is a damaged or edited file and
 * is ignored. Version 2 entries re-ran the full schema validator on every
 * read instead, which cost a 2000-term lexicon about 30 ms per prompt to
 * re-check a value this module had already validated before writing it.
 *
 * `loadLexicon`'s read of the global file uses it, and so do the reads the
 * writers here make of the global file before they edit it (see
 * readLexiconFileForWrite), only once that file reaches
 * PARSE_CACHE_MIN_BYTES: a project file is someone else's,
 * usually small, and is hashed by the trust check anyway; a small global file
 * parses in a few milliseconds, and skipping it keeps a cache file from
 * appearing beside every hand-written lexicon a test or a script points at.
 */
export const PARSE_CACHE_FILE_NAME = 'parse-cache.json';

/** Smallest global lexicon (bytes of YAML) worth caching; one starter pack is past it. */
export const PARSE_CACHE_MIN_BYTES = 8 * 1024;

/**
 * Entry format. 1 was keyed by a sha256 of the text, 2 held the lexicon as an
 * object and re-validated it; both are simply reparsed and replaced.
 */
export const PARSE_CACHE_VERSION = 3;

/**
 * 32-bit FNV-1a of `text`'s UTF-16 code units, as 8 hex digits. A corruption
 * check for this module's own cache files, not a security boundary: anyone who
 * can write the cache can write the lexicon beside it.
 */
export function cacheChecksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * `readLexiconFile` for the writers in this module: a global file comes from
 * the parse cache when its text is the one cached (the same value the YAML
 * parse would give; see readGlobalLexiconCached), a project file is read and
 * parsed as before. A `lexicon add` on a 2000-term lexicon parsed the YAML
 * twice before writing (the read it edits and pinCommittedHits' look at what
 * is on disk), about half of its time. A miss is not written back: the write
 * that follows refreshes the entry anyway.
 */
function readLexiconFileForWrite(filePath: string, scope: TermScope): Promise<LexiconFile> {
  return scope === 'global' ? readGlobalLexiconCached(filePath, { writeBack: false }) : readLexiconFile(filePath, scope);
}

async function readGlobalLexiconCached(filePath: string, opts: { writeBack?: boolean } = {}): Promise<LexiconFile> {
  const read = await readLexiconText(filePath);
  if (read === undefined) return { path: filePath, scope: 'global', lexicon: emptyLexicon(), exists: false };
  if (read.text.length < PARSE_CACHE_MIN_BYTES) return parseLexiconText(read.text, filePath, 'global');
  const cachePath = path.join(path.dirname(filePath), PARSE_CACHE_FILE_NAME);
  const key = path.resolve(filePath);
  try {
    const cached: unknown = JSON.parse(await fs.readFile(cachePath, 'utf8'));
    if (
      isPlainObject(cached) &&
      cached.version === PARSE_CACHE_VERSION &&
      cached.path === key &&
      cached.text === read.text &&
      typeof cached.lexicon === 'string' &&
      cached.sum === cacheChecksum(cached.lexicon)
    ) {
      const lexicon: unknown = JSON.parse(cached.lexicon);
      if (isPlainObject(lexicon) && Array.isArray(lexicon.terms)) {
        return { path: filePath, scope: 'global', lexicon: lexicon as unknown as Lexicon, exists: true };
      }
    }
  } catch {
    // missing, unreadable or stale: parse for real below
  }
  const file = parseLexiconText(read.text, filePath, 'global');
  if (opts.writeBack !== false) await writeParseCache(filePath, read.text, file.lexicon, read.mode);
  return file;
}

/**
 * Record `lexicon` as the parse of `text` for the global file at `filePath`
 * (see PARSE_CACHE_FILE_NAME). Best effort, never throws. `lexicon` must be
 * what `parseLexicon` returned for exactly `text`.
 */
async function writeParseCache(filePath: string, text: string, lexicon: Lexicon, mode: number): Promise<void> {
  if (text.length < PARSE_CACHE_MIN_BYTES) return;
  try {
    const lexiconJson = JSON.stringify(lexicon);
    await writeFileAtomic(
      path.join(path.dirname(filePath), PARSE_CACHE_FILE_NAME),
      JSON.stringify({ version: PARSE_CACHE_VERSION, path: path.resolve(filePath), text, sum: cacheChecksum(lexiconJson), lexicon: lexiconJson }),
      { mode },
    );
  } catch {
    // a cache, not state: the next read parses again
  }
}

/**
 * The parse of the last trusted project lexicon `loadLexicon` merged, kept
 * beside the global lexicon (`project-parse-cache.json`, mode 0600) with the
 * exact text it came from and the sha256 of those bytes.
 *
 * A trusted project file cost the prompt hook its YAML parse and schema
 * validation (about 20 ms for 200 terms) and loading node:crypto to hash it
 * for the trust check (about 10 ms more) on every prompt, which put a
 * 2000-term global plus 200-term project lexicon over the 200 ms budget.
 *
 * Reuse is decided by the content, never by metadata: the entry is a hit
 * only when its `text`, encoded as UTF-8, is byte for byte the file just read
 * (comparing decoded text alone would let two byte strings that decode to
 * the same replacement characters match). For those bytes the stored
 * `sha256` is the value hashing them would give, so the trust check still
 * compares the pinned hash with the hash of the bytes being merged; the
 * cache only remembers a computation. It does not decide trust: the registry
 * is read and compared on every load as before, so an untrust, a re-pin or a
 * changed file is seen at once. The entry is only written for a file the
 * gate just found trusted, and only in the global config directory, where
 * `trust.json` itself lives: anyone able to forge the entry could equally
 * edit the registry, so it adds no new way in. `sum` (see `cacheChecksum`)
 * catches a damaged entry, not a forged one. A single entry, like the index
 * cache: alternating between two repos costs the parse, as before, and files
 * under PARSE_CACHE_MIN_BYTES are not cached.
 */
export const PROJECT_PARSE_CACHE_FILE_NAME = 'project-parse-cache.json';

/** Entry format of PROJECT_PARSE_CACHE_FILE_NAME. */
export const PROJECT_PARSE_CACHE_VERSION = 1;

/** A project file read for `loadLexicon`, and whether its parse came from the cache. */
interface ProjectRead {
  file: LexiconFile;
  /** The bytes read, when the parse did not come from the cache (so it may be written). */
  fresh?: { text: string };
}

/** A project file's bytes as read for `loadLexicon`, and the cached parse of exactly those bytes, if any. */
interface ProjectBytes {
  text: string;
  bytes: Buffer;
  cached?: { lexicon: Lexicon; sha256: string };
}

/** Read a project file and look its bytes up in the project parse cache; undefined when it does not exist. */
async function readProjectBytes(filePath: string, globalPath: string): Promise<ProjectBytes | undefined> {
  const read = await readLexiconText(filePath);
  if (read === undefined) return undefined;
  const out: ProjectBytes = { text: read.text, bytes: read.bytes };
  if (read.bytes.length >= PARSE_CACHE_MIN_BYTES) {
    try {
      const cached: unknown = JSON.parse(await fs.readFile(path.join(path.dirname(globalPath), PROJECT_PARSE_CACHE_FILE_NAME), 'utf8'));
      if (
        isPlainObject(cached) &&
        cached.version === PROJECT_PARSE_CACHE_VERSION &&
        cached.path === path.resolve(filePath) &&
        cached.text === read.text &&
        typeof cached.sha256 === 'string' &&
        /^[0-9a-f]{64}$/.test(cached.sha256) &&
        typeof cached.lexicon === 'string' &&
        cached.sum === cacheChecksum(`${cached.sha256}${cached.lexicon}`) &&
        Buffer.from(cached.text, 'utf8').equals(read.bytes)
      ) {
        const lexicon: unknown = JSON.parse(cached.lexicon);
        if (isPlainObject(lexicon) && Array.isArray(lexicon.terms)) out.cached = { lexicon: lexicon as unknown as Lexicon, sha256: cached.sha256 };
      }
    } catch {
      // missing, unreadable or damaged: parse for real
    }
  }
  return out;
}

/**
 * Remember on `file` the hash of the bytes in `read`: the cached sha256 when
 * the cache had those bytes, else the bytes themselves, hashed on demand.
 */
function rememberProjectBytes(file: LexiconFile, read: ProjectBytes): void {
  if (read.cached) rememberParsedHash(file, read.cached.sha256);
  else rememberParsedBytes(file, read.bytes);
}

/** The project `LexiconFile` for `read`: the cached parse, or the YAML parsed now (which throws for a bad file). */
function projectFileOf(filePath: string, read: ProjectBytes | undefined): ProjectRead {
  if (read === undefined) return { file: { path: filePath, scope: 'project', lexicon: emptyLexicon(), exists: false } };
  if (read.cached) {
    const file: LexiconFile = { path: filePath, scope: 'project', lexicon: read.cached.lexicon, exists: true };
    rememberProjectBytes(file, read);
    return { file };
  }
  const file = parseLexiconText(read.text, filePath, 'project');
  rememberProjectBytes(file, read);
  return { file, fresh: { text: read.text } };
}

/**
 * Record `file` (just parsed from `text`, and just found trusted) as the
 * project parse cache entry. Best effort, never throws.
 */
async function writeProjectParseCache(file: LexiconFile, text: string, globalPath: string): Promise<void> {
  if (Buffer.byteLength(text, 'utf8') < PARSE_CACHE_MIN_BYTES) return;
  try {
    const sha256 = await recalledParsedHash(file);
    if (sha256 === undefined) return;
    const lexiconJson = JSON.stringify(file.lexicon);
    await writeFileAtomic(
      path.join(path.dirname(globalPath), PROJECT_PARSE_CACHE_FILE_NAME),
      JSON.stringify({
        version: PROJECT_PARSE_CACHE_VERSION,
        path: path.resolve(file.path),
        sha256,
        text,
        sum: cacheChecksum(`${sha256}${lexiconJson}`),
        lexicon: lexiconJson,
      }),
      { mode: 0o600 },
    );
  } catch {
    // a cache, not state: the next load parses again
  }
}

/**
 * The compiled matcher index of the last lexicon the prompt hook matched
 * against, kept beside the global lexicon (`index-cache.json`) so a fresh
 * hook process does not rebuild it (about 55 ms for 2000 terms).
 *
 * The entry is keyed by `indexKey(lexicon)`: everything `buildIndex` reads
 * from the lexicon (canonicals, aliases, never-words, caseSensitive, the
 * matcher settings) and the index format version, compared as a string. So
 * it is valid for exactly the lexicon in hand, whichever files that lexicon
 * came from, and the trust gate is untouched: an untrusted project file is
 * not in `loaded.merged`, so it is not in the key either. A damaged file
 * fails JSON.parse, the key comparison or `deserializeIndex`'s type and range
 * checks, and costs a rebuild. The file is only ever written in the global lexicon's
 * directory, mode 0600, never in a project directory, and only for lexicons
 * of at least INDEX_CACHE_MIN_TERMS terms: a small index builds faster than
 * the file reads.
 */
export const INDEX_CACHE_FILE_NAME = 'index-cache.json';

/** Smallest merged lexicon (terms) whose index is cached. */
export const INDEX_CACHE_MIN_TERMS = 150;

/**
 * The matcher index for `loaded.merged`: from `index-cache.json` when the
 * entry there was built from the same matcher inputs, else built now (and,
 * past INDEX_CACHE_MIN_TERMS, written back best-effort). Never throws for a
 * cache problem; `write: false` skips the write-back.
 */
export async function loadMatcherIndex(
  loaded: Pick<LoadedLexicon, 'merged' | 'global'> & { project?: Pick<LexiconFile, 'path'> },
  opts: { write?: boolean } = {},
): Promise<MatcherIndex> {
  const lexicon = loaded.merged;
  if (lexicon.terms.length < INDEX_CACHE_MIN_TERMS) return buildIndex(lexicon);
  const cachePath = path.join(path.dirname(loaded.global.path), INDEX_CACHE_FILE_NAME);
  const key = indexKey(lexicon);
  const project = loaded.project ? path.resolve(loaded.project.path) : undefined;
  try {
    const text = await fs.readFile(cachePath, 'utf8');
    // Cheap rejections first: the key is a prefix of the file (see below), so
    // a different lexicon is told apart before anything is parsed.
    const head = indexCacheHead(key, project);
    if (text.startsWith(head)) {
      const cached: unknown = JSON.parse(text);
      if (isPlainObject(cached) && cached.version === INDEX_FORMAT_VERSION && cached.key === key) {
        const index = deserializeIndex(cached.index, lexicon);
        if (index) return index;
      }
    }
  } catch {
    // missing, unreadable or damaged: rebuild below
  }
  const index = buildIndex(lexicon);
  if (opts.write !== false) await writeIndexCache(cachePath, key, index, project);
  return index;
}

/**
 * The start of an entry's JSON up to and including its key:
 * `{"version":N,"project":"<path>","key":"..."` for a merge with a trusted
 * project file, `{"version":N,"key":"..."` for the global lexicon alone.
 */
function indexCacheHead(key: string, project: string | undefined): string {
  const head = JSON.stringify(project === undefined ? { version: INDEX_FORMAT_VERSION, key } : { version: INDEX_FORMAT_VERSION, project, key });
  return head.slice(0, -1);
}

/**
 * Replace the index cache entry at `cachePath`. `project` is the absolute
 * path of the trusted project file merged into the indexed lexicon, if any,
 * so a later write can rebuild the entry for the same merge (see
 * refreshIndexCache). Best effort, never throws.
 */
async function writeIndexCache(cachePath: string, key: string, index: MatcherIndex, project?: string): Promise<void> {
  try {
    // `version`, `project` and `key` lead the object so loadMatcherIndex's
    // prefix check works and indexCacheProject reads the project from the head.
    const out = JSON.stringify({ version: INDEX_FORMAT_VERSION, ...(project !== undefined ? { project } : {}), key, index: serializeIndex(index) });
    await writeFileAtomic(cachePath, out, { mode: 0o600 });
  } catch {
    // a cache, not state
  }
}

/**
 * Which merge the entry at `cachePath` indexes, read from the first bytes of
 * the file only (the whole entry is about 700 KB for 2000 terms, and parsing
 * it costs a write about 20 ms): the absolute path of the project file merged
 * in, `null` for the global lexicon alone, `undefined` when there is no entry
 * or its head is not one this version writes.
 */
async function indexCacheProject(cachePath: string): Promise<string | null | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(cachePath, 'r');
    const buf = Buffer.alloc(INDEX_CACHE_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.toString('utf8', 0, bytesRead);
    const m = /^\{"version":(\d+),(?:"project":("(?:[^"\\]|\\.)*"),)?"key":/.exec(head);
    if (!m || Number(m[1]) !== INDEX_FORMAT_VERSION) return undefined;
    if (m[2] === undefined) return null;
    const project: unknown = JSON.parse(m[2]);
    return typeof project === 'string' && path.isAbsolute(project) ? project : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Bytes of an index cache entry indexCacheProject reads: past any project path. */
const INDEX_CACHE_HEAD_BYTES = 8192;

/**
 * After a write to a lexicon file, rebuild an existing index cache entry for
 * the merge the next prompt will match against, so it reads the entry instead
 * of building the index (about 55 ms for 2000 terms, plus writing it back).
 *
 * The entry is single: the merge the hook (or `lexicon serve`, or an MCP
 * normalize) matched last, the global lexicon alone or with one trusted
 * project file. A write to the global file rebuilds it for that same merge,
 * reading the project path the entry records; a write to a project file
 * rebuilds it for the global lexicon merged with that file, since its repo is
 * where the next prompt is likely to be. Both go through `loadLexicon` and
 * `loadMatcherIndex`, exactly the hook's path, so the trust gate decides what
 * is merged: a project file that is not trusted (or no longer exists) is left
 * out, as the hook would leave it out, and a project-scope write left
 * untrusted changes nothing. An entry already keyed for the result is left as
 * it is. Nothing happens where there is no entry, so a user who never runs
 * the hook does not pay a build on every write. Best effort, never throws.
 *
 * Exported for the writers outside this module that replace a lexicon file
 * themselves or re-pin its trust afterwards (pack install and uninstall,
 * and so the registry's install, update and removal, `lexicon review` and
 * `lexicon edit`): they call it
 * once the file and its trust entry are final, as `addTerm` does. For a
 * global write whose entry indexes the global lexicon alone it rebuilds that
 * entry from the file on disk (and so refreshes the parse cache too), which
 * covers a file another program rewrote, such as the user's editor.
 */
export async function refreshIndexCache(written: { scope: TermScope; path: string }, opts: StoreOptions = {}): Promise<void> {
  try {
    const globalPath = written.scope === 'global' ? written.path : resolvePaths(opts).global;
    const cachePath = path.join(path.dirname(globalPath), INDEX_CACHE_FILE_NAME);
    if (!existsSync(cachePath)) return;
    const project = written.scope === 'project' ? path.resolve(written.path) : await indexCacheProject(cachePath);
    if (project === null) {
      const global = await readGlobalLexiconCached(globalPath);
      const merged = mergeLexicons(global.lexicon);
      // Below the threshold an entry is never written: leave the old one alone, as prebuildIndexCache does.
      if (merged.terms.length >= INDEX_CACHE_MIN_TERMS) await loadMatcherIndex({ merged, global });
      return;
    }
    if (typeof project !== 'string') return;
    const loaded = await loadLexicon({
      globalPath,
      cwd: path.dirname(project),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
    // A project write the trust gate leaves out of the merge changed nothing the hook matches.
    if (written.scope === 'project' && (loaded.project === undefined || path.resolve(loaded.project.path) !== project)) return;
    await loadMatcherIndex(loaded);
  } catch {
    // a cache, not state: the hook builds it instead
  }
}

/**
 * Pre-build the index cache for a global lexicon file this module just wrote
 * (`lexicon` is its parse). Without it, the first prompt after every write
 * rebuilt and wrote the index inside the hook: about 55 ms of build plus the
 * write, which put a 2000-term lexicon over the hook's 200 ms budget. A write
 * that already holds the parse pays only the build and the write here, once,
 * outside any prompt. When the entry there indexes the global lexicon merged
 * with a trusted project file, refreshIndexCache rebuilds it for that merge
 * instead; the entry is never written into a project directory. Below
 * INDEX_CACHE_MIN_TERMS nothing is written, matching loadMatcherIndex.
 *
 * It only refreshes an entry that is already there: one exists once the
 * hook, `lexicon serve` or an MCP normalize has matched against a lexicon this
 * size, so a user who never runs any of them does not pay a build (60 to
 * 100 ms for 2000 terms in a fresh process) on every `add`.
 */
async function prebuildIndexCache(filePath: string, lexicon: Lexicon): Promise<void> {
  const cachePath = path.join(path.dirname(filePath), INDEX_CACHE_FILE_NAME);
  if (!existsSync(cachePath)) return;
  const project = await indexCacheProject(cachePath);
  if (typeof project === 'string') return refreshIndexCache({ scope: 'global', path: filePath });
  if (lexicon.terms.length < INDEX_CACHE_MIN_TERMS) return;
  try {
    const merged = mergeLexicons(lexicon);
    await writeIndexCache(cachePath, indexKey(merged), buildIndex(merged));
  } catch {
    // a cache, not state: the hook builds it instead
  }
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
    const ordered = orderLexicon(file.lexicon);
    const existing = await readLexiconText(file.path).catch(() => undefined);
    const text =
      (existing && updateInPlace(existing.text, ordered)) ??
      `${header}\n\n${stringifyYaml(ordered, { lineWidth: 0 })}`;
    const readBack = assertReadsBack(text, file.path);
    await writeFileAtomic(file.path, text, { backup: true });
    // What is on disk now is what this wrote: writeAndTrust pins exactly that.
    if (file.scope === 'project') rememberParsedBytes(file, text);
    // The next loadLexicon (the prompt hook, usually) would otherwise parse
    // the YAML it just wrote, the slowest thing a hook can do: hand it the
    // parse this write already did.
    if (file.scope === 'global') {
      const mode = await fs.stat(file.path).then((st) => st.mode & 0o777, () => undefined);
      if (mode !== undefined) await writeParseCache(file.path, text, readBack, mode);
      // Same for the compiled matcher index the hook reads next.
      await prebuildIndexCache(file.path, readBack);
    }
  });
  file.exists = true;
}

/**
 * The file's existing text with `ordered` written into it, or undefined when
 * that text is not a lexicon document we can edit (a parse error, a non-map
 * root, a `terms` that is not a list).
 *
 * A lexicon file is often hand-written and committed (a project's
 * `.lexicon.yaml`), so re-serializing it from scratch on every `learn` or
 * `add` replaced its comments with our header, turned every `[a, b]` into a
 * block list and added a `never: []` to each term: one learned alias became a
 * whole-file diff. Editing the parsed document instead keeps comments, flow
 * style and key order wherever a value did not change; only the values that
 * did are rewritten, terms are matched by canonical, and removed keys and
 * terms are dropped.
 */
function updateInPlace(text: string, ordered: Record<string, unknown>): string | undefined {
  let doc: Document;
  try {
    doc = parseDocument(text, { prettyErrors: false });
  } catch {
    return undefined;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return undefined;
  const root = doc.contents;
  const terms = root.get('terms', true);
  if (terms !== undefined && terms !== null && !(isSeq(terms) || (isScalar(terms) && terms.value === null))) {
    return undefined;
  }
  const byCanonical = new Map<string, YAMLMap>();
  if (isSeq(terms)) {
    for (const item of terms.items) {
      if (!isMap(item)) return undefined;
      const canonical = item.get('canonical');
      if (typeof canonical === 'string' && !byCanonical.has(canonical.toLowerCase())) {
        byCanonical.set(canonical.toLowerCase(), item);
      }
    }
  }
  const { terms: newTerms, ...top } = ordered;
  updateMap(doc, root, top, ['terms']);
  const items = (newTerms as Record<string, unknown>[]).map((term) => {
    const node = byCanonical.get(String(term.canonical).toLowerCase());
    if (!node) return doc.createNode(term);
    byCanonical.delete(String(term.canonical).toLowerCase());
    updateMap(doc, node, term, []);
    return node;
  });
  if (isSeq(terms)) {
    terms.items = items;
  } else {
    root.set('terms', doc.createNode(items));
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

/** Make `node` hold `value`'s keys, rewriting only the entries whose value changed. */
function updateMap(doc: Document, node: YAMLMap, value: Record<string, unknown>, keep: string[]): void {
  for (const pair of [...node.items]) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key;
    if (typeof key === 'string' && !(key in value) && !keep.includes(key)) node.delete(key);
  }
  for (const [key, next] of Object.entries(value)) {
    const current = node.get(key, true);
    // An empty list the schema filled in (`never: []`) is not worth adding.
    if (current === undefined && Array.isArray(next) && next.length === 0) continue;
    if (isMap(current) && next !== null && typeof next === 'object' && !Array.isArray(next)) {
      updateMap(doc, current, next as Record<string, unknown>, []);
      continue;
    }
    const was = current === undefined ? undefined : isScalar(current) ? current.value : (current as { toJSON(): unknown }).toJSON();
    if (current !== undefined && JSON.stringify(was) === JSON.stringify(next)) continue;
    const created = doc.createNode(next);
    if (isSeq(current) && isSeq(created)) created.flow = current.flow;
    node.set(key, created);
  }
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
    const current = await readLexiconFileForWrite(file.path, file.scope);
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
function assertReadsBack(text: string, filePath: string): Lexicon {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: false });
  } catch (err) {
    throw new InputError(
      `Refusing to write lexicon at ${filePath}: the YAML it produced does not parse back: ${errorMessage(err)}`,
    );
  }
  try {
    return parseLexicon(raw ?? emptyLexicon());
  } catch (err) {
    throw new InputError(`Refusing to write lexicon at ${filePath}: ${errorMessage(err)}`);
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

  // With parseSkipped false the gate runs before the parse, on a stand-in
  // carrying the bytes just read (or their cached sha256), so an untrusted or
  // changed file costs no YAML parse. The parse that follows for a trusted
  // file is of those same bytes, and shares their hash.
  const gateFirst = opts.parseSkipped === false && !opts.includeUntrusted;
  let project: LexiconFile;
  let fresh: ProjectRead['fresh'];
  let projectTrust: TrustStatus | undefined;
  try {
    const read = await readProjectBytes(paths.project, paths.global);
    if (gateFirst && read !== undefined) {
      const probe: LexiconFile = { path: paths.project, scope: 'project', lexicon: emptyLexicon(), exists: true };
      rememberProjectBytes(probe, read);
      projectTrust = await isTrusted(probe, opts);
      if (projectTrust !== 'trusted') {
        return { merged: await hydrated(mergeLexicons(global.lexicon)), global, projectTrust, skippedProject: probe };
      }
      ({ file: project, fresh } = projectFileOf(paths.project, read));
      shareParsedHash(probe, project);
    } else {
      ({ file: project, fresh } = projectFileOf(paths.project, read));
    }
  } catch (err) {
    const placeholder: LexiconFile = { path: paths.project, scope: 'project', lexicon: emptyLexicon(), exists: true };
    const trust = projectTrust ?? (await isTrusted(placeholder, opts));
    if (trust === 'trusted' || opts.includeUntrusted) throw err;
    return { merged: await hydrated(mergeLexicons(global.lexicon)), global, projectTrust: trust, skippedProject: placeholder };
  }

  projectTrust ??= await isTrusted(project, opts);
  if (projectTrust === 'trusted' && fresh) await writeProjectParseCache(project, fresh.text, paths.global);
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
    // The first term holding each canonical (sameCanonical's key), so a
    // project term finds its global counterpart without a scan: a findIndex
    // per project term cost a 2000-term global and 200-term project merge
    // about 40 ms of every prompt, plus the garbage of the lowercased copies.
    const firstByKey = new Map<string, number>();
    terms.forEach((t, i) => {
      const k = canonicalKey(t.canonical);
      if (!firstByKey.has(k)) firstByKey.set(k, i);
    });
    for (const pt of project.terms) {
      const key = canonicalKey(pt.canonical);
      const idx = firstByKey.get(key) ?? -1;
      const replacement: Term = { ...pt, scope: pt.scope ?? 'project' };
      if (idx === -1) {
        firstByKey.set(key, terms.length);
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

/**
 * True when a project-scope write from `opts` would land in a project file
 * the user has already trusted: it exists and reads 'trusted' (registry
 * match, LEXICON_TRUST_ALL, or inside the global config dir). False for a
 * file that does not exist yet and for one that is untrusted or changed.
 *
 * The MCP tools ask this before a write: a trusted file takes the edit and
 * keeps its pin refreshed, as for any user edit, while anything else is
 * written with `leaveUntrusted`, because a model relaying a request is not
 * the user reviewing a project file. Checked outside the write lock; a file
 * that changes trust in between fails closed (the gate refuses a file that
 * is no longer trusted, and an unpinned write never pins).
 */
export async function projectWriteTrusted(opts: StoreOptions = {}): Promise<boolean> {
  const projectPath = projectWritePath(opts);
  if (!existsSync(projectPath)) return false;
  const status = await isTrusted({ path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true }, opts);
  return status === 'trusted';
}

/** Options `addTerm` and `addTerms` share. */
export type AddTermOptions = StoreOptions & {
  scope?: TermScope;
  merge?: boolean;
  /**
   * Aliases for a term this call creates with none of its own (the callers'
   * `suggestAliases` fallback). Ignored when the term already exists, so
   * adding a never word, phonetic, category or notes appends nothing.
   */
  defaultAliases?: readonly string[];
  /**
   * Write a project file without registering it as trusted, for a write
   * the user has not reviewed (an MCP tool writing a project file that is
   * not trusted yet, where a model chose the names). Nothing is pinned, so the trust gate has nothing to protect and
   * an existing untrusted or changed file may be written too; a file that
   * was trusted reads as 'changed' afterwards. Either way it is merged only
   * after the user runs `lexicon trust`. Ignored for the global file.
   */
  leaveUntrusted?: boolean;
};

/** `term` with a trimmed canonical and deduped aliases; throws on an empty canonical. */
function prepareIncoming(term: Term): Term {
  const canonical = term.canonical.trim();
  if (!canonical) throw new InputError('canonical must not be empty');
  return { ...term, canonical, aliases: dedupeAliases(term.aliases ?? [], canonical) };
}

/** Apply one prepared term to the in-memory `file` exactly as `addTerm` does; no IO. */
function mergeTermInto(file: LexiconFile, incoming: Term, scope: TermScope, opts: AddTermOptions): { term: Term; created: boolean } {
  const canonical = incoming.canonical;
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
    return { term: existing, created: false };
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
    return { term: replaced, created: false };
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
  return { term: created, created: true };
}

export async function addTerm(
  term: Term,
  opts: AddTermOptions = {},
): Promise<{ file: LexiconFile; term: Term; created: boolean }> {
  const scope: TermScope = opts.scope ?? 'global';
  // The trust gate stays ahead of every other check, as it was when this
  // resolved the file rather than the path.
  const targetPath = await resolveScopeWritePath(scope, opts);
  const incoming = prepareIncoming(term);

  // Read, edit and write inside one lock: a concurrent add that read the same
  // file before this one wrote would otherwise rename its own copy over the
  // top and take the new term with it.
  return withLexiconLock(targetPath, async () => {
    const file = await readLexiconFileForWrite(targetPath, scope);
    const result = mergeTermInto(file, incoming, scope, opts);
    await writeAddedFile(file, opts);
    return { file, ...result };
  });
}

/**
 * `addTerm` for several terms into one file: the same trust gate, merge rules
 * and lock, but one read and one write for the whole batch. Each term is
 * applied in order to the document the previous one produced, so the result
 * is what calling `addTerm` once per term would have written. Every canonical
 * is checked before anything is written. Used by `installLoadedPack`: one
 * read-parse-write per term made an 82-term pack take seconds, since each
 * write re-parses the whole file to edit it in place and to check it reads back.
 */
export async function addTerms(
  terms: readonly Term[],
  opts: AddTermOptions = {},
): Promise<{ file: LexiconFile; results: { term: Term; created: boolean }[] }> {
  const scope: TermScope = opts.scope ?? 'global';
  const targetPath = await resolveScopeWritePath(scope, opts);
  const incoming = terms.map(prepareIncoming);
  return withLexiconLock(targetPath, async () => {
    const file = await readLexiconFileForWrite(targetPath, scope);
    const results = incoming.map((t) => mergeTermInto(file, t, scope, opts));
    if (results.length > 0) await writeAddedFile(file, opts);
    return { file, results };
  });
}

function writeAddedFile(file: LexiconFile, opts: AddTermOptions): Promise<void> {
  return opts.leaveUntrusted ? writeLexiconFile(file) : writeAndTrust(file, opts);
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
  // Pin the bytes this write produced; a file rewritten by someone else since
  // is left unpinned (and so untrusted) rather than blessed.
  if (file.scope === 'project') {
    await trustProject(file.path, { ...opts, expectedSha256: await recalledParsedHash(file) });
    // Now that the trust entry says what the hook will merge.
    await refreshIndexCache(file, opts);
  }
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
      const file = await readLexiconFileForWrite(target.path, target.scope);
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
        await refreshIndexCache(file, opts);
      } else {
        await dropGlobalHits(canonical, opts);
      }
      return true;
    });
    if (removed) return true;
  }
  return false;
}

/** One loaded lexicon file that holds a term: its scope and path. */
export interface TermHolder {
  scope: TermScope;
  path: string;
}

/**
 * Every loaded file (project first, then global) whose terms include
 * `canonical`, compared case-insensitively as the store does. Only the
 * trusted, merged files are searched: `skippedProject` is never read here.
 * removeTerm edits one file, so a caller that removed a term uses this to
 * name a copy left in the other file instead of reporting it gone.
 */
export function termHolders(loaded: Pick<LoadedLexicon, 'global' | 'project'>, canonical: string): TermHolder[] {
  const holds = (file: LexiconFile | undefined): file is LexiconFile =>
    file?.lexicon.terms.some((t) => sameCanonical(t.canonical, canonical)) === true;
  return [loaded.project, loaded.global].filter(holds).map((f) => ({ scope: f.scope, path: f.path }));
}

/**
 * The skipped (untrusted or changed) project file, when its terms include
 * `canonical` (case-insensitive). Only a yes or no comes out of the untrusted
 * content: the result is the file's path and trust status, never a term.
 * A removal reports it because that copy wins the merge once the user trusts
 * the file, and it is never edited here: `removeTerm` refuses the file.
 */
export function untrustedTermHolder(
  loaded: Pick<LoadedLexicon, 'skippedProject' | 'projectTrust'>,
  canonical: string,
): { path: string; trust: 'untrusted' | 'changed' } | undefined {
  const skipped = loaded.skippedProject;
  if (!skipped || !skipped.lexicon.terms.some((t) => sameCanonical(t.canonical, canonical))) return undefined;
  return { path: skipped.path, trust: loaded.projectTrust === 'changed' ? 'changed' : 'untrusted' };
}

/**
 * The skipped (untrusted or changed) project file, when its copy of
 * `canonical` holds `alias` (both case-insensitive). The alias counterpart of
 * `untrustedTermHolder`: path and trust only, never a term. `remove --alias`
 * and `remove_term` with `alias` report it, because that copy keeps the
 * correction alive once the user trusts the file, and `removeAlias` never
 * edits it.
 */
export function untrustedAliasHolder(
  loaded: Pick<LoadedLexicon, 'skippedProject' | 'projectTrust'>,
  canonical: string,
  alias: string,
): { path: string; trust: 'untrusted' | 'changed' } | undefined {
  const skipped = loaded.skippedProject;
  const drop = alias.trim().toLowerCase();
  const term = skipped?.lexicon.terms.find((t) => sameCanonical(t.canonical, canonical));
  if (!skipped || !drop || !term || !term.aliases.some((a) => a.trim().toLowerCase() === drop)) return undefined;
  return { path: skipped.path, trust: loaded.projectTrust === 'changed' ? 'changed' : 'untrusted' };
}

/** What `removeAlias` changed: the term as it now reads, and every file it was dropped from. */
export interface RemoveAliasResult {
  /** The edited term (from the first file edited: project before global). */
  term: Term;
  /** Each file the alias was removed from, as written. */
  files: LexiconFile[];
}

/**
 * Drop one alias from one term, keeping the term and everything else on it.
 * Matching is case-insensitive for both the canonical and the alias.
 *
 * Without a scope the alias is removed from every file whose copy of the term
 * holds it (project, then global): the merged lexicon unions aliases across
 * both, so removing it from only one would leave the correction in place.
 * With a scope only that file is touched. Each file is edited inside its own
 * lock; a project file must already be trusted (ProjectTrustError otherwise,
 * thrown before anything is written) and is re-pinned after the edit, as
 * removeTerm does.
 *
 * Throws when the alias is empty or is the canonical spelling itself, when no
 * searched file holds the term, and when the term holds no such alias.
 */
export async function removeAlias(
  canonical: string,
  alias: string,
  opts: StoreOptions & { scope?: TermScope } = {},
): Promise<RemoveAliasResult> {
  const wanted = canonical.trim();
  const drop = alias.trim();
  if (!wanted) throw new InputError('canonical must not be empty');
  if (!drop) throw new InputError('alias must not be empty');
  if (sameCanonical(wanted, drop)) {
    throw new InputError(`"${drop}" is the canonical spelling of "${wanted}", not an alias; remove the term instead`);
  }

  let termFound = false;
  let firstTerm: Term | undefined;
  const files: LexiconFile[] = [];
  for (const target of candidatePaths(opts, opts.scope)) {
    await withLexiconLock(target.path, async () => {
      const file = await readLexiconFileForWrite(target.path, target.scope);
      if (!file.exists) return;
      const term = findTerm(file.lexicon, wanted);
      if (!term) return;
      termFound = true;
      const remaining = term.aliases.filter((a) => a.trim().toLowerCase() !== drop.toLowerCase());
      if (remaining.length === term.aliases.length) return;
      if (file.scope === 'project') await assertProjectWritable(file.path, opts);
      term.aliases = remaining;
      await writeLexiconFile(file);
      // The user's own edit must not flip an already-trusted file to 'changed'.
      if (file.scope === 'project') {
        await refreshTrust(file.path, opts);
        await refreshIndexCache(file, opts);
      }
      files.push(file);
      firstTerm ??= term;
    });
  }
  if (firstTerm) return { term: firstTerm, files };
  const where = opts.scope ? `the ${opts.scope} lexicon` : 'the global or project lexicon';
  if (!termFound) throw new InputError(`no term "${wanted}" in ${where}`);
  throw new InputError(`"${drop}" is not an alias of "${wanted}" in ${where}`);
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
 * before the file is locked or read, unless `opts.leaveUntrusted` says the
 * write will not pin the file.
 *
 * Exported because a caller that performs several writes as one operation has
 * to lock the same path this resolves, and resolving it a second way would be
 * a second chance to disagree. `installPack` is the case: it adds every term
 * and then rewrites `settings.packs`, and those have to be one transaction.
 */
export async function resolveScopeWritePath(scope: TermScope, opts: StoreOptions & { leaveUntrusted?: boolean }): Promise<string> {
  if (scope === 'global') return resolvePaths(opts).global;
  const projectPath = projectWritePath(opts);
  // An unpinned write has no trust to protect (see addTerm's leaveUntrusted).
  if (!opts.leaveUntrusted) await assertProjectWritable(projectPath, opts);
  return projectPath;
}

/** The project file a project-scope write targets: the one found by the walk, else `.lexicon.yaml` at the git root. */
function projectWritePath(opts: StoreOptions): string {
  return resolvePaths(opts).project ?? defaultProjectPath(opts.cwd ?? process.cwd());
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

/** What sameCanonical compares: two canonicals are the same term when their keys are equal. */
function canonicalKey(canonical: string): string {
  return canonical.trim().toLowerCase();
}

function sameCanonical(a: string, b: string): boolean {
  return canonicalKey(a) === canonicalKey(b);
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

