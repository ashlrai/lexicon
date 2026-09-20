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
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MODEL = 'base.en';
export const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** Where a source or dist checkout keeps the benchmark's models (../../bench/audio/models from src/voice or dist/voice). */
export const REPO_MODELS_DIR: string = fileURLToPath(new URL('../../bench/audio/models/', import.meta.url));

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
 * three platforms.
 */
export function expandTilde(spec: string, home: string = os.homedir()): string {
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
  for (const dir of opts.fallbackDirs ?? [REPO_MODELS_DIR]) {
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

export async function defaultDownloader(url: string, dest: string, onProgress: (p: DownloadProgress) => void): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get('content-length')) || undefined;
  let received = 0;
  const tmp = `${dest}.part`;
  const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress({ received, total });
  });
  try {
    await pipeline(source, createWriteStream(tmp));
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
  await download(resolved.url, resolved.path, (p) => {
    const pct = p.total ? Math.floor((p.received / p.total) * 100) : Math.floor(p.received / 8_388_608);
    if (pct !== lastPct) {
      lastPct = pct;
      progress(formatProgress(modelFileName(resolved.name), p));
    }
  });
  log('');
  return { ...resolved, present: true };
}
