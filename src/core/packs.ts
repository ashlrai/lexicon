/**
 * Starter term packs: curated lexicons shipped in `packs/*.yaml` at the
 * package root (developer, ai, business, voice-tools) that a new user installs
 * with one command instead of typing sixty names. A pack is a plain lexicon
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
import { z } from 'zod';
import { parseLexicon } from './schema.js';
import { ProjectTrustError, addTerm, readLexiconFile, resolvePaths, writeLexiconFile } from './store.js';
import type { StoreOptions } from './store.js';
import { isTrusted, refreshTrust } from './trust.js';
import type { Lexicon, LexiconFile, LoadedLexicon, Term, TermScope } from './types.js';

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
}

export interface UninstallPackResult {
  pack: PackInfo;
  /** Canonicals removed. */
  removed: string[];
  /** Pack terms left in place because the user edited them (hits, extra aliases or never-words). */
  kept: string[];
  /** Every lexicon file that was rewritten. */
  files: string[];
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
  terms: z.array(z.unknown()).min(1, 'a pack needs at least one term'),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

async function packNames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .filter((n) => PACK_NAME_RE.test(n))
    .sort();
}

function parsePack(raw: unknown, file: string, expectedName: string): Pack {
  const head = PackFileSchema.safeParse(raw);
  if (!head.success) {
    const lines = head.error.issues.map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`);
    throw new Error(`Invalid pack at ${file}:\n${lines.join('\n')}`);
  }
  if (head.data.name !== expectedName) {
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
    terms: lexicon.terms.length,
    aliases: lexicon.terms.reduce((n, t) => n + t.aliases.length, 0),
    path: file,
    lexicon,
  };
}

/** Read and validate one pack. Throws `PackNotFoundError` for an unknown name and a readable error for a broken file. */
export async function loadPack(name: string, opts: PackOptions = {}): Promise<Pack> {
  const dir = packsDir(opts);
  if (!PACK_NAME_RE.test(name)) throw new PackNotFoundError(name, await packNames(dir));
  const file = path.join(dir, `${name}.yaml`);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) throw new PackNotFoundError(name, await packNames(dir));
    throw err;
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`Invalid pack at ${file}: ${errorMessage(err)}`);
  }
  return parsePack(raw, file, name);
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
 * Rewrite a file's `settings.packs`. Empty lists (the parser's `protectedWords: []`
 * default, an emptied `packs`) are dropped, and so is an empty `settings`, so a
 * file that only ever held packs goes back to how it looked before.
 * Re-pins a project file's trust.
 */
async function writePacksSetting(file: LexiconFile, packs: string[], opts: StoreOptions): Promise<void> {
  const settings: Record<string, unknown> = { ...(file.lexicon.settings ?? {}), packs };
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || (Array.isArray(value) && value.length === 0)) delete settings[key];
  }
  if (Object.keys(settings).length > 0) file.lexicon.settings = settings as LexiconFile['lexicon']['settings'];
  else delete file.lexicon.settings;
  await writeLexiconFile(file);
  if (file.scope === 'project') await refreshTrust(file.path, opts);
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
  opts: StoreOptions & PackOptions & { scope?: TermScope } = {},
): Promise<InstallPackResult> {
  const pack = await loadPack(name, opts);
  const scope: TermScope = opts.scope ?? 'global';
  const storeOpts: StoreOptions = { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) };
  let added = 0;
  let merged = 0;
  let file: LexiconFile | undefined;
  for (const term of pack.lexicon.terms) {
    const incoming: Term = { ...term, aliases: [...term.aliases], source: 'pack' };
    if (term.never) incoming.never = [...term.never];
    const result = await addTerm(incoming, { ...storeOpts, scope });
    file = result.file;
    if (result.created) added += 1;
    else merged += 1;
  }
  if (!file) throw new Error(`pack "${name}" has no terms`);
  const packs = dedupe([...(file.lexicon.settings?.packs ?? []), name]);
  await writePacksSetting(file, packs, storeOpts);
  return { pack: info(pack), added, merged, path: file.path, scope };
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
 */
export async function uninstallPack(
  name: string,
  opts: StoreOptions & PackOptions & { scope?: TermScope } = {},
): Promise<UninstallPackResult> {
  const pack = await loadPack(name, opts);
  const storeOpts: StoreOptions = { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) };
  const packTerms = new Map(pack.lexicon.terms.map((t) => [lower(t.canonical), t]));
  const paths = resolvePaths(storeOpts);
  const files: LexiconFile[] = [];
  if (opts.scope !== 'global' && paths.project) files.push(await readLexiconFile(paths.project, 'project'));
  if (opts.scope !== 'project') files.push(await readLexiconFile(paths.global, 'global'));

  const removed: string[] = [];
  const kept: string[] = [];
  const written: string[] = [];
  for (const file of files) {
    if (!file.exists) continue;
    const listed = (file.lexicon.settings?.packs ?? []).includes(name);
    const remaining = file.lexicon.terms.filter((term) => {
      const packTerm = packTerms.get(lower(term.canonical));
      if (!packTerm || term.source !== 'pack') return true;
      if ((term.hits ?? 0) > 0 || hasExtra(term.aliases, packTerm.aliases) || hasExtra(term.never, packTerm.never)) {
        kept.push(term.canonical);
        return true;
      }
      removed.push(term.canonical);
      return false;
    });
    if (remaining.length === file.lexicon.terms.length && !listed) continue;
    if (file.scope === 'project') {
      const status = await isTrusted(file, storeOpts);
      if (status !== 'trusted') throw new ProjectTrustError(file.path, status);
    }
    file.lexicon.terms = remaining;
    await writePacksSetting(file, (file.lexicon.settings?.packs ?? []).filter((p) => p !== name), storeOpts);
    written.push(file.path);
  }
  return { pack: info(pack), removed, kept, files: written };
}
