/**
 * whisper.cpp model resolution. `--model <name>` maps to `ggml-<name>.bin`
 * under the models directory (`LEXICON_WHISPER_MODELS`, else
 * `<dirname(globalPath)>/models/`), falling back to the repo's
 * `bench/audio/models/` so a checkout that already ran the audio benchmark
 * needs no second download. Missing named models are fetched from Hugging
 * Face with a progress line. `--model <path>` is used as-is.
 */
import { createWriteStream, existsSync, promises as fs } from 'node:fs';
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

/** The directory new models are downloaded into. */
export function modelsDir(globalPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.LEXICON_WHISPER_MODELS || path.join(path.dirname(globalPath), 'models');
}

export interface ResolveModelOptions {
  /** Global lexicon path; models live next to it by default. */
  globalPath: string;
  env?: NodeJS.ProcessEnv;
  /** Extra directories searched for an existing `ggml-<name>.bin` (default: the repo's bench models). */
  fallbackDirs?: readonly string[];
  /** Existence probe, injectable for tests. */
  exists?: (p: string) => boolean;
}

export interface ResolvedModel {
  /** `base.en`, or the basename for an explicit path. */
  name: string;
  /** Absolute path where the model is or will be. */
  path: string;
  /** True when the file is present. */
  present: boolean;
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

/** Locate a model without downloading anything. */
export function resolveModel(spec: string, opts: ResolveModelOptions): ResolvedModel {
  const exists = opts.exists ?? existsSync;
  if (isModelPath(spec)) {
    const abs = path.resolve(expandTilde(spec));
    const base = path.basename(abs);
    const name = base.replace(/^ggml-/, '').replace(/\.bin$/, '');
    return { name, path: abs, present: exists(abs) };
  }
  const file = modelFileName(spec);
  const primary = path.join(modelsDir(opts.globalPath, opts.env), file);
  if (exists(primary)) return { name: spec, path: primary, present: true, url: modelUrl(spec) };
  for (const dir of opts.fallbackDirs ?? (REPO_MODELS_DIR ? [REPO_MODELS_DIR] : [])) {
    const candidate = path.join(dir, file);
    if (exists(candidate)) return { name: spec, path: candidate, present: true, foundIn: dir, url: modelUrl(spec) };
  }
  return { name: spec, path: primary, present: false, url: modelUrl(spec) };
}

export interface DownloadProgress {
  received: number;
  total?: number;
}

/** Fetch `url` into `dest` (atomically via a `.part` file). Injectable for tests. */
export type Downloader = (url: string, dest: string, onProgress: (p: DownloadProgress) => void) => Promise<void>;

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

export async function defaultDownloader(url: string, dest: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await sweepStaleParts(dest);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get('content-length')) || undefined;
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
    onProgress({ received, total });
  });
  try {
    await pipeline(source, createWriteStream(tmp));
    const bad = checkDownloadedModel(head, received, total);
    if (bad !== undefined) throw new Error(`${bad} (${url})`);
    await fs.rename(tmp, dest);
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
}

/** Resolve a model, downloading a named one when absent. Throws for a missing explicit path. */
export async function ensureModel(spec: string, opts: EnsureModelOptions): Promise<ResolvedModel> {
  const resolved = resolveModel(spec, opts);
  if (resolved.present) return resolved;
  if (!resolved.url) {
    throw new Error(`whisper model not found: ${resolved.path}`);
  }
  const download = opts.download ?? defaultDownloader;
  const log = opts.log ?? ((s: string) => void process.stderr.write(`${s}\n`));
  const progress = opts.progress ?? ((s: string) => void process.stderr.write(`\r${s}`));
  log(`whisper model ${resolved.name} not found; fetching ${resolved.url} -> ${resolved.path}`);
  let lastPct = -1;
  try {
    await download(resolved.url, resolved.path, (p) => {
      const pct = p.total ? Math.floor((p.received / p.total) * 100) : Math.floor(p.received / 8_388_608);
      if (pct !== lastPct) {
        lastPct = pct;
        progress(formatProgress(modelFileName(resolved.name), p));
      }
    });
  } catch (e) {
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
