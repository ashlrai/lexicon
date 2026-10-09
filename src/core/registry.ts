/**
 * Community pack registry (git-based MVP): publish and install packs without
 * funneling every one through this repo's `packs/` directory and a
 * maintainer's merge queue.
 *
 * The registry is an index file, not a service. Anyone hosts one: a YAML file
 * listing packs (`registry/index.example.yaml` documents the format), kept in
 * a git repo, pointed at with `--registry <path-or-url>`. The shipped four
 * packs stay vendored and curated; everything else is addressed
 * `<author>/<name>` and fetched on demand.
 *
 * The trust story, stated plainly: installed pack terms land in the user's
 * lexicon file, which reaches model context on every hooked prompt, so a
 * malicious pack is a prompt-injection delivery vehicle with a friendly name.
 * Community packs therefore do not install like the vendored four:
 *
 *   - Checksums are pinned at install time in `registry.json` beside the
 *     global lexicon; `pack update` re-checks them and an update is
 *     re-approved, never silent.
 *   - `pack add <author>/<name>` shows the full term list before writing
 *     (and refuses to proceed on a non-terminal without `--yes`).
 *   - `validateCommunityPack` enforces at publish time the ordinary-word
 *     guard the vendored packs obey: a community pack may not teach the
 *     matcher that an everyday English word is a name.
 *
 * No hosted accounts, no sync service: the index is read over plain HTTPS or
 * from a local file, which keeps the README's non-goals intact.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { HARVEST_STOPLIST } from './harvest.js';
import { PACK_NAME_RE, installLoadedPack, loadPackFile, parsePackText, uninstallLoadedPack } from './packs.js';
import type { InstallPackResult, Pack, UninstallPackResult } from './packs.js';
import { resolvePaths } from './store.js';
import type { StoreOptions } from './store.js';
import type { TermScope } from './types.js';
import { STOPLIST } from './stoplist.js';
import { errorMessage, isEnoent } from '../util/errors.js';

/** `author/name`, with an optional `@version` pin for installs. */
export const REGISTRY_REF_RE = /^([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9-]{0,63})(?:@([A-Za-z0-9][A-Za-z0-9._-]{0,31}))?$/;

export interface RegistryRef {
  author: string;
  name: string;
  /** The `author/name` address, without any version pin. */
  ref: string;
  /** Version pin from `author/name@version`, if one was given. */
  version?: string;
}

/** Parse `author/name[@version]`; throws a readable error otherwise. */
export function parseRegistryRef(s: string): RegistryRef {
  const m = REGISTRY_REF_RE.exec(s.trim());
  if (!m) {
    throw new Error(
      `invalid pack ref "${s}" (expected <author>/<name> or <author>/<name>@<version>, lowercase letters, digits and dashes)`,
    );
  }
  return {
    author: m[1],
    name: m[2],
    ref: `${m[1]}/${m[2]}`,
    ...(m[3] !== undefined ? { version: m[3] } : {}),
  };
}

/** True when `s` is an `author/name` ref rather than a vendored pack name. */
export function isRegistryRef(s: string): boolean {
  return s.includes('/');
}

const RegistryIndexEntrySchema = z.object({
  author: z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/),
  name: z.string().regex(PACK_NAME_RE),
  title: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(''),
  homepage: z.string().trim().max(200).default(''),
  /** Free-form display version ("2", "2026.10.08"); updates key on checksum, not this. */
  version: z.string().trim().max(32).default(''),
  terms: z.number().int().min(1),
  aliases: z.number().int().min(0),
  /** sha256 hex of the pack file bytes. */
  checksum: z.string().regex(/^[0-9a-f]{64}$/i, 'checksum must be a sha256 hex digest'),
  /** Where the pack file lives: https:// URL, file:// URL, or a path relative to the index. */
  url: z.string().trim().min(1),
});

const RegistryIndexSchema = z.object({
  version: z.literal(1).default(1),
  packs: z.array(RegistryIndexEntrySchema).default([]),
});

export interface RegistryIndexEntry {
  /** The `author/name` address. */
  ref: string;
  author: string;
  name: string;
  title: string;
  description: string;
  homepage: string;
  version: string;
  terms: number;
  aliases: number;
  checksum: string;
  url: string;
}

export interface RegistryIndex {
  packs: RegistryIndexEntry[];
}

export interface RegistryDeps {
  /** Fetch a URL as text (the index). Default: global fetch. */
  fetchText?: (url: string) => Promise<string>;
  /** Fetch a URL as bytes (the pack file). Default: global fetch. */
  fetchBytes?: (url: string) => Promise<Buffer>;
}

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry: GET ${url} failed (HTTP ${res.status})`);
  return res.text();
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`registry: GET ${url} failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function resolvedDeps(deps: RegistryDeps): Required<RegistryDeps> {
  return {
    fetchText: deps.fetchText ?? defaultFetchText,
    fetchBytes: deps.fetchBytes ?? defaultFetchBytes,
  };
}

function parseIndexYaml(text: string, source: string): RegistryIndex {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`invalid registry index at ${source}: ${errorMessage(err)}`);
  }
  const parsed = RegistryIndexSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`);
    throw new Error(`invalid registry index at ${source}:\n${lines.join('\n')}`);
  }
  const seen = new Set<string>();
  const packs: RegistryIndexEntry[] = [];
  for (const e of parsed.data.packs) {
    const ref = `${e.author}/${e.name}`;
    if (seen.has(ref)) throw new Error(`invalid registry index at ${source}: "${ref}" is listed twice`);
    seen.add(ref);
    packs.push({ ref, ...e });
  }
  packs.sort((a, b) => a.ref.localeCompare(b.ref));
  return { packs };
}

export interface LoadedRegistryIndex {
  index: RegistryIndex;
  /** Base used to resolve relative entry URLs: a directory path or an https:// URL prefix. */
  base: string;
}

/**
 * Load a registry index from a local path, a `file://` URL or an `https://`
 * URL. Relative entry URLs resolve against the index's own location.
 */
export async function loadRegistryIndex(source: string, deps: RegistryDeps = {}): Promise<LoadedRegistryIndex> {
  const d = resolvedDeps(deps);
  const trimmed = source.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const text = await d.fetchText(trimmed);
    const base = trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
    return { index: parseIndexYaml(text, trimmed), base };
  }
  const file = trimmed.startsWith('file://') ? trimmed.slice('file://'.length) : trimmed;
  const abs = path.resolve(file);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if (isEnoent(err)) throw new Error(`registry index not found: ${abs}`);
    throw err;
  }
  return { index: parseIndexYaml(text, abs), base: path.dirname(abs) + path.sep };
}

/** Resolve an entry's `url` against the index base. Returns an https:// URL or an absolute path. */
export function resolvePackUrl(entry: RegistryIndexEntry, base: string): string {
  if (/^https?:\/\//i.test(entry.url) || path.isAbsolute(entry.url)) return entry.url;
  if (/^https?:\/\//i.test(base)) return base + entry.url.replace(/^\.\//, '');
  return path.resolve(base, entry.url);
}

/** sha256 hex of the pack file bytes. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Throw when the downloaded bytes do not match the indexed checksum. */
export function verifyPackChecksum(data: Buffer, expected: string, ref: string): void {
  const actual = sha256Hex(data);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `checksum mismatch for ${ref}: index says ${expected}, downloaded file is ${actual} (the index entry or the file changed; refusing to install)`,
    );
  }
}

/**
 * Search the index by name, title, description and author. A ref substring
 * ranks first, then title, then the rest; ties break alphabetically.
 */
export function searchRegistryIndex(index: RegistryIndex, query: string): RegistryIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...index.packs];
  const scored: { entry: RegistryIndexEntry; rank: number }[] = [];
  for (const entry of index.packs) {
    let rank = -1;
    if (entry.ref.toLowerCase().includes(q)) rank = 0;
    else if (entry.title.toLowerCase().includes(q)) rank = 1;
    else if (entry.author.toLowerCase().includes(q)) rank = 2;
    else if (entry.description.toLowerCase().includes(q)) rank = 3;
    if (rank >= 0) scored.push({ entry, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.entry.ref.localeCompare(b.entry.ref));
  return scored.map((s) => s.entry);
}

/** Find one entry by ref; throws a readable error listing what the index holds. */
export function findRegistryEntry(index: RegistryIndex, ref: string): RegistryIndexEntry {
  const entry = index.packs.find((p) => p.ref === ref);
  if (!entry) {
    const known = index.packs.map((p) => p.ref);
    throw new Error(`unknown pack "${ref}" in this registry (known: ${known.length > 0 ? known.join(', ') : 'none'})`);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Local state: checksums pinned at install, cached pack files
// ---------------------------------------------------------------------------

export interface RegistryPackState {
  checksum: string;
  version: string;
  /** Version pin from `pack add author/name@version`; `pack update` will not move a pinned pack. */
  pinnedVersion?: string;
  indexSource: string;
  installedAt: string;
}

export interface RegistryState {
  packs: Record<string, RegistryPackState>;
}

/** Directory holding `registry.json` and the cached pack files, beside the global lexicon. */
export function registryDir(opts: StoreOptions = {}): string {
  return path.join(path.dirname(resolvePaths(opts).global), 'registry');
}

function stateFile(opts: StoreOptions = {}): string {
  return path.join(registryDir(opts), 'registry.json');
}

/** Path of the cached pack file for a ref. */
export function cachedPackPath(ref: string, opts: StoreOptions = {}): string {
  const { author, name } = parseRegistryRef(ref);
  return path.join(registryDir(opts), 'packs', author, `${name}.yaml`);
}

export async function readRegistryState(opts: StoreOptions = {}): Promise<RegistryState> {
  try {
    const raw = await fs.readFile(stateFile(opts), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const packs = (parsed as { packs?: unknown }).packs;
      if (packs !== undefined && (typeof packs !== 'object' || packs === null || Array.isArray(packs))) {
        throw new Error('bad shape');
      }
      return { packs: (packs ?? {}) as RegistryState['packs'] };
    }
    throw new Error('bad shape');
  } catch (err) {
    if (isEnoent(err)) return { packs: {} };
    if (err instanceof Error && err.message === 'bad shape') {
      throw new Error(`invalid registry state at ${stateFile(opts)}: expected { "packs": { "<author>/<name>": {...} } }`);
    }
    throw err;
  }
}

export async function writeRegistryState(state: RegistryState, opts: StoreOptions = {}): Promise<void> {
  await fs.mkdir(registryDir(opts), { recursive: true });
  await fs.writeFile(stateFile(opts), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Refs currently recorded as installed from a registry. */
export async function installedRegistryPacks(opts: StoreOptions = {}): Promise<string[]> {
  return Object.keys((await readRegistryState(opts)).packs).sort();
}

// ---------------------------------------------------------------------------
// Download, install, update, remove
// ---------------------------------------------------------------------------

/**
 * Download a pack file and verify it against the indexed checksum. Returns
 * the bytes; the caller decides where they land (cache on install, temp dir
 * on preview).
 */
export async function downloadPack(
  entry: RegistryIndexEntry,
  base: string,
  deps: RegistryDeps = {},
): Promise<Buffer> {
  const d = resolvedDeps(deps);
  const url = resolvePackUrl(entry, base);
  const bytes = /^https?:\/\//i.test(url) ? await d.fetchBytes(url) : await fs.readFile(url);
  verifyPackChecksum(bytes, entry.checksum, entry.ref);
  return bytes;
}

async function writeCache(ref: string, bytes: Buffer, opts: StoreOptions): Promise<string> {
  const dest = cachedPackPath(ref, opts);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, bytes);
  return dest;
}

export interface InstallRegistryOptions extends StoreOptions {
  scope?: TermScope;
  /** Version pin from `pack add author/name@version`; `pack update` will not move a pinned pack. */
  pinnedVersion?: string;
}

/**
 * Install a community pack: download, checksum-verify, load, install through
 * the same `addTerm` loop as the vendored packs (so `source: 'pack'` and the
 * merge rules are identical), record `author/name` in `settings.packs`, and
 * pin the checksum in the registry state.
 */
export async function installRegistryPack(
  entry: RegistryIndexEntry,
  base: string,
  indexSource: string,
  opts: InstallRegistryOptions = {},
  deps: RegistryDeps = {},
): Promise<InstallPackResult & { ref: string }> {
  const bytes = await downloadPack(entry, base, deps);
  const file = await writeCache(entry.ref, bytes, opts);
  const pack = await loadPackFile(file, entry.name);
  if (pack.name !== entry.name || pack.title !== entry.title) {
    throw new Error(
      `pack file at ${entry.url} does not match the index entry for ${entry.ref} (name/title differ; refusing to install)`,
    );
  }
  const result = await installLoadedPack(pack, entry.ref, opts);
  const state = await readRegistryState(opts);
  state.packs[entry.ref] = {
    checksum: entry.checksum,
    version: entry.version,
    ...(opts.pinnedVersion !== undefined ? { pinnedVersion: opts.pinnedVersion } : {}),
    indexSource,
    installedAt: new Date().toISOString(),
  };
  await writeRegistryState(state, opts);
  return { ...result, ref: entry.ref };
}

export interface RegistryUpdateReport {
  ref: string;
  status: 'current' | 'updated' | 'pinned' | 'not-installed' | 'failed';
  from?: string;
  to?: string;
  added?: number;
  merged?: number;
  /** Canonicals the new pack file no longer contains (left in the lexicon; `pack remove` takes the rest). */
  dropped?: string[];
  error?: string;
}

export interface RegistryUpdatePreview {
  ref: string;
  status: 'current' | 'available' | 'pinned' | 'not-installed' | 'failed';
  from?: string;
  to?: string;
  /** Canonicals in the new pack file that the installed one does not have. */
  added: string[];
  /** Canonicals in the installed pack file that the new one drops (left in the lexicon, never deleted). */
  removed: string[];
  error?: string;
  /** Present when status is 'available': what `applyRegistryUpdate` installs. */
  entry?: RegistryIndexEntry;
  base?: string;
}

/**
 * Preview what `pack update` would do, without writing anything. Updates key
 * on checksum, not on the display version: a changed checksum means a new
 * file, whose added/dropped canonicals are listed here so the caller can show
 * them before applying.
 */
export async function previewRegistryUpdates(
  refs: string[] | undefined,
  indexSource: string,
  opts: InstallRegistryOptions = {},
  deps: RegistryDeps = {},
): Promise<RegistryUpdatePreview[]> {
  const { index, base } = await loadRegistryIndex(indexSource, deps);
  const state = await readRegistryState(opts);
  const targets = (refs ?? Object.keys(state.packs)).map((r) => parseRegistryRef(r).ref);
  const previews: RegistryUpdatePreview[] = [];
  for (const ref of targets) {
    const pinned = state.packs[ref];
    if (!pinned) {
      previews.push({ ref, status: 'not-installed', added: [], removed: [] });
      continue;
    }
    let entry: RegistryIndexEntry;
    try {
      entry = findRegistryEntry(index, ref);
    } catch (err) {
      previews.push({ ref, status: 'failed', added: [], removed: [], error: errorMessage(err) });
      continue;
    }
    if (pinned.pinnedVersion !== undefined && pinned.pinnedVersion !== entry.version) {
      previews.push({ ref, status: 'pinned', from: pinned.version, to: entry.version, added: [], removed: [] });
      continue;
    }
    if (pinned.checksum.toLowerCase() === entry.checksum.toLowerCase()) {
      previews.push({ ref, status: 'current', from: pinned.version, to: entry.version, added: [], removed: [] });
      continue;
    }
    try {
      const bytes = await downloadPack(entry, base, deps);
      const pack = parsePackText(bytes.toString('utf8'), entry.url, entry.name);
      const installed = await readCachedPack(ref, opts);
      const have = new Set((installed?.lexicon.terms ?? []).map((t) => t.canonical.toLowerCase()));
      const incoming = pack.lexicon.terms.map((t) => t.canonical);
      const incomingSet = new Set(incoming.map((c) => c.toLowerCase()));
      previews.push({
        ref,
        status: 'available',
        from: pinned.version,
        to: entry.version,
        added: incoming.filter((c) => !have.has(c.toLowerCase())),
        removed: (installed?.lexicon.terms ?? []).map((t) => t.canonical).filter((c) => !incomingSet.has(c.toLowerCase())),
        entry,
        base,
      });
    } catch (err) {
      previews.push({ ref, status: 'failed', added: [], removed: [], error: errorMessage(err) });
    }
  }
  return previews;
}

async function readCachedPack(ref: string, opts: StoreOptions): Promise<Pack | undefined> {
  try {
    return await loadPackFile(cachedPackPath(ref, opts), parseRegistryRef(ref).name);
  } catch {
    return undefined;
  }
}

/**
 * Apply one previewed update: download the new file again (checksums are
 * re-verified, so a preview cannot bless a file that changed since), merge
 * it over the installed terms, and re-pin the checksum. Removed terms are
 * reported, not deleted: silently deleting a term the user may have come to
 * rely on would be the wrong default.
 */
export async function applyRegistryUpdate(
  preview: RegistryUpdatePreview,
  indexSource: string,
  opts: InstallRegistryOptions = {},
  deps: RegistryDeps = {},
): Promise<RegistryUpdateReport> {
  const { ref, entry, base } = preview;
  if (preview.status !== 'available' || !entry || !base) {
    return { ref, status: preview.status === 'available' ? 'failed' : preview.status, error: preview.error };
  }
  try {
    const bytes = await downloadPack(entry, base, deps);
    const file = await writeCache(ref, bytes, opts);
    const pack = await loadPackFile(file, entry.name);
    const result = await installLoadedPack(pack, ref, opts);
    const state = await readRegistryState(opts);
    const pinned = state.packs[ref];
    state.packs[ref] = {
      checksum: entry.checksum,
      version: entry.version,
      ...(pinned?.pinnedVersion !== undefined ? { pinnedVersion: pinned.pinnedVersion } : {}),
      indexSource,
      installedAt: new Date().toISOString(),
    };
    await writeRegistryState(state, opts);
    return {
      ref,
      status: 'updated',
      from: preview.from,
      to: preview.to,
      added: result.added,
      merged: result.merged,
      dropped: preview.removed,
    };
  } catch (err) {
    return { ref, status: 'failed', error: errorMessage(err) };
  }
}
/**
 * Remove a registry pack: resolve the pack file from the local cache (or
 * re-download it through the index when `indexSource` is given and the cache
 * is gone), then the same keep-edited-terms removal as the vendored packs.
 */
export async function uninstallRegistryPack(
  ref: string,
  indexSource: string | undefined,
  opts: StoreOptions & { scope?: TermScope } = {},
  deps: RegistryDeps = {},
): Promise<UninstallPackResult> {
  const parsed = parseRegistryRef(ref);
  let file = cachedPackPath(parsed.ref, opts);
  try {
    await fs.stat(file);
  } catch (err) {
    if (!isEnoent(err)) throw err;
    if (!indexSource) {
      throw new Error(
        `no cached pack file for ${parsed.ref} (and no --registry to re-fetch it): install it again with \`lexicon pack add ${parsed.ref} --registry <index>\` or pass --registry to remove`,
      );
    }
    const { index, base } = await loadRegistryIndex(indexSource, deps);
    const entry = findRegistryEntry(index, parsed.ref);
    const bytes = await downloadPack(entry, base, deps);
    file = await writeCache(parsed.ref, bytes, opts);
  }
  const pack = await loadPackFile(file, parsed.name);
  const result = await uninstallLoadedPack(pack, parsed.ref, opts);
  const state = await readRegistryState(opts);
  delete state.packs[parsed.ref];
  await writeRegistryState(state, opts);
  try {
    await fs.unlink(cachedPackPath(parsed.ref, opts));
  } catch {
    // The cache file is a convenience; its absence is not a failure.
  }
  return result;
}

// ---------------------------------------------------------------------------
// Publish-time validation
// ---------------------------------------------------------------------------

export interface CommunityPackValidation {
  errors: string[];
  warnings: string[];
}

/**
 * The review bar for a community pack, enforced by `lexicon pack validate`
 * (and meant for CI on the pack's own repo). Errors block listing; warnings
 * are judgment calls.
 *
 * The ordinary-word guard is the load-bearing one: a term whose canonical is
 * an everyday English word rewrites prose the user never meant as a name, and
 * a pack the user did not write gets no benefit of the doubt. The vendored
 * packs obey the same rule by review; community packs get it as a check.
 */
export function validateCommunityPack(pack: Pack): CommunityPackValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!pack.author) errors.push('author is required for a community pack (who maintains these terms?)');
  if (!pack.homepage) warnings.push('no homepage: users cannot check who you are or report a bad term');
  for (const term of pack.lexicon.terms) {
    const canonical = term.canonical.trim();
    const lower = canonical.toLowerCase();
    if (!/\s/.test(canonical) && STOPLIST.has(lower)) {
      errors.push(`"${canonical}" is an ordinary English word and would rewrite everyday prose; drop it or move it to never-words`);
      continue;
    }
    if (!/\s/.test(canonical) && HARVEST_STOPLIST.has(canonical)) {
      errors.push(`"${canonical}" is an ordinary capitalized word and would rewrite everyday prose; drop it`);
      continue;
    }
    if (term.aliases.length === 0) {
      warnings.push(`"${canonical}" has no aliases: a term nobody misspells is dead weight, but harmless`);
    }
    for (const alias of term.aliases) {
      if (STOPLIST.has(alias.toLowerCase()) && !/\s/.test(alias)) {
        errors.push(`alias "${alias}" of "${canonical}" is an ordinary English word and would rewrite everyday prose`);
      }
    }
  }
  return { errors, warnings };
}
