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
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';
import { HARVEST_STOPLIST } from './harvest.js';
import { compareText } from './collate.js';
import { PACK_NAME_RE, installLoadedPack, parsePackText, uninstallLoadedPack } from './packs.js';
import type { InstallPackResult, Pack, UninstallPackResult } from './packs.js';
import { defaultProjectPath, MAX_LEXICON_BYTES, resolvePaths, resolveScopeWritePath, withLexiconLock } from './store.js';
import { restoreTrustEntry, trustEntryOf } from './trust.js';
import { writeFileAtomic } from '../util/atomic.js';
import type { StoreOptions } from './store.js';
import type { LoadedLexicon, Term, TermScope } from './types.js';
import { STOPLIST } from './stoplist.js';
import { errorMessage, isEnoent } from '../util/errors.js';
import { redactSecrets, safeUrlLabel } from './redact.js';
import { isBoundedReadError, readBoundedRegularFile } from '../util/bounded-read.js';

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

/**
 * Largest registry index or community pack file read, from the network or
 * from disk. A pack over MAX_LEXICON_BYTES could never be installed anyway,
 * and an index that size lists thousands of packs. Without it a hostile or
 * broken registry streamed into memory until the process died.
 */
// A literal, not `= MAX_LEXICON_BYTES`: this module is evaluated inside an
// import cycle with store.ts, where that binding is not initialized yet.
// tests/registry.test.ts checks the two agree.
export const MAX_REGISTRY_FILE_BYTES = 2 * 1024 * 1024;

/** How long one registry request may take before it is abandoned. */
export const REGISTRY_FETCH_TIMEOUT_MS = 30_000;

function tooLargeError(what: string): Error {
  return new Error(`registry: ${what} exceeds the ${MAX_REGISTRY_FILE_BYTES} byte limit (refusing to read it)`);
}

/**
 * Throw unless `url` is https://, or plain http:// to this machine (a registry
 * served from a local checkout). The index is the only thing that vouches
 * for a pack's checksum, so an index or pack fetched over plain http from
 * anywhere else can be rewritten in transit, checksum and all, into any
 * terms an on-path attacker likes; those terms then reach the model on
 * every prompt.
 */
/** A registry source for a message: a URL without its credentials or query, or a path as is. */
function sourceLabel(source: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? safeUrlLabel(source) : source;
}

export function assertSecureRegistryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`registry: not a valid URL: ${safeUrlLabel(url)}`);
  }
  if (parsed.protocol === 'https:') return;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (parsed.protocol === 'http:' && loopback) return;
  throw new Error(
    `registry: refusing ${parsed.protocol}//${parsed.host}: a registry index or pack file is fetched over https:// only (plain http:// only from this machine), because the index is what vouches for each pack's checksum`,
  );
}

/** GET `url`, reading at most MAX_REGISTRY_FILE_BYTES of the body. */
async function boundedFetch(url: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(REGISTRY_FETCH_TIMEOUT_MS) });
  } catch (err) {
    // fetch's own message can quote the URL (a URL with a password, for one).
    throw new Error(`registry: GET ${safeUrlLabel(url)} failed: ${redactSecrets(errorMessage(err), [url])}`);
  }
  // fetch follows redirects, including an https -> http downgrade.
  if (res.url) {
    try {
      assertSecureRegistryUrl(res.url);
    } catch (err) {
      await res.body?.cancel().catch(() => undefined);
      throw err;
    }
  }
  if (!res.ok) throw new Error(`registry: GET ${safeUrlLabel(url)} failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REGISTRY_FILE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLargeError(`GET ${safeUrlLabel(url)}`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REGISTRY_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLargeError(`GET ${safeUrlLabel(url)}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function defaultFetchText(url: string): Promise<string> {
  return (await boundedFetch(url)).toString('utf8');
}

async function defaultFetchBytes(url: string): Promise<Buffer> {
  return boundedFetch(url);
}

/** A local index or pack file: a regular file of at most MAX_REGISTRY_FILE_BYTES (never a device or FIFO). */
async function readLocalRegistryFile(file: string, what: string): Promise<Buffer> {
  try {
    return (await readBoundedRegularFile(file, MAX_REGISTRY_FILE_BYTES)).bytes;
  } catch (err) {
    if (isBoundedReadError(err)) {
      if (err.reason === 'not-regular') throw new Error(`registry: ${what} at ${file} is not a regular file (refusing to read it)`);
      throw tooLargeError(`${what} at ${file}`);
    }
    throw err;
  }
}

function resolvedDeps(deps: RegistryDeps): Required<RegistryDeps> {
  // An injected fetcher is held to the same cap after the fact.
  return {
    fetchText: async (url) => {
      assertSecureRegistryUrl(url);
      const text = await (deps.fetchText ?? defaultFetchText)(url);
      if (Buffer.byteLength(text, 'utf8') > MAX_REGISTRY_FILE_BYTES) throw tooLargeError(`GET ${safeUrlLabel(url)}`);
      return text;
    },
    fetchBytes: async (url) => {
      assertSecureRegistryUrl(url);
      const bytes = await (deps.fetchBytes ?? defaultFetchBytes)(url);
      if (bytes.length > MAX_REGISTRY_FILE_BYTES) throw tooLargeError(`GET ${safeUrlLabel(url)}`);
      return bytes;
    },
  };
}

function parseIndexYaml(text: string, source: string): RegistryIndex {
  let raw: unknown;
  try {
    // No source excerpt in the message (see store.ts parseLexiconText): the
    // index path can come from an MCP call, and a YAML error on an arbitrary
    // local file must not quote that file back into the conversation.
    raw = parseYaml(text, { prettyErrors: false });
  } catch (err) {
    throw new Error(`invalid registry index at ${sourceLabel(source)}: ${errorMessage(err)}`);
  }
  const parsed = RegistryIndexSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`);
    throw new Error(`invalid registry index at ${sourceLabel(source)}:\n${lines.join('\n')}`);
  }
  const seen = new Set<string>();
  const packs: RegistryIndexEntry[] = [];
  for (const e of parsed.data.packs) {
    const ref = `${e.author}/${e.name}`;
    if (seen.has(ref)) throw new Error(`invalid registry index at ${sourceLabel(source)}: "${ref}" is listed twice`);
    seen.add(ref);
    packs.push({ ref, ...e });
  }
  packs.sort((a, b) => compareText(a.ref, b.ref));
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
    text = (await readLocalRegistryFile(abs, 'index')).toString('utf8');
  } catch (err) {
    if (isEnoent(err)) throw new Error(`registry index not found: ${abs}`);
    throw err;
  }
  return { index: parseIndexYaml(text, abs), base: path.dirname(abs) + path.sep };
}

/**
 * Resolve an entry's `url` against the index base. Returns an https:// URL or an absolute path.
 *
 * A remote index names remote files only: an absolute http(s) URL or a path
 * relative to the index. An absolute local path (or any other scheme) in an
 * index fetched over the network would have this machine read a file of the
 * index author's choosing: `/dev/stdin` hangs the MCP server on its own
 * protocol stream, `/dev/zero` reads forever, and a checksum mismatch on any
 * other file reports that file's sha256. Only a local index may name local
 * files.
 */
export function resolvePackUrl(entry: RegistryIndexEntry, base: string): string {
  if (/^https?:\/\//i.test(entry.url)) return entry.url;
  if (/^https?:\/\//i.test(base)) {
    if (path.isAbsolute(entry.url) || path.win32.isAbsolute(entry.url) || /^[a-z][a-z0-9+.-]*:/i.test(entry.url)) {
      throw new Error(
        `registry entry ${entry.ref} names a local file or a non-http URL; a remote index may only name https:// URLs or paths relative to itself (refusing to install)`,
      );
    }
    return base + entry.url.replace(/^\.\//, '');
  }
  if (entry.url.startsWith('file://')) return entry.url.slice('file://'.length);
  if (path.isAbsolute(entry.url)) return entry.url;
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
  scored.sort((a, b) => a.rank - b.rank || compareText(a.entry.ref, b.entry.ref));
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

const RegistryPackStateSchema = z.object({
  checksum: z.string().regex(/^[0-9a-f]{64}$/i),
  version: z.string().max(32),
  pinnedVersion: z.string().max(32).optional(),
  indexSource: z.string().min(1),
  installedAt: z.string().datetime(),
}).strict();

/** Approval covers version pins and provenance metadata as well as installed bytes. */
function installedStateDigest(state: RegistryPackState): string {
  const parsed = RegistryPackStateSchema.safeParse(state);
  if (!parsed.success) throw new Error('invalid installed pack state; inspect it before approving an update');
  return sha256Hex(JSON.stringify({
    checksum: parsed.data.checksum,
    version: parsed.data.version,
    pinnedVersion: parsed.data.pinnedVersion ?? null,
    indexSource: parsed.data.indexSource,
    installedAt: parsed.data.installedAt,
  }));
}

export interface RegistryStoreOptions extends StoreOptions {
  scope?: TermScope;
}

/** Canonical target binds preview approval, state and cache to one installation scope. */
function registryIdentity(opts: RegistryStoreOptions): string {
  const paths = resolvePaths(opts);
  const file = opts.scope === 'project' ? paths.project ?? defaultProjectPath(opts.cwd) : paths.global;
  try { return realpathSync.native(file); } catch {
    try { return path.join(realpathSync.native(path.dirname(file)), path.basename(file)); } catch { return path.resolve(file); }
  }
}

/** User-owned sidecars; project packs never overwrite global or another project's records. */
export function registryDir(opts: RegistryStoreOptions = {}): string {
  const base = path.join(path.dirname(resolvePaths(opts).global), 'registry');
  return opts.scope === 'project' ? path.join(base, 'projects', sha256Hex(registryIdentity(opts))) : base;
}

function stateFile(opts: RegistryStoreOptions = {}): string {
  return path.join(registryDir(opts), 'registry.json');
}

/** Path of the cached pack file for a ref. */
export function cachedPackPath(ref: string, opts: RegistryStoreOptions = {}): string {
  const { author, name } = parseRegistryRef(ref);
  return path.join(registryDir(opts), 'packs', author, `${name}.yaml`);
}

export async function readRegistryState(opts: RegistryStoreOptions = {}): Promise<RegistryState> {
  try {
    const raw = await fs.readFile(stateFile(opts), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const identity = parsed as { target?: unknown; scope?: unknown };
      if (identity.target !== registryIdentity(opts) || identity.scope !== (opts.scope ?? 'global')) {
        throw new Error('registry state belongs to a different or unknown installation scope; inspect its scope metadata before modifying packs');
      }
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

export async function writeRegistryState(state: RegistryState, opts: RegistryStoreOptions = {}): Promise<void> {
  await fs.mkdir(registryDir(opts), { recursive: true });
  await writeFileAtomic(stateFile(opts), `${JSON.stringify({ ...state, scope: opts.scope ?? 'global', target: registryIdentity(opts) }, null, 2)}\n`, { mode: 0o600 });
}

/** Refs currently recorded as installed from a registry. */
export async function installedRegistryPacks(opts: RegistryStoreOptions = {}): Promise<string[]> {
  return Object.keys((await readRegistryState(opts)).packs).sort();
}

/** Environment variable a human sets (in the MCP server's env) to allow extra registry indexes, comma or newline separated. */
export const REGISTRIES_ENV = 'LEXICON_REGISTRIES';

/**
 * Canonical spelling of a registry source for allowlist comparison: an
 * http(s) URL as `URL.href`, a `file://` URL or absolute path as a resolved
 * path. A relative path names a different file from every working directory,
 * so it never matches (undefined).
 */
export function canonicalRegistrySource(source: string): string | undefined {
  const s = source.trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) {
    try { return new URL(s).href; } catch { return undefined; }
  }
  const file = s.startsWith('file://') ? s.slice('file://'.length) : s;
  return path.isAbsolute(file) ? path.resolve(file) : undefined;
}

/**
 * Registry indexes the user chose, which is all an agent surface may read:
 * every index a recorded community pack was installed from (global scope, and
 * the project scope of `opts.cwd`), plus `$LEXICON_REGISTRIES`. Canonical
 * spellings, sorted. A scope whose state cannot be read contributes nothing.
 */
export async function userRegistrySources(opts: StoreOptions = {}): Promise<string[]> {
  const out = new Set<string>();
  const env = opts.env ?? process.env;
  for (const raw of (env[REGISTRIES_ENV] ?? '').split(/[,\n]/)) {
    const c = canonicalRegistrySource(raw);
    if (c) out.add(c);
  }
  for (const scope of ['global', 'project'] as const) {
    let state: RegistryState;
    try { state = await readRegistryState({ ...opts, scope }); } catch { continue; }
    for (const p of Object.values(state.packs)) {
      const c = typeof p?.indexSource === 'string' ? canonicalRegistrySource(p.indexSource) : undefined;
      if (c) out.add(c);
    }
  }
  return [...out].sort();
}

/**
 * Fail closed unless `source` is one of `userRegistrySources`: a model-chosen
 * registry would otherwise make Lexicon read an arbitrary local file or fetch
 * from an arbitrary host. Human CLI flags (`--registry`) do not go through
 * this gate.
 */
export async function assertUserRegistry(source: string, opts: StoreOptions = {}): Promise<void> {
  const allowed = await userRegistrySources(opts);
  const c = canonicalRegistrySource(source);
  if (c && allowed.includes(c)) return;
  const shown = JSON.stringify(source.length > 200 ? `${source.slice(0, 200)}...` : source);
  throw new Error(
    `registry ${shown} is not one the user registered, so it was not read. ` +
      (allowed.length > 0 ? `Registered: ${allowed.join(', ')}. ` : 'No registry is registered. ') +
      `A registry counts once the user installs a pack from it themselves (lexicon pack add <author>/<name> --registry <index>, or npx @ashlr/lexicon pack add ...) or lists it in ${REGISTRIES_ENV} in the MCP server's environment.`,
  );
}

/**
 * Where a registry pack is recorded, when the two records disagree: the
 * lexicon file's `settings.packs` (what the matcher and every `installed`
 * flag read) and the registry state file (what `pack update` and `pack
 * remove` use).
 */
export interface RegistryRecordMismatch {
  /** In the lexicon file, with no registry record: `pack update` will not check it. */
  fileOnly: string[];
  /** Recorded in the registry state but not in the lexicon file: listed as not installed. */
  recordOnly: string[];
}

/**
 * Compare one scope's loaded file with that scope's registry records (state is
 * kept per scope). A skipped project file is never read: `loaded.project` is
 * set only when it was merged. Undefined when they agree or the file is absent.
 */
export function registryRecordMismatch(
  loaded: Pick<LoadedLexicon, 'global' | 'project'>,
  scope: TermScope,
  recorded: readonly string[],
): RegistryRecordMismatch | undefined {
  const file = scope === 'project' ? loaded.project : loaded.global;
  if (!file) return undefined;
  const inFile = (file.lexicon.settings?.packs ?? []).filter((p) => isRegistryRef(p));
  const fileOnly = inFile.filter((r) => !recorded.includes(r));
  const recordOnly = recorded.filter((r) => !inFile.includes(r));
  return fileOnly.length > 0 || recordOnly.length > 0 ? { fileOnly, recordOnly } : undefined;
}

/**
 * The mismatch across every loaded scope (global, and the project file when it
 * was merged), for surfaces that list packs from both files at once (`pack
 * search`, MCP `list_packs`). Best effort: a scope whose registry state cannot
 * be read is left out rather than failing the listing.
 */
export async function findRegistryRecordMismatch(
  loaded: Pick<LoadedLexicon, 'global' | 'project'>,
  opts: StoreOptions = {},
): Promise<RegistryRecordMismatch | undefined> {
  const fileOnly: string[] = [];
  const recordOnly: string[] = [];
  for (const scope of ['global', 'project'] as const) {
    if (scope === 'project' && !loaded.project) continue;
    let recorded: string[];
    try {
      recorded = await installedRegistryPacks({ ...opts, scope });
    } catch {
      continue;
    }
    const m = registryRecordMismatch(loaded, scope, recorded);
    if (!m) continue;
    for (const r of m.fileOnly) if (!fileOnly.includes(r)) fileOnly.push(r);
    for (const r of m.recordOnly) if (!recordOnly.includes(r)) recordOnly.push(r);
  }
  return fileOnly.length > 0 || recordOnly.length > 0 ? { fileOnly, recordOnly } : undefined;
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
  const bytes = /^https?:\/\//i.test(url) ? await d.fetchBytes(url) : await readLocalRegistryFile(url, 'pack file');
  verifyPackChecksum(bytes, entry.checksum, entry.ref);
  return bytes;
}

/**
 * The index source as the registry state records it: an http(s) URL as
 * given, a local path or `file://` URL as the absolute path it was read from
 * (`loadRegistryIndex` resolves it the same way). A relative `--registry` was
 * recorded as typed, so `pack update` and `pack remove` run from any other
 * directory looked for a different file ("registry index not found"), and
 * MCP never counted it as a registry the user chose (canonicalRegistrySource
 * matches no relative path).
 */
export function recordedRegistrySource(source: string): string {
  const s = source.trim();
  if (/^https?:\/\//i.test(s)) return s;
  return path.resolve(s.startsWith('file://') ? s.slice('file://'.length) : s);
}

async function writeCache(ref: string, bytes: Buffer, opts: RegistryStoreOptions): Promise<string> {
  const dest = cachedPackPath(ref, opts);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await writeFileAtomic(dest, bytes.toString('utf8'), { mode: 0o600 });
  return dest;
}

export interface InstallRegistryOptions extends RegistryStoreOptions {
  /** Version pin from `pack add author/name@version`; `pack update` will not move a pinned pack. */
  pinnedVersion?: string;
  /** Exact reviewed bytes. Copied and checksum-verified before any write. */
  approvedBytes?: Uint8Array;
  /** Write a project file without registering it as trusted (see `installLoadedPack`). */
  leaveUntrusted?: boolean;
}

function validatedPack(bytes: Buffer, entry: RegistryIndexEntry): Pack {
  verifyPackChecksum(bytes, entry.checksum, entry.ref);
  if (bytes.length > MAX_LEXICON_BYTES) throw new Error('community pack exceeds the lexicon size limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const pack = parsePackText(text, entry.url, entry.name);
  if (pack.title !== entry.title) throw new Error(`pack file does not match the index entry for ${entry.ref} (name/title differ; refusing to install)`);
  const validation = validateCommunityPack(pack);
  if (validation.errors.length) throw new Error(`community pack rejected: ${validation.errors.join('; ')}`);
  return pack;
}

async function snapshot(file: string): Promise<Buffer | undefined> {
  try { return await fs.readFile(file); } catch (err) { if (isEnoent(err)) return undefined; throw err; }
}

/** Serialize lexicon and scoped metadata together; rejected writes preserve the last good cache. */
async function commitPack(
  pack: Pack, bytes: Buffer, entry: RegistryIndexEntry, indexSource: string,
  opts: InstallRegistryOptions, expectedInstalledChecksum?: string, expectedInstalledStateDigest?: string,
): Promise<InstallPackResult> {
  opts = { ...opts, globalPath: resolvePaths(opts).global };
  const target = await resolveScopeWritePath(opts.scope ?? 'global', opts);
  return withLexiconLock(target, async () => {
    const state = await readRegistryState(opts);
    if (expectedInstalledChecksum !== undefined && (
      state.packs[entry.ref]?.checksum !== expectedInstalledChecksum
      || !expectedInstalledStateDigest
      || installedStateDigest(state.packs[entry.ref]) !== expectedInstalledStateDigest
    )) {
      throw new Error('installed pack changed after preview; preview and approve it again');
    }
    const files = [target, cachedPackPath(entry.ref, opts), stateFile(opts)];
    const before = await Promise.all(files.map(snapshot));
    const pinBefore = opts.scope === 'project' && !opts.leaveUntrusted ? await trustEntryOf(target, opts) : undefined;
    try {
      const result = await installLoadedPack(pack, entry.ref, opts);
      await writeCache(entry.ref, bytes, opts);
      const pinnedVersion = opts.pinnedVersion ?? (expectedInstalledChecksum !== undefined ? state.packs[entry.ref]?.pinnedVersion : undefined);
      state.packs[entry.ref] = {
        checksum: entry.checksum, version: entry.version,
        ...(pinnedVersion !== undefined ? { pinnedVersion } : {}),
        indexSource: recordedRegistrySource(indexSource), installedAt: new Date().toISOString(),
      };
      await writeRegistryState(state, opts);
      return result;
    } catch (err) {
      try {
        for (let i = files.length - 1; i >= 0; i--) {
          if (before[i] === undefined) await fs.rm(files[i], { force: true });
          else await writeFileAtomic(files[i], before[i]!.toString('utf8'));
        }
        // An unpinned install never touched the registry: restoring the bytes
        // restores the status, and a refresh would bless a changed file.
        // The pin goes back to what it was, not to a hash of the restored
        // bytes: those were never checked against it (see restoreTrustEntry).
        if (opts.scope === 'project' && !opts.leaveUntrusted) await restoreTrustEntry(target, pinBefore, opts);
      } catch (rollback) {
        throw new AggregateError([err, rollback], 'registry install failed and rollback was incomplete');
      }
      throw err;
    }
  });
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
  const bytes = opts.approvedBytes === undefined ? await downloadPack(entry, base, deps) : Buffer.from(opts.approvedBytes);
  const pack = validatedPack(bytes, entry);
  const result = await commitPack(pack, bytes, entry, indexSource, opts);
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
  /** Complete incoming content, including aliases and model-visible notes. */
  terms?: Term[];
  changed?: { before: Term; after: Term }[];
  scopeIdentity?: string;
  installedChecksum?: string;
  /** Validated full installation record approved by this preview, including version pin. */
  installedStateDigest?: string;
  approvedChecksum?: string;
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
      const pack = validatedPack(bytes, entry);
      const installed = await readCachedPack(ref, opts, pinned.checksum);
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
        terms: pack.lexicon.terms,
        changed: pack.lexicon.terms.flatMap(after => {
          const before = installed?.lexicon.terms.find(t => t.canonical.toLowerCase() === after.canonical.toLowerCase());
          return before && JSON.stringify(before) !== JSON.stringify(after) ? [{ before, after }] : [];
        }),
        scopeIdentity: registryIdentity(opts),
        installedChecksum: pinned.checksum,
        installedStateDigest: installedStateDigest(pinned),
        approvedChecksum: entry.checksum,
      });
    } catch (err) {
      previews.push({ ref, status: 'failed', added: [], removed: [], error: errorMessage(err) });
    }
  }
  return previews;
}

/**
 * The canonicals of an installed community pack, from its cached file in
 * `opts.scope`'s registry directory (checked against the pinned checksum), or
 * undefined when it has no record or no cache. Used by `pack remove` to keep
 * the terms another installed pack still has.
 */
export async function cachedPackCanonicals(ref: string, opts: RegistryStoreOptions = {}): Promise<string[] | undefined> {
  const parsed = parseRegistryRef(ref);
  const pinned = (await readRegistryState(opts)).packs[parsed.ref];
  if (!pinned) return undefined;
  const pack = await readCachedPack(parsed.ref, opts, pinned.checksum);
  return pack?.lexicon.terms.map((t) => t.canonical);
}

async function readCachedPack(ref: string, opts: RegistryStoreOptions, checksum: string): Promise<Pack | undefined> {
  try {
    const file = cachedPackPath(ref, opts);
    const bytes = await fs.readFile(file);
    verifyPackChecksum(bytes, checksum, ref);
    return parsePackText(new TextDecoder('utf-8', { fatal: true }).decode(bytes), file, parseRegistryRef(ref).name);
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
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
    if (preview.scopeIdentity !== registryIdentity(opts) || preview.approvedChecksum !== entry.checksum || !preview.installedChecksum || !/^[0-9a-f]{64}$/.test(preview.installedStateDigest ?? '')) {
      throw new Error('update approval does not match this scope or content; preview and approve it again');
    }
    const bytes = await downloadPack(entry, base, deps);
    const pack = validatedPack(bytes, entry);
    const result = await commitPack(pack, bytes, entry, indexSource, opts, preview.installedChecksum, preview.installedStateDigest);
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
  const scoped = { ...opts, globalPath: resolvePaths(opts).global, scope: opts.scope ?? 'global' as const };
  const target = await resolveScopeWritePath(scoped.scope, scoped);
  return withLexiconLock(target, async () => {
    const state = await readRegistryState(scoped);
    const pinned = state.packs[parsed.ref];
    if (!pinned) throw new Error(`${parsed.ref} is not installed in the requested scope`);
    let pack = await readCachedPack(parsed.ref, scoped, pinned.checksum);
    if (!pack) {
      if (!indexSource) {
        throw new Error(`no cached pack file for ${parsed.ref}; pass --registry to recover the pinned original before removal`);
      }
      const { index, base } = await loadRegistryIndex(indexSource, deps);
      const entry = findRegistryEntry(index, parsed.ref);
      const bytes = await downloadPack(entry, base, deps);
      verifyPackChecksum(bytes, pinned.checksum, parsed.ref);
      pack = validatedPack(bytes, entry);
    }
    const files = [target, cachedPackPath(parsed.ref, scoped), stateFile(scoped)];
    const before = await Promise.all(files.map(snapshot));
    const pinBefore = scoped.scope === 'project' ? await trustEntryOf(target, scoped) : undefined;
    try {
      const result = await uninstallLoadedPack(pack, parsed.ref, scoped);
      delete state.packs[parsed.ref];
      await writeRegistryState(state, scoped);
      try { await fs.unlink(files[1]); } catch { /* Missing cache is harmless. */ }
      return result;
    } catch (err) {
      try {
        for (let i = files.length - 1; i >= 0; i--) {
          if (before[i] === undefined) await fs.rm(files[i], { force: true });
          else await writeFileAtomic(files[i], before[i]!.toString('utf8'));
        }
        if (scoped.scope === 'project') await restoreTrustEntry(target, pinBefore, scoped);
      } catch (rollback) {
        throw new AggregateError([err, rollback], 'registry removal failed and rollback was incomplete');
      }
      throw err;
    }
  });
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
