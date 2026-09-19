/**
 * Real-audio benchmark: macOS `say` -> whisper.cpp -> normalize().
 *
 * The main benchmark (bench/run.ts) feeds the matcher hand-written STT errors.
 * This one produces the errors with an actual recognizer: every sentence in
 * bench/audio/sentences.jsonl is synthesized with two or three macOS voices,
 * transcribed with whisper.cpp, and the transcript is what normalize() sees.
 *
 *   npm run bench:audio                          base.en + small.en, 3 voices, with and without --prompt
 *   npm run bench:audio -- --models base.en      one model (comma-separated list)
 *   npm run bench:audio -- --voices Samantha     one voice (comma-separated list)
 *   npm run bench:audio -- --no-prompt           skip the whisper initial_prompt variants
 *   npm run bench:audio -- --limit 10            first 10 sentences only (smoke test)
 *   npm run bench:audio -- --filter person       one category
 *   npm run bench:audio -- --verbose             print every failing clip
 *   npm run bench:audio -- --force               re-transcribe even if cached
 *
 * Requirements: macOS (`say`), whisper.cpp (`brew install whisper-cpp`, or set
 * WHISPER_CLI to the binary). Models are downloaded into bench/audio/models/ on
 * first use (~148 MB for base.en, ~488 MB for small.en). Audio and transcripts
 * are cached under bench/audio/out/ (gitignored) so re-runs only do what is
 * missing. Output: bench/audio/results.md (committed) and bench/audio/out/results.json.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { distance } from 'fastest-levenshtein';
import { exportWhisperPrompt } from '../../src/core/index.js';
import type { Lexicon, MatchReason } from '../../src/core/types.js';
import {
  CATEGORIES,
  DEFAULT_LEXICON,
  isHard,
  loadLexicon,
  runBench,
  type BenchCase,
  type BenchCategory,
  type BenchReport,
} from '../lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTENCES = join(HERE, 'sentences.jsonl');
const OUT_DIR = join(HERE, 'out');
const WAV_DIR = join(OUT_DIR, 'wav');
const MODEL_DIR = join(HERE, 'models');
const CACHE_PATH = join(OUT_DIR, 'transcripts.json');
const RESULTS_MD = join(HERE, 'results.md');
const RESULTS_JSON = join(OUT_DIR, 'results.json');
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

const DEFAULT_MODELS = ['base.en', 'small.en'];
const DEFAULT_VOICES = ['Samantha', 'Daniel', 'Karen'];
const SAY_CONCURRENCY = 4;
const WHISPER_BATCH = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Sentence {
  id: string;
  category: BenchCategory;
  /** Ground truth: what the speaker meant, canonical spellings included. */
  expected: string;
  /** What is fed to TTS. Differs from `expected` only where the spelling would be mispronounced. */
  spoken: string;
  terms: string[];
  note?: string;
}

interface Clip {
  sentence: Sentence;
  voice: string;
  /** `${id}@${voice}` */
  key: string;
  wav: string;
}

interface Variant {
  model: string;
  prompt: boolean;
  /** e.g. "base.en" or "base.en + prompt" */
  label: string;
}

interface CacheEntry {
  heard: string;
  at: string;
}

interface Cache {
  version: 1;
  entries: Record<string, CacheEntry>;
}

interface Args {
  models: string[];
  voices: string[];
  prompt: boolean;
  filter?: BenchCategory;
  verbose: boolean;
  force: boolean;
  limit?: number;
  lexicon: string;
}

type Outcome = 'raw' | MatchReason | 'missed';

interface VariantHeard {
  n: number;
  outcomes: Record<Outcome, number>;
}

interface TermStats {
  canonical: string;
  category: string;
  slots: number;
  rawHit: number;
  afterHit: number;
  /** What Whisper wrote in the term's slot -> how often, and what happened to it. */
  heard: Map<string, VariantHeard>;
}

interface VoiceStats {
  voice: string;
  clips: number;
  termSlots: number;
  rawHit: number;
  afterHit: number;
  sentenceRaw: number;
  sentenceAfter: number;
  positives: number;
  negatives: number;
  negativesChanged: number;
}

interface ClipFailure {
  key: string;
  category: BenchCategory;
  hard: boolean;
  negative: boolean;
  heard: string;
  output: string;
  expected: string;
  missed: string[];
  spurious: string[];
}

interface VariantReport {
  variant: Variant;
  clips: number;
  report: Omit<BenchReport, 'results'>;
  sentence: {
    /** Loose (case/punctuation folded) sentence accuracy of the raw transcript, positives only. */
    rawPositives: number;
    afterPositives: number;
    positives: number;
  };
  byVoice: VoiceStats[];
  terms: TermStats[];
  failures: ClipFailure[];
  seconds: number;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(`usage: node --import tsx bench/audio/run.ts [options]
  --models <a,b>          whisper models (default ${DEFAULT_MODELS.join(',')}); ggml-<name>.bin under bench/audio/models
  --voices <a,b>          macOS voices (default ${DEFAULT_VOICES.join(',')}); \`say -v '?'\` lists them
  --no-prompt             skip the "whisper --prompt <lexicon export whisper-prompt>" variants
  --filter <category>     ${CATEGORIES.join('|')}
  --limit <n>             only the first n sentences
  --verbose               print every failing clip
  --force                 ignore cached transcripts (audio is always reused)
  --lexicon <file>        lexicon path (default bench/lexicon.yaml)`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { models: DEFAULT_MODELS, voices: DEFAULT_VOICES, prompt: true, verbose: false, force: false, lexicon: DEFAULT_LEXICON };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (a) {
      case '--models':
        args.models = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--voices':
        args.voices = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--no-prompt':
        args.prompt = false;
        break;
      case '--filter': {
        const v = next() as BenchCategory;
        if (!CATEGORIES.includes(v)) usage();
        args.filter = v;
        break;
      }
      case '--limit': {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) usage();
        args.limit = n;
        break;
      }
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--force':
        args.force = true;
        break;
      case '--lexicon':
        args.lexicon = next();
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`unknown option: ${a}`);
        usage();
    }
  }
  if (args.models.length === 0 || args.voices.length === 0) usage();
  return args;
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

function loadSentences(path: string): Sentence[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const seen = new Set<string>();
  return lines.map((line, i) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`sentences line ${i + 1}: invalid JSON (${(err as Error).message})`);
    }
    if (typeof raw !== 'object' || raw === null) throw new Error(`sentences line ${i + 1}: not an object`);
    const c = raw as Record<string, unknown>;
    const str = (k: string): string => {
      if (typeof c[k] !== 'string') throw new Error(`sentences line ${i + 1}: "${k}" must be a string`);
      return c[k] as string;
    };
    const id = str('id');
    if (seen.has(id)) throw new Error(`sentences line ${i + 1}: duplicate id "${id}"`);
    seen.add(id);
    const category = str('category') as BenchCategory;
    if (!CATEGORIES.includes(category)) throw new Error(`sentences line ${i + 1} (${id}): unknown category "${category}"`);
    const expected = str('expected');
    if (!Array.isArray(c.terms) || !c.terms.every((t) => typeof t === 'string')) {
      throw new Error(`sentences line ${i + 1} (${id}): "terms" must be a string array`);
    }
    const terms = c.terms as string[];
    for (const t of terms) {
      if (!expected.includes(t)) throw new Error(`sentences line ${i + 1} (${id}): expected text does not contain term "${t}"`);
    }
    const spoken = c.spoken === undefined ? expected : str('spoken');
    const out: Sentence = { id, category, expected, spoken, terms };
    if (c.note !== undefined) out.note = str('note');
    return out;
  });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function log(msg: string): void {
  console.error(msg);
}

function findWhisperCli(): string {
  const candidates = [process.env.WHISPER_CLI, '/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  for (const p of candidates) if (existsSync(p)) return p;
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, 'whisper-cli');
    if (dir && existsSync(p)) return p;
  }
  throw new Error('whisper-cli not found. Install whisper.cpp (`brew install whisper-cpp`) or set WHISPER_CLI=/path/to/whisper-cli.');
}

function findFfmpeg(): string {
  for (const p of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (existsSync(p)) return p;
  return 'ffmpeg';
}

async function ensureModel(name: string): Promise<string> {
  const file = join(MODEL_DIR, `ggml-${name}.bin`);
  if (existsSync(file)) return file;
  mkdirSync(MODEL_DIR, { recursive: true });
  const url = `${MODEL_BASE_URL}/ggml-${name}.bin`;
  log(`downloading ${url} -> ${file}`);
  const tmp = `${file}.part`;
  const r = await run('curl', ['-L', '--fail', '--silent', '--show-error', '-o', tmp, url]);
  if (r.code !== 0) throw new Error(`model download failed (${r.stderr.trim()}). Fetch it manually:\n  curl -L -o ${file} ${url}`);
  renameSync(tmp, file);
  return file;
}

// ---------------------------------------------------------------------------
// Synthesis and transcription
// ---------------------------------------------------------------------------

function hash8(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

function makeClips(sentences: Sentence[], voices: string[]): Clip[] {
  const clips: Clip[] = [];
  for (const voice of voices) {
    for (const sentence of sentences) {
      clips.push({
        sentence,
        voice,
        key: `${sentence.id}@${voice}`,
        wav: join(WAV_DIR, `${sentence.id}.${voice}.${hash8(sentence.spoken)}.wav`),
      });
    }
  }
  return clips;
}

/** `say` writes 16 kHz mono s16 WAV directly; fall back to AIFF + ffmpeg if this build cannot. */
async function synthesize(clip: Clip): Promise<void> {
  if (existsSync(clip.wav)) return;
  const tmpWav = `${clip.wav}.tmp.wav`;
  const direct = await run('say', ['-v', clip.voice, '-o', tmpWav, '--data-format=LEI16@16000', clip.sentence.spoken]);
  if (direct.code === 0 && existsSync(tmpWav)) {
    renameSync(tmpWav, clip.wav);
    return;
  }
  const aiff = `${clip.wav}.tmp.aiff`;
  const viaAiff = await run('say', ['-v', clip.voice, '-o', aiff, clip.sentence.spoken]);
  if (viaAiff.code !== 0) throw new Error(`say failed for ${clip.key}: ${(direct.stderr || viaAiff.stderr).trim()}`);
  const conv = await run(findFfmpeg(), ['-loglevel', 'error', '-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav]);
  if (existsSync(aiff)) unlinkSync(aiff);
  if (conv.code !== 0) throw new Error(`ffmpeg failed for ${clip.key}: ${conv.stderr.trim()}`);
  renameSync(tmpWav, clip.wav);
}

function loadCache(): Cache {
  if (!existsSync(CACHE_PATH)) return { version: 1, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Cache;
    if (parsed.version === 1 && parsed.entries) return parsed;
  } catch {
    // corrupt cache: start over
  }
  return { version: 1, entries: {} };
}

function saveCache(cache: Cache): void {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1) + '\n');
}

function cacheKey(variant: Variant, prompt: string | undefined, clip: Clip): string {
  const p = variant.prompt ? `p:${hash8(prompt ?? '')}` : 'nop';
  return `${variant.model}|${p}|${clip.voice}|${clip.sentence.id}|${hash8(clip.sentence.spoken)}`;
}

/** Whisper output -> one line: strip [BLANK_AUDIO]/(noise) tags, collapse whitespace. */
function cleanHeard(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface WhisperJson {
  transcription?: Array<{ text?: string }>;
}

async function transcribe(cli: string, modelPath: string, variant: Variant, prompt: string | undefined, clips: Clip[], cache: Cache, force: boolean): Promise<void> {
  const todo = clips.filter((c) => force || !cache.entries[cacheKey(variant, prompt, c)]);
  if (todo.length === 0) {
    log(`[${variant.label}] ${clips.length} transcripts cached`);
    return;
  }
  log(`[${variant.label}] transcribing ${todo.length} clip(s) (${clips.length - todo.length} cached)`);
  let done = 0;
  for (const batch of chunk(todo, WHISPER_BATCH)) {
    const args = ['-m', modelPath, '-l', 'en', '-nt', '-np', '-oj'];
    if (variant.prompt && prompt) args.push('--prompt', prompt);
    for (const c of batch) args.push('-f', c.wav);
    const r = await run(cli, args);
    if (r.code !== 0) throw new Error(`whisper-cli exited ${r.code}: ${r.stderr.trim().split('\n').slice(-5).join('\n')}`);
    for (const c of batch) {
      const jsonPath = `${c.wav}.json`;
      if (!existsSync(jsonPath)) throw new Error(`whisper-cli wrote no output for ${c.key}`);
      const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as WhisperJson;
      unlinkSync(jsonPath);
      const heard = cleanHeard((parsed.transcription ?? []).map((s) => s.text ?? '').join(' '));
      cache.entries[cacheKey(variant, prompt, c)] = { heard, at: new Date().toISOString() };
    }
    saveCache(cache);
    done += batch.length;
    log(`[${variant.label}] ${done}/${todo.length}`);
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const DIACRITICS: Record<string, string> = { ø: 'o', ł: 'l', ß: 'ss', æ: 'ae', œ: 'oe', đ: 'd' };

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øłßæœđ]/g, (ch) => DIACRITICS[ch] ?? ch);
}

/** Strip leading/trailing punctuation from a token, keep internal (Ashlr.AI, Next.js). */
function stripEdges(tok: string): string {
  return tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function rawTokens(s: string): string[] {
  return s.replace(/[‘’]/g, "'").split(/\s+/).filter((t) => stripEdges(t).length > 0);
}

function tokens(s: string): string[] {
  return rawTokens(s).map(stripEdges);
}

/** Case- and punctuation-insensitive sentence key. Internal punctuation is kept, so "Ashlr AI" != "Ashlr.AI". */
function loose(s: string): string {
  return tokens(fold(s).toLowerCase()).join(' ');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Word alignment: which heard tokens sit where the term should be
// ---------------------------------------------------------------------------

function similarity(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - distance(a, b) / m;
}

/** Aligns expected tokens to heard tokens; returns for each expected index the heard index it maps to (or -1). */
function alignWords(exp: string[], got: string[]): number[] {
  const n = exp.length;
  const m = got.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i++) cost[i][0] = i;
  for (let j = 1; j <= m; j++) cost[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = exp[i - 1] === got[j - 1] ? 0 : 0.6 + 0.4 * (1 - similarity(exp[i - 1], got[j - 1]));
      cost[i][j] = Math.min(cost[i - 1][j - 1] + sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }
  const map = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const sub = exp[i - 1] === got[j - 1] ? 0 : 0.6 + 0.4 * (1 - similarity(exp[i - 1], got[j - 1]));
    if (cost[i][j] === cost[i - 1][j - 1] + sub) {
      map[i - 1] = j - 1;
      i--;
      j--;
    } else if (cost[i][j] === cost[i - 1][j] + 1) {
      i--;
    } else {
      j--;
    }
  }
  return map;
}

/** Locate `term` in `expected` (token span) and return the heard tokens between the aligned neighbours. */
function heardForTerm(expected: string, heard: string, term: string): string {
  const expToks = tokens(expected);
  const gotRaw = rawTokens(heard);
  const gotToks = gotRaw.map(stripEdges);
  const expNorm = expToks.map((t) => fold(t).toLowerCase());
  const gotNorm = gotToks.map((t) => fold(t).toLowerCase());
  const termNorm = tokens(term).map((t) => fold(t).toLowerCase());
  // possessive: "Kwame Mensah's" tokenizes to "mensah's"
  let start = -1;
  for (let i = 0; i + termNorm.length <= expNorm.length && start === -1; i++) {
    let ok = true;
    for (let k = 0; k < termNorm.length; k++) {
      const e = expNorm[i + k];
      if (e !== termNorm[k] && e !== `${termNorm[k]}'s`) {
        ok = false;
        break;
      }
    }
    if (ok) start = i;
  }
  if (start === -1) return '?';
  const end = start + termNorm.length - 1;
  const map = alignWords(expNorm, gotNorm);
  let left = -1;
  for (let i = start - 1; i >= 0; i--) {
    if (map[i] !== -1) {
      left = map[i];
      break;
    }
  }
  let right = gotToks.length;
  for (let i = end + 1; i < expNorm.length; i++) {
    if (map[i] !== -1) {
      right = map[i];
      break;
    }
  }
  // Keep the punctuation Whisper put inside the span (a comma inside an alias breaks the exact
  // pass, so it matters); strip only the edges.
  const span = gotRaw.slice(left + 1, right);
  if (span.length === 0) return '(dropped)';
  if (span.length === 1) return stripEdges(span[0]);
  const first = span[0].replace(/^[^\p{L}\p{N}]+/u, '');
  const last = span[span.length - 1].replace(/[^\p{L}\p{N}]+$/u, '');
  return [first, ...span.slice(1, -1), last].join(' ');
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function evaluateVariant(variant: Variant, clips: Clip[], heardFor: (c: Clip) => string, lexicon: Lexicon, seconds: number): VariantReport {
  const cases: BenchCase[] = clips.map((c) => ({
    id: c.key,
    category: c.sentence.category,
    heard: heardFor(c),
    expected: c.sentence.expected,
    terms: c.sentence.terms,
    ...(c.sentence.note ? { note: c.sentence.note } : {}),
  }));
  const byKey = new Map(clips.map((c) => [c.key, c]));
  const full = runBench(cases, lexicon, { timing: false });
  const { results, ...report } = full;

  const categoryOf = new Map(lexicon.terms.map((t) => [t.canonical, t.category ?? 'other']));
  const termsByCanonical = new Map<string, TermStats>();
  const voices = new Map<string, VoiceStats>();
  const failures: ClipFailure[] = [];
  let posN = 0;
  let posRaw = 0;
  let posAfter = 0;

  for (const r of results) {
    const clip = byKey.get(r.id);
    if (!clip) continue;
    const expectedLoose = loose(r.expected);
    const rawOk = loose(r.heard) === expectedLoose;
    const afterOk = loose(r.output) === expectedLoose;
    let vs = voices.get(clip.voice);
    if (!vs) {
      vs = { voice: clip.voice, clips: 0, termSlots: 0, rawHit: 0, afterHit: 0, sentenceRaw: 0, sentenceAfter: 0, positives: 0, negatives: 0, negativesChanged: 0 };
      voices.set(clip.voice, vs);
    }
    vs.clips++;
    if (r.negative) {
      vs.negatives++;
      if (r.replacements.length > 0) vs.negativesChanged++;
    } else {
      vs.positives++;
      posN++;
      if (rawOk) {
        posRaw++;
        vs.sentenceRaw++;
      }
      if (afterOk) {
        posAfter++;
        vs.sentenceAfter++;
      }
    }

    const missed = new Set(r.missed);
    const reasonFor = new Map<string, MatchReason>();
    for (const rep of r.replacements) if (!reasonFor.has(rep.canonical)) reasonFor.set(rep.canonical, rep.reason);

    for (const canonical of new Set(clip.sentence.terms)) {
      let ts = termsByCanonical.get(canonical);
      if (!ts) {
        ts = { canonical, category: categoryOf.get(canonical) ?? clip.sentence.category, slots: 0, rawHit: 0, afterHit: 0, heard: new Map() };
        termsByCanonical.set(canonical, ts);
      }
      const want = Math.max(1, countOccurrences(r.expected, canonical));
      const raw = countOccurrences(r.heard, canonical) >= want;
      const after = !missed.has(canonical);
      ts.slots++;
      vs.termSlots++;
      if (raw) {
        ts.rawHit++;
        vs.rawHit++;
      }
      if (after) {
        ts.afterHit++;
        vs.afterHit++;
      }
      const wrote = raw ? canonical : heardForTerm(r.expected, r.heard, canonical);
      const outcome: Outcome = raw ? 'raw' : after ? (reasonFor.get(canonical) ?? 'alias') : 'missed';
      let vh = ts.heard.get(wrote);
      if (!vh) {
        vh = { n: 0, outcomes: { raw: 0, alias: 0, phonetic: 0, fuzzy: 0, missed: 0 } };
        ts.heard.set(wrote, vh);
      }
      vh.n++;
      vh.outcomes[outcome]++;
    }

    const failed = r.negative ? r.replacements.length > 0 : !afterOk || r.missed.length > 0 || r.spurious.length > 0;
    if (failed) {
      failures.push({
        key: r.id,
        category: r.category,
        hard: r.hard,
        negative: r.negative,
        heard: r.heard,
        output: r.output,
        expected: r.expected,
        missed: r.missed,
        spurious: r.spurious.map((s) => `"${s.original}" -> "${s.replacement}" (${s.reason}, ${s.confidence.toFixed(2)})`),
      });
    }
  }

  const terms = [...termsByCanonical.values()].sort((a, b) => a.rawHit / a.slots - b.rawHit / b.slots || a.canonical.localeCompare(b.canonical));
  return {
    variant,
    clips: clips.length,
    report,
    sentence: { rawPositives: posRaw, afterPositives: posAfter, positives: posN },
    byVoice: [...voices.values()],
    terms,
    failures,
    seconds,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const frac = (hit: number, total: number): string => `${pct(total === 0 ? 0 : hit / total)} (${hit}/${total})`;
const code = (s: string): string => `\`${s.replace(/`/g, "'")}\``;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function describeHeard(ts: TermStats, max: number): string {
  const rows = [...ts.heard.entries()].filter(([w]) => w !== ts.canonical).sort((a, b) => b[1].n - a[1].n);
  const parts = rows.slice(0, max).map(([w, vh]) => {
    const o = vh.outcomes;
    const fixed = o.alias + o.phonetic + o.fuzzy;
    let tag: string;
    if (o.missed === 0) tag = o.alias === fixed ? 'alias' : o.phonetic > 0 && o.fuzzy === 0 ? 'phonetic' : o.fuzzy > 0 && o.phonetic === 0 ? 'fuzzy' : 'fixed';
    else if (fixed === 0) tag = 'MISSED';
    else tag = `${o.missed} missed`;
    return `${code(w)} x${vh.n} ${tag}`;
  });
  if (rows.length > max) parts.push(`+${rows.length - max} more`);
  return parts.join('; ') || '-';
}

interface AliasSuggestion {
  canonical: string;
  heard: string;
  n: number;
  /** true when the lexicon already recovers it (via phonetic/fuzzy); an alias would make it exact */
  recovered: boolean;
}

function suggestAliases(vr: VariantReport, lexicon: Lexicon): AliasSuggestion[] {
  const aliasesOf = new Map<string, Set<string>>();
  for (const t of lexicon.terms) aliasesOf.set(t.canonical, new Set(t.aliases.map((a) => a.toLowerCase())));
  const out: AliasSuggestion[] = [];
  for (const ts of vr.terms) {
    const known = aliasesOf.get(ts.canonical) ?? new Set<string>();
    for (const [wrote, vh] of ts.heard) {
      if (wrote === ts.canonical || wrote === '(dropped)' || wrote === '?') continue;
      const lower = wrote.toLowerCase();
      if (lower === ts.canonical.toLowerCase() || known.has(lower)) continue;
      // a variant that only differs by casing is already handled by the exact pass
      if (fold(lower) === fold(ts.canonical.toLowerCase())) continue;
      const recovered = vh.outcomes.missed === 0;
      // keep: every missed variant, and recovered-by-guess variants seen at least twice
      if (!recovered || (vh.outcomes.alias === 0 && vh.n >= 2)) out.push({ canonical: ts.canonical, heard: wrote, n: vh.n, recovered });
    }
  }
  return out.sort((a, b) => Number(a.recovered) - Number(b.recovered) || b.n - a.n || a.canonical.localeCompare(b.canonical));
}

function renderHeadline(variants: VariantReport[]): string {
  const rows: string[][] = [
    ['clips', ...variants.map((v) => String(v.clips))],
    ['term recall, raw Whisper', ...variants.map((v) => frac(v.report.terms.rawRecall.hit, v.report.terms.rawRecall.total))],
    ['term recall, after lexicon', ...variants.map((v) => `**${frac(v.report.terms.recall.hit, v.report.terms.recall.total)}**`)],
    ['term precision', ...variants.map((v) => frac(v.report.terms.precision.hit, v.report.terms.precision.total))],
    ['term F1', ...variants.map((v) => pct(v.report.terms.f1))],
    ['sentence accuracy, raw Whisper (positives, loose)', ...variants.map((v) => frac(v.sentence.rawPositives, v.sentence.positives))],
    ['sentence accuracy, after lexicon (positives, loose)', ...variants.map((v) => frac(v.sentence.afterPositives, v.sentence.positives))],
    ['prose false-positive rate (negatives changed)', ...variants.map((v) => frac(v.report.falsePositiveRate.hit, v.report.falsePositiveRate.total))],
    ['prose false-positive rate excl. expected-hard', ...variants.map((v) => frac(v.report.falsePositiveRateExcludingHard.hit, v.report.falsePositiveRateExcludingHard.total))],
    ['whisper wall time', ...variants.map((v) => (v.seconds > 0 ? `${v.seconds.toFixed(0)} s` : 'cached'))],
  ];
  return table(['metric', ...variants.map((v) => v.variant.label)], rows);
}

function renderVoices(vr: VariantReport): string {
  return table(
    ['voice', 'clips', 'term recall raw', 'term recall after', 'sentence acc raw', 'sentence acc after', 'prose FP'],
    vr.byVoice.map((v) => [
      v.voice,
      String(v.clips),
      frac(v.rawHit, v.termSlots),
      frac(v.afterHit, v.termSlots),
      frac(v.sentenceRaw, v.positives),
      frac(v.sentenceAfter, v.positives),
      frac(v.negativesChanged, v.negatives),
    ]),
  );
}

function renderCategories(vr: VariantReport): string {
  return table(
    ['category', 'clips', 'term recall raw', 'term recall after'],
    CATEGORIES.filter((c) => vr.report.sentence.byCategory[c]).map((c) => {
      const s = vr.report.sentence.byCategory[c];
      const t = vr.report.terms.byCategory[c];
      return [c, String(s.total), t ? frac(t.rawRecall.hit, t.rawRecall.total) : '-', t ? frac(t.recall.hit, t.recall.total) : '-'];
    }),
  );
}

function renderReasons(vr: VariantReport): string {
  return table(
    ['reason', 'replacements', 'correct', 'spurious', 'mean confidence'],
    (['alias', 'phonetic', 'fuzzy'] as const).map((reason) => {
      const s = vr.report.byReason[reason];
      return [reason, String(s.replacements), String(s.correct), String(s.wrong), s.replacements ? s.meanConfidence.toFixed(3) : '-'];
    }),
  );
}

function renderTerms(vr: VariantReport, limit?: number): string {
  const rows = (limit ? vr.terms.slice(0, limit) : vr.terms).map((ts) => [
    ts.canonical,
    ts.category,
    frac(ts.rawHit, ts.slots),
    frac(ts.afterHit, ts.slots),
    describeHeard(ts, 6),
  ]);
  return table(['canonical', 'category', 'raw', 'after', 'what Whisper wrote (count, outcome)'], rows);
}

function renderSuggestions(list: AliasSuggestion[]): string {
  if (list.length === 0) return 'None: every non-canonical spelling Whisper produced is either already an alias or recovered by the alias pass.';
  const missed = list.filter((s) => !s.recovered);
  const guessed = list.filter((s) => s.recovered);
  const out: string[] = [];
  if (missed.length) {
    out.push('Spellings the lexicon did not recover (adding these as aliases fixes the miss):', '');
    out.push(table(['canonical', 'add alias', 'seen'], missed.map((s) => [s.canonical, code(s.heard), `x${s.n}`])));
  }
  if (guessed.length) {
    out.push('', 'Spellings recovered by the phonetic or fuzzy pass (an alias would make the hit exact and confidence 1.0):', '');
    out.push(table(['canonical', 'add alias', 'seen'], guessed.map((s) => [s.canonical, code(s.heard), `x${s.n}`])));
  }
  return out.join('\n');
}

function renderFailures(vr: VariantReport): string {
  if (vr.failures.length === 0) return '_none_';
  const out: string[] = [];
  for (const f of vr.failures) {
    const termsOk = !f.negative && f.missed.length === 0 && f.spurious.length === 0;
    const tags = [
      f.category,
      ...(f.hard ? ['expected-hard'] : []),
      ...(f.negative ? ['negative'] : []),
      ...(termsOk ? ['terms recovered, Whisper mangled another word'] : []),
    ].join(', ');
    out.push(`- **${f.key}** [${tags}]`);
    out.push(`  - heard:    ${code(f.heard)}`);
    if (f.output !== f.heard) out.push(`  - output:   ${code(f.output)}`);
    out.push(`  - expected: ${code(f.expected)}`);
    if (f.missed.length) out.push(`  - missed: ${f.missed.join(', ')}`);
    if (f.spurious.length) out.push(`  - spurious: ${f.spurious.join('; ')}`);
  }
  return out.join('\n');
}

interface RunMeta {
  generatedAt: string;
  whisperCli: string;
  models: string[];
  voices: string[];
  sentences: { total: number; positives: number; negatives: number; hard: number };
  lexicon: string;
  promptChars: number;
  totalSeconds: number;
  synthSeconds: number;
}

function renderMarkdown(meta: RunMeta, variants: VariantReport[], lexicon: Lexicon): string {
  const primary = variants[0];
  const out: string[] = [];
  out.push('# Real-audio benchmark results');
  out.push('');
  out.push(`Generated ${meta.generatedAt} by \`npm run bench:audio\`. Pipeline: macOS \`say\` (voices ${meta.voices.join(', ')}) -> 16 kHz mono WAV -> whisper.cpp (\`${meta.whisperCli}\`, models ${meta.models.join(', ')}) -> \`normalize()\` with \`${meta.lexicon}\`.`);
  out.push('');
  out.push(`Sentences: ${meta.sentences.total} (${meta.sentences.positives} with lexicon terms, ${meta.sentences.negatives} clean prose; ${meta.sentences.hard} marked expected-hard) x ${meta.voices.length} voice(s) = ${primary.clips} clips per variant. This invocation took ${meta.totalSeconds.toFixed(0)} s (synthesis ${meta.synthSeconds.toFixed(0)} s); cached audio and transcripts are skipped, so a cold run is longer (see the whisper wall time row).`);
  out.push('');
  out.push('Metrics are the ones from `bench/lib.ts` (see `bench/README.md`). Term recall is exact and case-sensitive on the canonical. Sentence accuracy is "loose": case and edge punctuation are folded before comparing, because Whisper capitalizes and punctuates on its own; internal punctuation (`Ashlr.AI`, `Next.js`) still has to match. "+ prompt" variants pass `lexicon export whisper-prompt` (' + `${meta.promptChars} chars, canonicals only) as whisper's initial prompt.`);
  out.push('');
  out.push('## Headline');
  out.push('');
  out.push(renderHeadline(variants));
  for (const vr of variants) {
    out.push('', `## ${vr.variant.label}`, '');
    out.push('### By voice', '', renderVoices(vr));
    out.push('', '### By category', '', renderCategories(vr));
    out.push('', '### By reason', '', renderReasons(vr));
  }
  out.push('', `## What Whisper wrote (${primary.variant.label})`, '');
  out.push('One row per canonical, sorted by raw recall (worst first). Outcome per spelling: `alias`/`phonetic`/`fuzzy` = recovered by that pass, `MISSED` = the lexicon did not fix it.', '');
  out.push(renderTerms(primary));
  out.push('', `## Suggested aliases for bench/lexicon.yaml (${primary.variant.label})`, '');
  out.push(renderSuggestions(suggestAliases(primary, lexicon)));
  for (const vr of variants) {
    out.push('', `## Failing clips: ${vr.variant.label} (${vr.failures.length})`, '');
    out.push(renderFailures(vr));
  }
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = performance.now();
  const args = parseArgs(process.argv.slice(2));
  if (process.platform !== 'darwin') {
    throw new Error('this benchmark synthesizes speech with macOS `say`; run it on a Mac.');
  }
  const cli = findWhisperCli();
  const lexicon = loadLexicon(args.lexicon);
  let sentences = loadSentences(SENTENCES);
  if (args.filter) sentences = sentences.filter((s) => s.category === args.filter);
  if (args.limit) sentences = sentences.slice(0, args.limit);
  if (sentences.length === 0) throw new Error('no sentences selected');

  mkdirSync(WAV_DIR, { recursive: true });
  const clips = makeClips(sentences, args.voices);

  const tSynth = performance.now();
  const missing = clips.filter((c) => !existsSync(c.wav)).length;
  log(`synthesizing ${missing} clip(s) with say (${clips.length - missing} cached)`);
  await pool(clips, SAY_CONCURRENCY, synthesize);
  const synthSeconds = (performance.now() - tSynth) / 1000;

  const prompt = exportWhisperPrompt(lexicon);
  const variants: Variant[] = [];
  for (const model of args.models) {
    variants.push({ model, prompt: false, label: model });
    if (args.prompt) variants.push({ model, prompt: true, label: `${model} + prompt` });
  }

  const cache = loadCache();
  const reports: VariantReport[] = [];
  for (const variant of variants) {
    const modelPath = await ensureModel(variant.model);
    const t1 = performance.now();
    const before = clips.filter((c) => !cache.entries[cacheKey(variant, prompt, c)]).length;
    await transcribe(cli, modelPath, variant, prompt, clips, cache, args.force);
    const seconds = before > 0 || args.force ? (performance.now() - t1) / 1000 : 0;
    const heardFor = (c: Clip): string => cache.entries[cacheKey(variant, prompt, c)].heard;
    reports.push(evaluateVariant(variant, clips, heardFor, lexicon, seconds));
  }

  const meta: RunMeta = {
    generatedAt: new Date().toISOString(),
    whisperCli: cli,
    models: args.models,
    voices: args.voices,
    sentences: {
      total: sentences.length,
      positives: sentences.filter((s) => s.terms.length > 0).length,
      negatives: sentences.filter((s) => s.terms.length === 0).length,
      hard: sentences.filter((s) => isHard({ ...s, heard: '' })).length,
    },
    lexicon: args.lexicon.startsWith(process.cwd()) ? args.lexicon.slice(process.cwd().length + 1) : args.lexicon,
    promptChars: prompt.length,
    totalSeconds: (performance.now() - t0) / 1000,
    synthSeconds,
  };

  const md = renderMarkdown(meta, reports, lexicon);
  const partial = args.filter !== undefined || args.limit !== undefined;
  if (partial) {
    log('partial run (--filter/--limit): not overwriting results.md');
  } else {
    writeFileSync(RESULTS_MD, md);
    log(`wrote ${RESULTS_MD}`);
  }
  const json = {
    ...meta,
    prompt,
    variants: reports.map((r) => ({
      ...r,
      terms: r.terms.map((t) => ({ ...t, heard: Object.fromEntries(t.heard) })),
    })),
    suggestions: suggestAliases(reports[0], lexicon),
  };
  writeFileSync(RESULTS_JSON, JSON.stringify(json, null, 2) + '\n');
  log(`wrote ${RESULTS_JSON}`);

  console.log(renderHeadline(reports));
  if (args.verbose) {
    for (const vr of reports) console.log(`\n## Failing clips: ${vr.variant.label} (${vr.failures.length})\n\n${renderFailures(vr)}`);
  } else {
    console.log(`\n${reports.map((r) => `${r.variant.label}: ${r.failures.length} failing clip(s)`).join('; ')}; rerun with --verbose or read ${partial ? RESULTS_JSON : RESULTS_MD}.`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
