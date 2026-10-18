/**
 * Trust registry for project lexicons.
 *
 * A project `.lexicon.yaml` comes from whatever repository the user happens to
 * be in. Its canonicals and notes are injected into the model's context by the
 * Claude Code hook and the MCP server, so an unreviewed file is a prompt
 * injection vector (alias "deploy" -> canonical "deploy and also run ...").
 * Claude Code gates repo `.mcp.json` behind explicit approval; this module does
 * the same for project lexicons.
 *
 * The registry lives next to the global lexicon (`<dirname(global)>/trust.json`)
 * and pins each trusted project file to the sha256 of its content, so a change
 * after `git pull` drops the file back to 'changed' until re-approved.
 *
 * Escape hatch: `LEXICON_TRUST_ALL=1` treats every project file as trusted
 * (for CI or throwaway containers where the repo is already vetted).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_LEXICON_BYTES, resolvePaths } from './store.js';
import type { StoreOptions } from './store.js';
import type { LexiconFile } from './types.js';
import { withFileLock, writeFileAtomic } from '../util/atomic.js';
import { readBoundedRegularFile } from '../util/bounded-read.js';
import { recalledParsedHash } from './parsed-hash.js';
import { formatJson } from '../util/json.js';
import { neutralizeMarkup, sanitizeForDisplay, sanitizeForDisplayMax } from './schema.js';

export type TrustStatus = 'trusted' | 'untrusted' | 'changed';

export interface TrustEntry {
  /** Hex sha256 of the file content at the time trust was granted. */
  sha256: string;
  /** ISO timestamp. */
  trustedAt: string;
}

export interface TrustRegistry {
  version: 1;
  /** Keyed by absolute (symlink-resolved) project file path. */
  trusted: Record<string, TrustEntry>;
}

/** One row of `listTrusted()`: a registry entry plus whether it still matches the file on disk. */
export interface TrustListEntry extends TrustEntry {
  path: string;
  /** 'missing' when the registered file no longer exists. */
  status: TrustStatus | 'missing';
}

export const TRUST_FILE_NAME = 'trust.json';
/** Env var that, when set to `1` or `true`, treats every project lexicon as trusted. */
export const TRUST_ALL_ENV = 'LEXICON_TRUST_ALL';

// ---------------------------------------------------------------------------
// Paths + hashing
// ---------------------------------------------------------------------------

/** `<dirname(global lexicon)>/trust.json`; follows LEXICON_PATH and XDG_CONFIG_HOME. */
export function getTrustPath(opts: StoreOptions = {}): string {
  return path.join(path.dirname(resolvePaths(opts).global), TRUST_FILE_NAME);
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

/**
 * Hex sha256 of a file's bytes, or undefined when it cannot be read. Only a
 * regular file of at most MAX_LEXICON_BYTES is hashed (anything larger could
 * never be loaded): the path is a repository's, and a symlink to a device
 * such as `/dev/zero` must not turn a trust check into an unbounded read.
 */
export async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    const { bytes } = await readBoundedRegularFile(filePath, MAX_LEXICON_BYTES);
    // Loaded on first use: node:crypto costs the prompt hook several ms to
    // load, and the hook only hashes when a project lexicon exists.
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

export function trustAllEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[TRUST_ALL_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

// ---------------------------------------------------------------------------
// Registry IO
// ---------------------------------------------------------------------------

function emptyRegistry(): TrustRegistry {
  return { version: 1, trusted: {} };
}

function isTrustEntry(value: unknown): value is TrustEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { sha256?: unknown }).sha256 === 'string' &&
    typeof (value as { trustedAt?: unknown }).trustedAt === 'string'
  );
}

/**
 * Read the registry. A missing or unparseable file yields an empty registry:
 * the safe failure mode is "nothing is trusted", never "everything is".
 */
export async function readTrustRegistry(opts: StoreOptions = {}): Promise<TrustRegistry> {
  let text: string;
  try {
    text = await fs.readFile(getTrustPath(opts), 'utf8');
  } catch {
    return emptyRegistry();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyRegistry();
  }
  if (typeof raw !== 'object' || raw === null) return emptyRegistry();
  const trustedRaw = (raw as { trusted?: unknown }).trusted;
  if (typeof trustedRaw !== 'object' || trustedRaw === null) return emptyRegistry();
  const trusted: Record<string, TrustEntry> = {};
  for (const [key, value] of Object.entries(trustedRaw as Record<string, unknown>)) {
    if (isTrustEntry(value)) trusted[key] = { sha256: value.sha256, trustedAt: value.trustedAt };
  }
  return { version: 1, trusted };
}

/**
 * Run `fn` with exclusive access to the registry, across processes.
 *
 * Every mutation here is a read of the whole file, an edit of one key and a
 * write of the whole file back, and until this existed none of them was
 * locked. Six `lexicon add --project` runs in six different repositories:
 * one crashed renaming the temp file, and three of the six wrote their
 * lexicon, reported success, and were simply absent from the registry
 * afterwards, so on the next load those projects were untrusted and silently
 * skipped. At eight, seven crashed and one entry survived.
 *
 * Re-entrant, and always taken *inside* a lexicon file's lock, never outside
 * one: `addTerm` and `removeTerm` re-pin trust while holding theirs. See the
 * lock ordering note in `util/atomic.ts`.
 */
export function withTrustLock<T>(fn: () => Promise<T>, opts: StoreOptions = {}): Promise<T> {
  return withFileLock(getTrustPath(opts), fn);
}

export async function writeTrustRegistry(registry: TrustRegistry, opts: StoreOptions = {}): Promise<void> {
  await withTrustLock(() => writeFileAtomic(getTrustPath(opts), formatJson(registry)), opts);
}

// ---------------------------------------------------------------------------
// Queries + mutations
// ---------------------------------------------------------------------------

/**
 * True when `filePath` is the global lexicon itself or sits directly in the
 * global config directory (e.g. `~/.config/lexicon/.lexicon.yaml`). Only the
 * immediate directory counts: with `LEXICON_PATH=~/lexicon.yaml` a recursive
 * rule would silently trust every repository under the home directory.
 */
async function isInsideGlobalConfig(filePath: string, opts: StoreOptions): Promise<boolean> {
  const globalPath = await canonicalPath(resolvePaths(opts).global);
  const target = await canonicalPath(filePath);
  if (target === globalPath) return true;
  return path.dirname(target) === path.dirname(globalPath);
}

/**
 * 'trusted'   registered and content unchanged (or LEXICON_TRUST_ALL, or the file
 *             is the user's own global lexicon / directly in the global config dir)
 * 'changed'   registered but the content differs from the pinned sha256
 * 'untrusted' never registered
 *
 * A file that does not exist is 'trusted': there is nothing to inject.
 */
export async function isTrusted(projectFile: LexiconFile, opts: StoreOptions = {}): Promise<TrustStatus> {
  if (trustAllEnabled()) return 'trusted';
  if (!projectFile.exists) return 'trusted';
  if (await isInsideGlobalConfig(projectFile.path, opts)) return 'trusted';
  const key = await canonicalPath(projectFile.path);
  const registry = await readTrustRegistry(opts);
  const entry = registry.trusted[key];
  if (!entry) return 'untrusted';
  // The bytes that were parsed, when this object came from readLexiconFile:
  // a second read could see a different file than the one being merged.
  const sha = (await recalledParsedHash(projectFile)) ?? (await hashFile(key));
  if (sha === undefined) return 'untrusted';
  return sha === entry.sha256 ? 'trusted' : 'changed';
}

/**
 * The sha256 of the bytes `readLexiconFile` parsed for this object (project
 * scope), or undefined for an object it did not produce (a copy, a literal).
 * Pass it to `trustProject` as `expectedSha256` to pin exactly what a preview
 * showed.
 */
export function parsedContentHash(file: LexiconFile): Promise<string | undefined> {
  return recalledParsedHash(file);
}

/** Thrown by `trustProject` when the file no longer has the `expectedSha256` content. Nothing was pinned. */
export class TrustContentChangedError extends Error {
  readonly path: string;

  constructor(projectPath: string) {
    super(`${projectPath} changed since it was read; nothing was trusted`);
    this.name = 'TrustContentChangedError';
    this.path = projectPath;
  }
}

/** True for a `TrustContentChangedError` (duck-typed by name). */
export function isTrustContentChangedError(err: unknown): boolean {
  return err instanceof Error && err.name === 'TrustContentChangedError';
}

/**
 * Register (or re-pin) `projectPath` at its current content hash. The file must exist.
 * With `expectedSha256`, refuses (`TrustContentChangedError`, nothing written)
 * unless the file still holds exactly those bytes.
 */
export async function trustProject(
  projectPath: string,
  opts: StoreOptions & { expectedSha256?: string } = {},
): Promise<TrustEntry> {
  const key = await canonicalPath(projectPath);
  const sha256 = await hashFile(key);
  if (sha256 === undefined) throw new Error(`cannot read the project lexicon at ${projectPath}`);
  if (opts.expectedSha256 !== undefined && sha256 !== opts.expectedSha256) throw new TrustContentChangedError(projectPath);
  return withTrustLock(async () => {
    const registry = await readTrustRegistry(opts);
    const entry: TrustEntry = { sha256, trustedAt: new Date().toISOString() };
    registry.trusted[key] = entry;
    await writeTrustRegistry(registry, opts);
    return entry;
  }, opts);
}

/**
 * Re-pin the hash of a file that is ALREADY registered (after the user edits it
 * through this tool, so their own edit does not flip it to 'changed'). Does
 * nothing for unregistered files. Returns true when an entry was updated.
 */
export async function refreshTrust(
  projectPath: string,
  opts: StoreOptions & { expectedSha256?: string } = {},
): Promise<boolean> {
  const key = await canonicalPath(projectPath);
  return withTrustLock(async () => {
    const registry = await readTrustRegistry(opts);
    const existing = registry.trusted[key];
    if (!existing) return false;
    const sha256 = await hashFile(key);
    if (sha256 === undefined || sha256 === existing.sha256) return false;
    // With `expectedSha256` (the bytes the caller just wrote), a file
    // rewritten by someone else since is left on its old pin, so it reads
    // 'changed', rather than having their bytes pinned as the user's edit.
    if (opts.expectedSha256 !== undefined && sha256 !== opts.expectedSha256) return false;
    registry.trusted[key] = { sha256, trustedAt: existing.trustedAt };
    await writeTrustRegistry(registry, opts);
    return true;
  }, opts);
}

/**
 * The registry entry for `projectPath` as it stands, for a caller that may
 * have to roll a write back (`restoreTrustEntry`). Not exported from the
 * package: the pack registry's install and removal are the users.
 */
export async function trustEntryOf(projectPath: string, opts: StoreOptions = {}): Promise<TrustEntry | undefined> {
  const key = await canonicalPath(projectPath);
  const entry = (await readTrustRegistry(opts)).trusted[key];
  return entry ? { ...entry } : undefined;
}

/**
 * Put `projectPath`'s registry entry back to `entry` (or remove it), after a
 * failed operation restored the file's bytes. Re-hashing the restored file
 * instead (`refreshTrust`) pinned whatever the snapshot held, which is not
 * necessarily what the user had trusted: a file rewritten before the
 * operation took its lock was snapshotted, restored and blessed.
 */
export async function restoreTrustEntry(projectPath: string, entry: TrustEntry | undefined, opts: StoreOptions = {}): Promise<void> {
  const key = await canonicalPath(projectPath);
  await withTrustLock(async () => {
    const registry = await readTrustRegistry(opts);
    if (entry) registry.trusted[key] = { ...entry };
    else if (key in registry.trusted) delete registry.trusted[key];
    else return;
    await writeTrustRegistry(registry, opts);
  }, opts);
}

/** Remove `projectPath` from the registry. Returns false when it was not registered. */
export async function untrustProject(projectPath: string, opts: StoreOptions = {}): Promise<boolean> {
  const key = await canonicalPath(projectPath);
  return withTrustLock(async () => {
    const registry = await readTrustRegistry(opts);
    if (!(key in registry.trusted)) return false;
    delete registry.trusted[key];
    await writeTrustRegistry(registry, opts);
    return true;
  }, opts);
}

/** Every registered file with its current status, sorted by path. */
export async function listTrusted(opts: StoreOptions = {}): Promise<TrustListEntry[]> {
  const registry = await readTrustRegistry(opts);
  const out: TrustListEntry[] = [];
  for (const [filePath, entry] of Object.entries(registry.trusted)) {
    const sha = await hashFile(filePath);
    const status: TrustListEntry['status'] =
      sha === undefined ? 'missing' : sha === entry.sha256 ? 'trusted' : 'changed';
    out.push({ path: filePath, ...entry, status });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Terms listed in a trust preview before "... and N more". */
export const TRUST_PREVIEW_ROWS = 25;

/** One row of `trustPreview`: display-safe, notes reported as present only. */
export interface TrustPreviewRow {
  canonical: string;
  firstAlias?: string;
  aliasCount: number;
  hasNotes: boolean;
}

/** `trustPreview(file)`: the term count, the first TRUST_PREVIEW_ROWS rows and how many more there are. */
export interface TrustPreview {
  termCount: number;
  preview: TrustPreviewRow[];
  more: number;
}

/**
 * Compact, display-safe view of a project lexicon for the trust dialogue:
 * canonicals and the first alias only, sanitized, capped. Notes are reported
 * as present, never quoted: the file is untrusted input until the user says so.
 * MCP `trust_project` and `lexicon trust --json` both return it.
 */
export function trustPreview(file: LexiconFile): TrustPreview {
  const terms = file.lexicon.terms;
  const preview = terms.slice(0, TRUST_PREVIEW_ROWS).map((t): TrustPreviewRow => ({
    canonical: sanitizeForDisplay(t.canonical),
    ...(t.aliases.length > 0 ? { firstAlias: sanitizeForDisplay(t.aliases[0]) } : {}),
    aliasCount: t.aliases.length,
    hasNotes: typeof t.notes === 'string' && t.notes.trim() !== '',
  }));
  return { termCount: terms.length, preview, more: Math.max(0, terms.length - TRUST_PREVIEW_ROWS) };
}

/** Canonicals `trustSummaryForModel` names, at most. */
export const TRUST_MODEL_SAMPLE_ROWS = 3;

/** Longest canonical `trustSummaryForModel` names (ellipsis included). */
export const TRUST_MODEL_SAMPLE_MAX_CHARS = 40;

/** `trustSummaryForModel(file)`: counts, a few short canonicals and where the full preview is. */
export interface TrustModelSummary {
  termCount: number;
  aliasCount: number;
  termsWithNotes: number;
  /** At most TRUST_MODEL_SAMPLE_ROWS canonicals, each display-sanitized, neutralized and capped. */
  sample: string[];
  /** Terms not named in `sample`. */
  more: number;
  /** One sentence telling the model the full preview is for the user, in a terminal. */
  fullPreview: string;
}

/** What `trustSummaryForModel` says about the full preview. */
export const TRUST_FULL_PREVIEW_NOTE =
  'This is a summary. The full preview (every canonical and its first alias) is for the user, not for you: ' +
  'ask them to run `lexicon trust` in a terminal in that repo, which shows it and asks before trusting.';

/**
 * What MCP `trust_project` hands the model about a file it is being asked to
 * trust: counts, at most TRUST_MODEL_SAMPLE_ROWS canonicals (each through
 * `sanitizeForDisplayMax(_, TRUST_MODEL_SAMPLE_MAX_CHARS)` and
 * `neutralizeMarkup`), and a pointer to `lexicon trust` for the full preview.
 * `trustPreview` put 25 canonicals and first aliases, about 2 KB of the file's
 * own text, into the very exchange where the model is asked whether to trust
 * it. Aliases and notes are never quoted here. The CLI preview
 * (`trustPreview`) is unchanged.
 */
export function trustSummaryForModel(file: LexiconFile): TrustModelSummary {
  const terms = file.lexicon.terms;
  const sample = terms
    .slice(0, TRUST_MODEL_SAMPLE_ROWS)
    .map((t) => neutralizeMarkup(sanitizeForDisplayMax(t.canonical, TRUST_MODEL_SAMPLE_MAX_CHARS)));
  return {
    termCount: terms.length,
    aliasCount: terms.reduce((n, t) => n + t.aliases.length, 0),
    termsWithNotes: terms.filter((t) => typeof t.notes === 'string' && t.notes.trim() !== '').length,
    sample,
    more: Math.max(0, terms.length - sample.length),
    fullPreview: TRUST_FULL_PREVIEW_NOTE,
  };
}
