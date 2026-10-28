/**
 * Starter term packs: curated lexicons shipped in `packs/*.yaml` at the
 * package root (developer, ai, business, voice-tools) that a new user installs
 * with one command instead of typing dozens of names. A pack is a plain lexicon
 * file plus `name`, `title` and `description`; its terms are added with
 * `addTerm` and `source: 'pack'`, so a term the user already has keeps its own
 * spelling, aliases and source and only gains the pack's aliases. The names of
 * the installed packs live in `settings.packs` of the file they went into.
 *
 * Uninstalling removes the pack's terms from that file unless the user has
 * edited them since (recorded hits, aliases or never-words beyond the pack's):
 * those stay and are reported as `kept`.
 *
 * Pack names are validated against PACK_NAME_RE before touching the filesystem,
 * so a name from an HTTP route or an MCP call can never leave the packs dir.
 */
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { parseLexicon } from './schema.js';
import { ProjectTrustError, addTerms, effectiveHits, readHitsFor, readLexiconFile, refreshIndexCache, resolveScopeWritePath, resolvePaths, withLexiconLock, writeLexiconFile } from './store.js';
import type { StoreOptions } from './store.js';
import { isTrusted, parsedContentHash, refreshTrust } from './trust.js';
import type { Lexicon, LexiconFile, LoadedLexicon, Term, TermScope } from './types.js';
import { errorMessage, isEnoent } from '../util/errors.js';
import { isRecord } from '../util/json.js';

export const PACKS_DIR_NAME = 'packs';
/** Lowercase letters, digits and dashes only: a file name and nothing else. */
export const PACK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Packs `lexicon setup` checks by default; the rest (business) are offered unchecked. */
export const DEFAULT_PACKS: readonly string[] = ['developer', 'ai', 'voice-tools'];

export interface PackInfo {
  name: string;
  title: string;
  description: string;
  version: 1;
  /** Pack author (community packs); empty for the vendored four. */
  author: string;
  /** Author homepage (community packs); empty when unset. */
  homepage: string;
  /** Term count. */
  terms: number;
  /** Alias count across every term. */
  aliases: number;
  /** The YAML file the pack was read from. */
  path: string;
}

export interface Pack extends PackInfo {
  lexicon: Lexicon;
}

export interface PackOptions {
  /** Directory holding the pack files. Default: `<package root>/packs`. */
  dir?: string;
}

export interface InstallPackResult {
  pack: PackInfo;
  /** Terms created. */
  added: number;
  /** Terms that already existed and only gained aliases. */
  merged: number;
  /** The lexicon file written. */
  path: string;
  scope: TermScope;
  /**
   * True when the install left the file byte for byte as it was: the pack was
   * already recorded there and every term and alias was already in it.
   * `installPack` and `installLoadedPack` always set it.
   */
  alreadyInstalled?: boolean;
}

export interface UninstallPackResult {
  pack: PackInfo;
  /** Canonicals removed. */
  removed: string[];
  /** Pack terms left in place because the user edited them (hits, extra aliases or never-words). */
  kept: string[];
  /** Pack terms left in place because another pack the same file records still has them. */
  shared: string[];
  /** Every lexicon file that was rewritten. */
  files: string[];
  /** The scoped registry record and cached pack were removed (or would be in a dry run). */
  registryRemoved?: boolean;
}

/**
 * The sentence for an install that left the file as it was
 * (`alreadyInstalled`): `<name> is already installed in <path> (N terms,
 * M aliases); nothing was added`, the counts being the pack's own. `lexicon
 * pack add`, MCP `add_pack` and serve `POST /packs/:name` all say it, so a
 * reinstall never reads `0 added, N merged`. `show` (default identity) is
 * applied to the name and the path, as the CLI's terminal sanitizer is.
 */
export function packAlreadyInstalledNote(
  name: string,
  result: Pick<InstallPackResult, 'path'> & { pack: Pick<PackInfo, 'terms' | 'aliases'> },
  show: (s: string) => string = (s) => s,
): string {
  const { terms, aliases } = result.pack;
  return `${show(name)} is already installed in ${show(result.path)} (${terms} term${terms === 1 ? '' : 's'}, ${aliases} ${aliases === 1 ? 'alias' : 'aliases'}); nothing was added`;
}

/** Thrown by `loadPack` for a name that is not a pack file; HTTP callers map it to 404. */
export class PackNotFoundError extends Error {
  readonly pack: string;

  constructor(name: string, available: readonly string[]) {
    super(`unknown pack "${name}" (available: ${available.length > 0 ? available.join(', ') : 'none'})`);
    this.name = 'PackNotFoundError';
    this.pack = name;
  }
}

const PACKAGE_NAME = '@ashlr/lexicon';

const PackFileSchema = z.object({
  name: z.string().regex(PACK_NAME_RE, 'pack name must be lowercase letters, digits and dashes'),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  version: z.literal(1).default(1),
  /** Community packs name their author; the vendored four leave it empty. */
  author: z.string().trim().max(40).default(''),
  homepage: z.string().trim().max(200).default(''),
  terms: z.array(z.unknown()).min(1, 'a pack needs at least one term'),
});

/**
 * Walk up from `from` (a file URL or path) to the directory whose package.json
 * is `@ashlr/lexicon`. Works from src/core, dist/core and the plugin/ bundles.
 */
export function findPackageRoot(from: string = import.meta.url): string | undefined {
  let dir = from.startsWith('file:') ? path.dirname(fileURLToPath(from)) : path.resolve(from);
  for (;;) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (isRecord(parsed) && parsed.name === PACKAGE_NAME) return dir;
    } catch {
      // not here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The directory the pack files are read from. */
export function packsDir(opts: PackOptions = {}): string {
  if (opts.dir) return path.resolve(opts.dir);
  const root = findPackageRoot();
  if (!root) throw new Error(`could not locate the ${PACKAGE_NAME} package root (no package.json above ${fileURLToPath(import.meta.url)})`);
  return path.join(root, PACKS_DIR_NAME);
}

async function packNames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .filter((n) => PACK_NAME_RE.test(n))
    .sort();
}

function parsePack(raw: unknown, file: string, expectedName?: string): Pack {
  const head = PackFileSchema.safeParse(raw);
  if (!head.success) {
    const lines = head.error.issues.map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`);
    throw new Error(`Invalid pack at ${file}:\n${lines.join('\n')}`);
  }
  if (expectedName !== undefined && head.data.name !== expectedName) {
    throw new Error(`Invalid pack at ${file}: name "${head.data.name}" does not match the file name "${expectedName}"`);
  }
  let lexicon: Lexicon;
  try {
    lexicon = parseLexicon({ version: head.data.version, terms: head.data.terms });
  } catch (err) {
    throw new Error(`Invalid pack at ${file}: ${errorMessage(err)}`);
  }
  const seen = new Set<string>();
  for (const term of lexicon.terms) {
    const key = term.canonical.toLowerCase();
    if (seen.has(key)) throw new Error(`Invalid pack at ${file}: "${term.canonical}" is listed twice`);
    seen.add(key);
  }
  return {
    name: head.data.name,
    title: head.data.title,
    description: head.data.description,
    version: 1,
    author: head.data.author,
    homepage: head.data.homepage,
    terms: lexicon.terms.length,
    aliases: lexicon.terms.reduce((n, t) => n + t.aliases.length, 0),
    path: file,
    lexicon,
  };
}

/** Read and validate one pack file. `expectedName` (default: the file's base name) must match the pack's `name`. */
export async function loadPackFile(file: string, expectedName?: string): Promise<Pack> {
  const name = expectedName ?? path.basename(file, '.yaml');
  if (!PACK_NAME_RE.test(name)) throw new PackNotFoundError(name, []);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) throw new PackNotFoundError(name, []);
    throw err;
  }
  return parsePackText(text, file, name);
}

/**
 * Parse and validate pack text that is already in hand (a downloaded file,
 * an editor buffer). `file` names the source in errors; `expectedName`, when
 * given, must match the pack's `name` (omit it to validate a pack file under
 * any file name, as `lexicon pack validate` does).
 */
export function parsePackText(text: string, file: string, expectedName?: string): Pack {
  let raw: unknown;
  try {
    raw = parseYaml(text, { prettyErrors: false }); // see readLexiconFile: never quote the source line back
  } catch (err) {
    throw new Error(`Invalid pack at ${file}: ${errorMessage(err)}`);
  }
  return parsePack(raw, file, expectedName);
}

/** Read and validate one pack. Throws `PackNotFoundError` for an unknown name and a readable error for a broken file. */
export async function loadPack(name: string, opts: PackOptions = {}): Promise<Pack> {
  const dir = packsDir(opts);
  if (!PACK_NAME_RE.test(name)) throw new PackNotFoundError(name, await packNames(dir));
  const file = path.join(dir, `${name}.yaml`);
  try {
    return await loadPackFile(file, name);
  } catch (err) {
    if (err instanceof PackNotFoundError) throw new PackNotFoundError(name, await packNames(dir));
    throw err;
  }
}

function info(pack: Pack): PackInfo {
  const { lexicon: _lexicon, ...rest } = pack;
  return rest;
}

/** Every pack in the packs directory, sorted by name. A broken pack file throws. */
export async function listPacks(opts: PackOptions = {}): Promise<PackInfo[]> {
  const dir = packsDir(opts);
  const out: PackInfo[] = [];
  for (const name of await packNames(dir)) out.push(info(await loadPack(name, opts)));
  return out;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * Names of the packs installed into the loaded files: `settings.packs` of the
 * global file and of the merged project file, in that order. Read per file,
 * not from `merged.settings`, where a project list would shadow the global one.
 */
export function installedPacks(loaded: LoadedLexicon): string[] {
  return dedupe([...(loaded.global.lexicon.settings?.packs ?? []), ...(loaded.project?.lexicon.settings?.packs ?? [])]);
}

/**
 * Rewrite a file's `settings.packs`. Empty lists (an explicit `protectedWords: []`,
 * an emptied `packs`) are dropped, and so is an empty `settings`, so a
 * file that only ever held packs goes back to how it looked before.
 * Re-pins a project file's trust and refreshes the index cache for it, unless
 * `leaveUntrusted` (the install left the file unpinned, and refreshTrust
 * would bless a changed file).
 */
async function writePacksSetting(file: LexiconFile, packs: string[], opts: StoreOptions, leaveUntrusted = false): Promise<void> {
  const settings: Record<string, unknown> = { ...(file.lexicon.settings ?? {}), packs };
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete settings[key];
  }
  if (Object.keys(settings).length > 0) file.lexicon.settings = settings as LexiconFile['lexicon']['settings'];
  else delete file.lexicon.settings;
  if (opts.dryRun) return;
  await writeLexiconFile(file);
  if (file.scope === 'project' && !leaveUntrusted) {
    await refreshTrust(file.path, { ...opts, expectedSha256: await parsedContentHash(file) });
    // Now that the trust entry says what the hook will merge (see addTerm).
    await refreshIndexCache(file, opts);
  }
}

async function readTextIfAny(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

/**
 * Install an already-loaded pack. `recordAs` is the name recorded in the
 * file's `settings.packs`: the plain pack name for the vendored four, the
 * `author/name` ref for registry packs. See `installPack` for the semantics;
 * this is the half the registry reuses after downloading and verifying a
 * community pack file.
 */
export async function installLoadedPack(
  pack: Pack,
  recordAs: string,
  opts: StoreOptions & PackOptions & {
    scope?: TermScope;
    /** Write a project file without registering it as trusted (addTerm's `leaveUntrusted`); nothing is pinned or re-pinned. */
    leaveUntrusted?: boolean;
  } = {},
): Promise<InstallPackResult> {
  const scope: TermScope = opts.scope ?? 'global';
  const leaveUntrusted = opts.leaveUntrusted === true;
  const storeOpts: StoreOptions = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}),
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  };
  // One lock around the whole install, not one per term. `addTerms` takes
  // the same lock and the lock is re-entrant, so this costs nothing extra and
  // closes the window that mattered: `file` below is the snapshot `addTerms`
  // wrote, and `writePacksSetting` rewrites the whole document from it. A
  // term another writer added in between was read by nobody here and would
  // be renamed away by that final write, with the pack still reporting
  // success. The trust gate runs in `resolveScopeWritePath`, ahead of the lock.
  //
  // `addTerms` rather than one `addTerm` per term: each write re-parses the
  // whole file twice (to edit it in place and to check it reads back), so a
  // per-term loop was quadratic in the file size and an 82-term pack took
  // seconds. One read and one write give the same document.
  const targetPath = await resolveScopeWritePath(scope, { ...storeOpts, leaveUntrusted });
  const apply = async () => {
    const incoming = pack.lexicon.terms.map((term) => {
      const t: Term = { ...term, aliases: [...term.aliases], source: 'pack' };
      if (term.never) t.never = [...term.never];
      return t;
    });
    if (incoming.length === 0) throw new Error(`pack "${pack.name}" has no terms`);
    // The bytes before and after say whether the install changed anything:
    // `merged` counts every term the file already had, gained alias or not.
    const before = await readTextIfAny(targetPath);
    const { file, results } = await addTerms(incoming, { ...storeOpts, scope, leaveUntrusted });
    const added = results.filter((r) => r.created).length;
    const merged = results.length - added;
    const packs = dedupe([...(file.lexicon.settings?.packs ?? []), recordAs]);
    if (opts.dryRun) {
      // No bytes were written, so the before/after byte compare cannot speak:
      // "already installed" is what it would have meant, every term unchanged
      // and the pack already recorded.
      const alreadyInstalled = before !== undefined && results.every((r) => r.unchanged === true) && packs.length === (file.lexicon.settings?.packs ?? []).length;
      return { pack: info(pack), added, merged, path: file.path, scope, alreadyInstalled };
    }
    await writePacksSetting(file, packs, storeOpts, leaveUntrusted);
    const alreadyInstalled = before !== undefined && before === (await readTextIfAny(file.path));
    return { pack: info(pack), added, merged, path: file.path, scope, alreadyInstalled };
  };
  return opts.dryRun ? apply() : withLexiconLock(targetPath, apply);
}

/**
 * Add every term of a pack to the global (default) or project lexicon through
 * `addTerm` with `source: 'pack'`: a term the user already has keeps its own
 * fields and only gains the pack's aliases (and never-words); new terms are
 * created. Then the pack name is recorded in that file's `settings.packs`.
 * Idempotent: a second install adds nothing. Project scope goes through the
 * same trust gate as any other project write (ProjectTrustError).
 */
export async function installPack(
  name: string,
  opts: StoreOptions & PackOptions & { scope?: TermScope; leaveUntrusted?: boolean } = {},
): Promise<InstallPackResult> {
  return installLoadedPack(await loadPack(name, opts), name, opts);
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

/** True when `have` holds a value (case-insensitive) that `pack` does not. */
function hasExtra(have: readonly string[] | undefined, pack: readonly string[] | undefined): boolean {
  const known = new Set((pack ?? []).map(lower));
  return (have ?? []).some((v) => !known.has(lower(v)));
}

/**
 * Remove a pack's terms from the project file (when one exists) and the global
 * file, or from the one `scope` names. Only terms with `source: 'pack'` whose
 * canonical is in the pack are candidates; a candidate the user has edited
 * since (hits > 0, or aliases / never-words beyond the pack's) is kept and
 * listed in `kept`. The pack name is dropped from `settings.packs` either way.
 *
 * Each file is read, decided about and written inside its own lock, and the
 * files are taken one at a time. Both halves matter.
 *
 * Reading outside the lock was the defect. This read the file, decided which
 * terms survived, read the hits sidecar, and only then wrote, so a
 * `lexicon add` that landed anywhere in that window was read by nobody here
 * and was renamed away by the write, with the uninstall reporting success.
 * Thirteen of thirteen concurrent runs lost the racing term. The locked
 * `removeTerm` under the same conditions either keeps the write or fails
 * loudly, which is the behaviour this now has.
 *
 * One at a time, rather than one lock around both, because this is the only
 * operation that touches the project file and the global file together. Two
 * locks held at once is how an ordering mistake becomes a wait that never
 * ends, and there is nothing to gain here: the two files are independent
 * documents and `removeTerm` has always walked them the same way.
 */
/**
 * The canonicals (lowercased) of the packs `names` from one file's
 * `settings.packs`: a vendored pack from the packs directory, a community
 * ref from its checksum-verified cache in `scope`'s registry directory. A
 * pack that cannot be read contributes nothing, so it never blocks a removal.
 */
async function canonicalsOfPacks(names: readonly string[], scope: TermScope, opts: StoreOptions & PackOptions): Promise<Set<string>> {
  const out = new Set<string>();
  for (const name of names) {
    try {
      let canonicals: readonly string[] | undefined;
      if (name.includes('/')) {
        // Imported when needed: registry.ts imports this module, and its
        // top-level schemas read PACK_NAME_RE as it loads.
        const { cachedPackCanonicals } = await import('./registry.js');
        canonicals = await cachedPackCanonicals(name, { ...opts, scope });
      } else {
        canonicals = (await loadPack(name, opts)).lexicon.terms.map((t) => t.canonical);
      }
      for (const c of canonicals ?? []) out.add(lower(c));
    } catch {
      // unreadable or unknown: nothing to keep for it
    }
  }
  return out;
}

/**
 * Remove an already-loaded pack. `recordAs` is the name dropped from the
 * files' `settings.packs` (the plain name for vendored packs, the
 * `author/name` ref for registry ones). See `uninstallPack` for the
 * semantics; the registry reuses this after resolving the community pack
 * file from its cache or a fresh download.
 */
export async function uninstallLoadedPack(
  pack: Pack,
  recordAs: string,
  opts: StoreOptions & PackOptions & { scope?: TermScope } = {},
): Promise<UninstallPackResult> {
  const storeOpts: StoreOptions = {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}),
    ...(opts.dryRun === true ? { dryRun: true } : {}),
  };
  const packTerms = new Map(pack.lexicon.terms.map((t) => [lower(t.canonical), t]));
  const paths = resolvePaths(storeOpts);
  const targets: { path: string; scope: TermScope }[] = [];
  if (opts.scope !== 'global' && paths.project) targets.push({ path: paths.project, scope: 'project' });
  if (opts.scope !== 'project') targets.push({ path: paths.global, scope: 'global' });

  const removed: string[] = [];
  const kept: string[] = [];
  const shared: string[] = [];
  const written: string[] = [];
  for (const target of targets) {
    await withLexiconLock(target.path, async () => {
      const file = await readLexiconFile(target.path, target.scope);
      if (!file.exists) return;
      const listed = (file.lexicon.settings?.packs ?? []).includes(recordAs);
      // A term another installed pack also has is that pack's too: removing
      // it here took it from a pack that stays installed.
      const others = await canonicalsOfPacks((file.lexicon.settings?.packs ?? []).filter((p) => p !== recordAs), target.scope, { ...storeOpts, ...(opts.dir !== undefined ? { dir: opts.dir } : {}) });
      // `file` is about to be written back, so its terms have to stay exactly as
      // they are on disk; a term's usage count is not on disk any more, it is in
      // this user's sidecar. Read it alongside rather than into the term.
      const hits = await readHitsFor(file, storeOpts);
      const remaining = file.lexicon.terms.filter((term) => {
        const packTerm = packTerms.get(lower(term.canonical));
        if (!packTerm || term.source !== 'pack') return true;
        if (others.has(lower(term.canonical))) {
          shared.push(term.canonical);
          return true;
        }
        if (effectiveHits(term, hits) > 0 || hasExtra(term.aliases, packTerm.aliases) || hasExtra(term.never, packTerm.never)) {
          kept.push(term.canonical);
          return true;
        }
        removed.push(term.canonical);
        return false;
      });
      if (remaining.length === file.lexicon.terms.length && !listed) return;
      if (file.scope === 'project') {
        const status = await isTrusted(file, storeOpts);
        if (status !== 'trusted') throw new ProjectTrustError(file.path, status);
      }
      file.lexicon.terms = remaining;
      if (!opts.dryRun) await writePacksSetting(file, (file.lexicon.settings?.packs ?? []).filter((p) => p !== recordAs), storeOpts);
      written.push(file.path);
    });
  }
  return { pack: info(pack), removed, kept, shared, files: written };
}

/**
 * Remove a pack's terms from the project file (when one exists) and the global
 * file, or from the one `scope` names. Only terms with `source: 'pack'` whose
 * canonical is in the pack are candidates; a candidate the user has edited
 * since (hits > 0, or aliases / never-words beyond the pack's) is kept and
 * listed in `kept`. The pack name is dropped from `settings.packs` either way.
 *
 * Each file is read, decided about and written inside its own lock, and the
 * files are taken one at a time. Both halves matter. See `uninstallLoadedPack`.
 */
export async function uninstallPack(
  name: string,
  opts: StoreOptions & PackOptions & { scope?: TermScope } = {},
): Promise<UninstallPackResult> {
  return uninstallLoadedPack(await loadPack(name, opts), name, opts);
}
