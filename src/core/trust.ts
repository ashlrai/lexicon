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
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolvePaths } from './store.js';
import type { StoreOptions } from './store.js';
import type { LexiconFile } from './types.js';

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

/** Hex sha256 of a file's bytes, or undefined when it cannot be read. */
export async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
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

/** Atomic write (tmp + rename), mkdir -p, like store.ts. */
export async function writeTrustRegistry(registry: TrustRegistry, opts: StoreOptions = {}): Promise<void> {
  const target = getTrustPath(opts);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
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
  const sha = await hashFile(key);
  if (sha === undefined) return 'untrusted';
  return sha === entry.sha256 ? 'trusted' : 'changed';
}

/** Register (or re-pin) `projectPath` at its current content hash. The file must exist. */
export async function trustProject(projectPath: string, opts: StoreOptions = {}): Promise<TrustEntry> {
  const key = await canonicalPath(projectPath);
  const sha256 = await hashFile(key);
  if (sha256 === undefined) throw new Error(`trustProject: cannot read ${projectPath}`);
  const registry = await readTrustRegistry(opts);
  const entry: TrustEntry = { sha256, trustedAt: new Date().toISOString() };
  registry.trusted[key] = entry;
  await writeTrustRegistry(registry, opts);
  return entry;
}

/**
 * Re-pin the hash of a file that is ALREADY registered (after the user edits it
 * through this tool, so their own edit does not flip it to 'changed'). Does
 * nothing for unregistered files. Returns true when an entry was updated.
 */
export async function refreshTrust(projectPath: string, opts: StoreOptions = {}): Promise<boolean> {
  const key = await canonicalPath(projectPath);
  const registry = await readTrustRegistry(opts);
  const existing = registry.trusted[key];
  if (!existing) return false;
  const sha256 = await hashFile(key);
  if (sha256 === undefined || sha256 === existing.sha256) return false;
  registry.trusted[key] = { sha256, trustedAt: existing.trustedAt };
  await writeTrustRegistry(registry, opts);
  return true;
}

/** Remove `projectPath` from the registry. Returns false when it was not registered. */
export async function untrustProject(projectPath: string, opts: StoreOptions = {}): Promise<boolean> {
  const key = await canonicalPath(projectPath);
  const registry = await readTrustRegistry(opts);
  if (!(key in registry.trusted)) return false;
  delete registry.trusted[key];
  await writeTrustRegistry(registry, opts);
  return true;
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
