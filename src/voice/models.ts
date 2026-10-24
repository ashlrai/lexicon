/**
 * whisper.cpp model resolution. `--model <name>` maps to `ggml-<name>.bin`
 * under the models directory (`LEXICON_WHISPER_MODELS`, else
 * `<dirname(globalPath)>/models/`), falling back to the repo's
 * `bench/audio/models/` so a checkout that already ran the audio benchmark
 * needs no second download. Missing named models are fetched from Hugging
 * Face with a progress line. `--model <path>` is used as-is.
 */
import { createHash } from 'node:crypto';
import { closeSync, createWriteStream, openSync, promises as fs, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { homeDir, usableHome } from '../util/xdg.js';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findPackageRoot } from '../util/package.js';

export const DEFAULT_MODEL = 'base.en';
export const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/**
 * Where a source or dist checkout keeps the benchmark's models:
 * `<package root>/bench/audio/models`, the root found by the package.json walk.
 * Not a fixed `../../` from this module: that is right for src/voice and
 * dist/voice, but the plugin bundle (plugin/mcp-server.mjs) sits one level
 * below the root, so it pointed outside the package, at a sibling directory
 * of the npm install or of Claude Code's plugin cache. Undefined when no
 * `@ashlr/lexicon` package.json is found above this module.
 */
export const REPO_MODELS_DIR: string | undefined = repoModelsDir();

function repoModelsDir(): string | undefined {
  const root = findPackageRoot(import.meta.url);
  return root ? path.join(root, 'bench', 'audio', 'models') : undefined;
}

export function modelFileName(name: string): string {
  return `ggml-${name}.bin`;
}

export function modelUrl(name: string): string {
  return `${MODEL_BASE_URL}/${modelFileName(name)}`;
}

/**
 * The directory new models are downloaded into: `LEXICON_WHISPER_MODELS`
 * with a leading `~/` expanded, else `<dirname(globalPath)>/models`. A
 * relative value throws: it was used as is, so `~/models` named a directory
 * called `~` under whatever the current directory was, and `models` a
 * different directory from every working directory `lexicon voice` ran in
 * (a model downloaded again and again, and `lexicon doctor` looking in yet
 * another place).
 */
export function modelsDir(globalPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.LEXICON_WHISPER_MODELS;
  if (!raw) return path.join(path.dirname(globalPath), 'models');
  const dir = expandTilde(raw);
  if (!path.isAbsolute(dir)) {
    throw new Error(
      `LEXICON_WHISPER_MODELS must be an absolute path or start with ~/ (it is ${JSON.stringify(raw)}); a relative one would mean a different directory in every working directory`,
    );
  }
  return dir;
}

export interface ResolveModelOptions {
  /** Global lexicon path; models live next to it by default. */
  globalPath: string;
  env?: NodeJS.ProcessEnv;
  /** Extra directories searched for an existing `ggml-<name>.bin` (default: the repo's bench models). */
  fallbackDirs?: readonly string[];
  /**
   * Existence probe, injectable for tests. With it (and no `inspect`) a file
   * that exists counts as a model without being read.
   */
  exists?: (p: string) => boolean;
  /**
   * What is at `p`: `'missing'`, undefined for a usable model, or why the file
   * there is not one. Default inspectModelFile (or `exists` alone, see above).
   */
  inspect?: (p: string) => string | undefined | 'missing';
}

export interface ResolvedModel {
  /** `base.en`, or the basename for an explicit path. */
  name: string;
  /** Absolute path where the model is or will be. */
  path: string;
  /** True when a usable model file is present (see inspectModelFile). */
  present: boolean;
  /** Set when a file is at `path` but is not a usable model: why (`present` is false). */
  problem?: string;
  /**
   * With `problem`: the file is a model that changed since Lexicon
   * downloaded it (its sha256 no longer matches the record), so it is not
   * replaced by a fresh download: it may be the user's own.
   */
  modified?: true;
  /** Set when the model was found somewhere other than the primary models dir. */
  foundIn?: string;
  /** For named models only: the download URL. */
  url?: string;
}

/**
 * Expand a leading `~/` (and `~\\` on Windows) against the real home
 * directory. `process.env.HOME` is undefined on Windows -- it is `USERPROFILE`
 * there -- so the old `process.env.HOME ?? ''` silently turned
 * `~/models/ggml-base.en.bin` into a *cwd-relative* path, and the model was
 * reported missing wherever it actually was. `os.homedir()` answers on all
 * three platforms, and goes through `usableHome` (src/util/xdg.ts) so an
 * empty or relative HOME is not used as is.
 */
export function expandTilde(spec: string, homeArg?: string): string {
  if (spec !== '~' && !spec.startsWith('~/') && !(process.platform === 'win32' && spec.startsWith('~\\'))) return spec;
  // HOME= or a relative HOME would make the expansion cwd-relative.
  const home = homeArg === undefined ? homeDir() : usableHome(homeArg);
  if (spec === '~') return home;
  if (spec.startsWith('~/')) return path.join(home, spec.slice(2));
  if (process.platform === 'win32' && spec.startsWith('~\\')) return path.join(home, spec.slice(2));
  return spec;
}

/** Looks like a filesystem path rather than a model name. */
export function isModelPath(value: string): boolean {
  return value.endsWith('.bin') || value.includes('/') || value.includes('\\') || value.startsWith('.') || value.startsWith('~');
}

/**
 * Whether the file at `p` can be a whisper.cpp model: `'missing'` when
 * nothing (or no regular file) is there, a reason when it is empty or does
 * not start with GGML_MAGIC, undefined when it does. Reads 4 bytes. A file
 * that exists was taken as the model as it was: an empty file, or an error
 * page saved by hand or by an older download, made whisper-cli fail on every
 * dictation ("failed to load model") until it was found and deleted.
 */
export function inspectModelFile(p: string): string | undefined | 'missing' {
  let size: number;
  try {
    const st = statSync(p);
    if (!st.isFile()) return 'missing';
    size = st.size;
  } catch {
    return 'missing';
  }
  if (size === 0) return 'the file is empty';
  const head = Buffer.alloc(GGML_MAGIC.length);
  let read = 0;
  try {
    const fd = openSync(p, 'r');
    try {
      read = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return `it cannot be read (${e instanceof Error ? e.message : String(e)})`;
  }
  if (read < GGML_MAGIC.length || !head.equals(GGML_MAGIC)) return 'it is not a ggml whisper model (it does not start with the ggml magic bytes)';
  return undefined;
}

/**
 * Beside every model Lexicon downloads, `<model>.sha256.json` records its
 * sha256 with the size and mtime it had then (MODEL_HASH_VERSION). Lexicon
 * ships no table of known-good hashes for the models (none it can check
 * offline, and Hugging Face can replace a file); the download is checked
 * against the sha256 Hugging Face sends for the file (`X-Linked-Etag`) when
 * there is one, and the record lets every later use notice a model that
 * changed on disk without hashing hundreds of megabytes each time: the hash
 * is computed again only when the size or mtime moved.
 */
export const MODEL_HASH_SUFFIX = '.sha256.json';
export const MODEL_HASH_VERSION = 1;

interface ModelHashRecord {
  version: number;
  sha256: string;
  size: number;
  mtimeMs: number;
}

/** `<model>.sha256.json`. */
export function modelHashPath(modelPath: string): string {
  return `${modelPath}${MODEL_HASH_SUFFIX}`;
}

/** The sha256 (hex) of the file at `p`, read in 1 MiB chunks. */
export function sha256OfFile(p: string): string {
  const hash = createHash('sha256');
  const buf = Buffer.alloc(1024 * 1024);
  const fd = openSync(p, 'r');
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Write the hash record of the model at `modelPath` (its current size and
 * mtime). With `ino`, only while the file there is still that inode: of two
 * downloads renaming into place at once, each records only its own file.
 * Best effort, never throws.
 */
export function writeModelHashRecord(modelPath: string, sha256: string, ino?: number): void {
  try {
    const st = statSync(modelPath);
    if (ino !== undefined && st.ino !== ino) return;
    const record: ModelHashRecord = { version: MODEL_HASH_VERSION, sha256, size: st.size, mtimeMs: st.mtimeMs };
    writeFileSync(modelHashPath(modelPath), `${JSON.stringify(record)}\n`, { mode: 0o644 });
  } catch {
    // a record, not the model: the model is still used, just not verified later
  }
}

/** The model's hash record, when one parses. */
function readModelHashRecord(modelPath: string): ModelHashRecord | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(modelHashPath(modelPath), 'utf8'));
    const r = raw as Partial<ModelHashRecord> | null;
    if (r && r.version === MODEL_HASH_VERSION && typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) && typeof r.size === 'number' && typeof r.mtimeMs === 'number') {
      return r as ModelHashRecord;
    }
  } catch {
    // none, or not ours
  }
  return undefined;
}

/** The `modified` reason of a model that no longer matches its record. */
export const MODEL_CHANGED_PREFIX = 'it changed since Lexicon downloaded it';

/**
 * Why the model at `modelPath` no longer matches the sha256 recorded at its
 * download, or undefined when it does (or there is no record: a model Lexicon
 * did not download is not checked). The file is hashed only when its size or
 * mtime differs from the record's; a match under a new mtime updates the
 * record. Never throws. Exported for tests.
 */
export function checkModelHashRecord(modelPath: string): string | undefined {
  const record = readModelHashRecord(modelPath);
  if (!record) return undefined;
  let st;
  try {
    st = statSync(modelPath);
  } catch {
    return undefined;
  }
  if (st.size === record.size && st.mtimeMs === record.mtimeMs) return undefined;
  const fix = `delete it to download it again, or delete ${modelHashPath(modelPath)} to keep using it as it is`;
  if (st.size !== record.size) return `${MODEL_CHANGED_PREFIX} (${st.size} bytes now, ${record.size} then); ${fix}`;
  let actual: string;
  try {
    actual = sha256OfFile(modelPath);
  } catch {
    return undefined;
  }
  if (actual !== record.sha256) return `${MODEL_CHANGED_PREFIX} (its sha256 is ${actual}, not the ${record.sha256} recorded); ${fix}`;
  writeModelHashRecord(modelPath, actual);
  return undefined;
}

/** inspectModelFile, then the hash record (checkModelHashRecord) of a file that passed. */
function inspectAndVerify(p: string): string | undefined | 'missing' {
  return inspectModelFile(p) ?? checkModelHashRecord(p);
}

/** Locate a model without downloading anything. */
export function resolveModel(spec: string, opts: ResolveModelOptions): ResolvedModel {
  const exists = opts.exists;
  const inspect = opts.inspect ?? (exists ? (p: string) => (exists(p) ? undefined : 'missing') : inspectAndVerify);
  const flagged = (problem: string): { problem: string; modified?: true } =>
    problem.startsWith(MODEL_CHANGED_PREFIX) ? { problem, modified: true } : { problem };
  if (isModelPath(spec)) {
    const abs = path.resolve(expandTilde(spec));
    const base = path.basename(abs);
    const name = base.replace(/^ggml-/, '').replace(/\.bin$/, '');
    const found = inspect(abs);
    return { name, path: abs, present: found === undefined, ...(found !== undefined && found !== 'missing' ? flagged(found) : {}) };
  }
  const file = modelFileName(spec);
  const primary = path.join(modelsDir(opts.globalPath, opts.env), file);
  const atPrimary = inspect(primary);
  if (atPrimary === undefined) return { name: spec, path: primary, present: true, url: modelUrl(spec) };
  // A fallback copy is used only when it is a model; a broken one is passed over.
  for (const dir of opts.fallbackDirs ?? (REPO_MODELS_DIR ? [REPO_MODELS_DIR] : [])) {
    const candidate = path.join(dir, file);
    if (inspect(candidate) === undefined) return { name: spec, path: candidate, present: true, foundIn: dir, url: modelUrl(spec) };
  }
  return { name: spec, path: primary, present: false, url: modelUrl(spec), ...(atPrimary !== 'missing' ? flagged(atPrimary) : {}) };
}

export interface DownloadProgress {
  received: number;
  total?: number;
}

/**
 * Fetch `url` into `dest` (atomically via a `.part` file). Injectable for
 * tests. `signal` aborts the download (Ctrl-C): nothing is kept and the
 * promise rejects.
 */
export type Downloader = (url: string, dest: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal) => Promise<void>;

/**
 * The first bytes of every whisper.cpp ggml model: GGML_FILE_MAGIC
 * (0x67676d6c) as a little-endian uint32, "lmgg".
 */
export const GGML_MAGIC = Buffer.from([0x6c, 0x6d, 0x67, 0x67]);

/**
 * Why a finished download is not a model to keep, or undefined when it is:
 * fewer bytes than the server's Content-Length said (a connection that ended
 * early), or a file that does not start with GGML_MAGIC (an error or login
 * page served with status 200 by a proxy or a captive portal). Either was
 * renamed into place as the model, and whisper-cli then failed on every
 * dictation with "failed to load model" until the user found the file and
 * deleted it.
 */
export function checkDownloadedModel(head: Buffer, received: number, total: number | undefined): string | undefined {
  if (total !== undefined && received !== total) return `the download ended after ${received} of ${total} bytes`;
  if (head.length < GGML_MAGIC.length || !head.subarray(0, GGML_MAGIC.length).equals(GGML_MAGIC)) {
    return 'the file downloaded is not a ggml whisper model (it does not start with the ggml magic bytes)';
  }
  return undefined;
}

/**
 * A part file untouched this long belongs to a download that died (killed,
 * or the machine slept through it): a live one writes to its file all the
 * time. Ten minutes, well past any stall a download survives.
 */
export const STALE_PART_MS = 10 * 60 * 1000;

/**
 * Remove the part files of `dest` that dead downloads left behind
 * (`<dest>.part` from older versions, `<dest>.<id>.part` now), each up to the
 * size of a model. One a live download is still writing is newer than
 * STALE_PART_MS and is left alone. Never throws.
 */
export async function sweepStaleParts(dest: string, nowMs: number = Date.now()): Promise<void> {
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(`${base}.`) || !name.endsWith('.part')) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      if (st.isFile() && nowMs - st.mtimeMs > STALE_PART_MS) await fs.rm(file, { force: true });
    } catch {
      // gone already, or not ours to remove
    }
  }
}

/**
 * The sha256 the server states for the file: Hugging Face sends it for a
 * Git LFS file (every ggml model) as `X-Linked-Etag`, and as `ETag` on the
 * final redirect hop. Only a 64-hex value counts. Exported for tests.
 */
export function claimedSha256(headers: Headers): string | undefined {
  for (const name of ['x-linked-etag', 'etag']) {
    const value = headers.get(name)?.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase();
    if (value && /^[0-9a-f]{64}$/.test(value)) return value;
  }
  return undefined;
}

export async function defaultDownloader(url: string, dest: string, onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await sweepStaleParts(dest);
  const res = await fetch(url, { redirect: 'follow', ...(signal ? { signal } : {}) });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get('content-length')) || undefined;
  const claimed = claimedSha256(res.headers);
  const hash = createHash('sha256');
  let received = 0;
  let head = Buffer.alloc(0);
  // One `.part` file per download: two `lexicon voice` runs fetching the same
  // model at once wrote into one shared `<dest>.part`, interleaving their
  // bytes, and the second rename failed (or renamed the other's half file).
  const tmp = `${dest}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.part`;
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  source.on('data', (chunk: Buffer) => {
    if (head.length < GGML_MAGIC.length) head = Buffer.concat([head, chunk.subarray(0, GGML_MAGIC.length - head.length)]);
    received += chunk.length;
    hash.update(chunk);
    onProgress({ received, total });
  });
  try {
    await pipeline(source, createWriteStream(tmp), ...(signal ? [{ signal }] : []));
    const bad = checkDownloadedModel(head, received, total);
    if (bad !== undefined) throw new Error(`${bad} (${url})`);
    const sha256 = hash.digest('hex');
    if (claimed !== undefined && claimed !== sha256) {
      throw new Error(`the file downloaded does not match the sha256 the server gave for it (${claimed}; the download's is ${sha256}) (${url})`);
    }
    const { ino } = await fs.stat(tmp);
    await fs.rename(tmp, dest);
    writeModelHashRecord(dest, sha256, ino);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

function mb(n: number): string {
  return `${(n / 1_048_576).toFixed(0)} MB`;
}

export function formatProgress(name: string, p: DownloadProgress): string {
  if (p.total) return `downloading ${name} ${Math.floor((p.received / p.total) * 100)}% (${mb(p.received)} / ${mb(p.total)})`;
  return `downloading ${name} ${mb(p.received)}`;
}

export interface EnsureModelOptions extends ResolveModelOptions {
  download?: Downloader;
  /** Progress sink (stderr). Called with a line to print; carriage-return updates use `progress`. */
  log?: (line: string) => void;
  progress?: (line: string) => void;
  /** Aborts a download in progress (passed to the downloader). */
  signal?: AbortSignal;
}

/** Resolve a model, downloading a named one when absent. Throws for a missing explicit path. */
export async function ensureModel(spec: string, opts: EnsureModelOptions): Promise<ResolvedModel> {
  const resolved = resolveModel(spec, opts);
  if (resolved.present) return resolved;
  if (!resolved.url || resolved.modified) {
    if (resolved.problem !== undefined) throw new Error(`whisper model ${resolved.path} is not usable: ${resolved.problem}`);
    throw new Error(`whisper model not found: ${resolved.path}`);
  }
  const download = opts.download ?? defaultDownloader;
  const log = opts.log ?? ((s: string) => void process.stderr.write(`${s}\n`));
  const progress = opts.progress ?? ((s: string) => void process.stderr.write(`\r${s}`));
  // A broken file where the model belongs is replaced: the download renames over it.
  log(
    resolved.problem !== undefined
      ? `whisper model ${resolved.name} at ${resolved.path} is not usable (${resolved.problem}); fetching ${resolved.url} again`
      : `whisper model ${resolved.name} not found; fetching ${resolved.url} -> ${resolved.path}`,
  );
  let lastPct = -1;
  try {
    await download(resolved.url, resolved.path, (p) => {
      const pct = p.total ? Math.floor((p.received / p.total) * 100) : Math.floor(p.received / 8_388_608);
      if (pct !== lastPct) {
        lastPct = pct;
        progress(formatProgress(modelFileName(resolved.name), p));
      }
    }, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted) throw new Error(`the download of whisper model ${resolved.name} was interrupted; nothing was kept`);
    // The failure alone ("fetch failed") said nothing about what to do next.
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `could not download whisper model ${resolved.name}: ${why}; check the network and try again, ` +
        `or save ${resolved.url} as ${resolved.path} yourself, or pass --model <file> with a ggml model you have`,
    );
  }
  log('');
  return { ...resolved, present: true };
}
