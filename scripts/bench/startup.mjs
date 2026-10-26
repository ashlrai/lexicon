#!/usr/bin/env node
/**
 * One manual measurement of Lexicon process startup.
 *
 * Times the built CLI (`--version`, and `normalize --diff` of a sentence the
 * built-in example corrects) and the in-process matcher (`normalize` and
 * `normalizeWithIndex` on bench/lexicon.yaml). Prints one JSON document on
 * stdout. The tables in docs/BENCHMARKS.md quote one run of this command;
 * run it again and the timings will differ.
 *
 * Usage (from the repo root, after `npm run build`):
 *   node scripts/bench/startup.mjs
 *
 * The CLI runs happen in an empty temporary HOME, with LEXICON_PATH unset and
 * the working directory set to that HOME, so a project .lexicon.yaml in this
 * repo is not on the path. Peak RSS is GNU time's "Maximum resident set size"
 * for one extra run of the same command (`/usr/bin/time -v`). If that binary
 * is missing, peak_rss_kb is null and the wall times are still printed.
 *
 * Sample sizes match the write-up: 1 warmup then 11 `--version` runs, 1
 * warmup then 21 normalize runs, 20 warmup then 300 in-process calls.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'dist/cli/index.js');
const core = path.join(root, 'dist/core/index.js');
const lexiconPath = path.join(root, 'bench/lexicon.yaml');
const VERSION_N = 11;
const NORMALIZE_N = 21;
const LIBRARY_N = 300;
const LIBRARY_WARMUP = 20;
const NORMALIZE_SENTENCE = 'ask ashler to deploy kuber netties with post gressql';
const LIBRARY_SENTENCE = 'tell Ashler to ship it';

if (!existsSync(cli) || !existsSync(core)) {
  process.stderr.write('dist/ is missing. Run `npm run build` first.\n');
  process.exit(1);
}

/** Linear percentile, p in 0..1, on a copy sorted ascending. */
function percentile(samples, p) {
  const xs = [...samples].sort((a, b) => a - b);
  const k = (xs.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, xs.length - 1);
  return xs[lo] + (xs[hi] - xs[lo]) * (k - lo);
}

function summarize(samples) {
  return {
    n: samples.length,
    min_s: Math.min(...samples),
    p50_s: percentile(samples, 0.5),
    p95_s: percentile(samples, 0.95),
    max_s: Math.max(...samples),
  };
}

function run(cmd, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ seconds: (performance.now() - t0) / 1000, code, stdout, stderr });
    });
  });
}

async function timeCommand(cmd, args, env, cwd, n, warmup) {
  const samples = [];
  let last = null;
  for (let i = 0; i < n + warmup; i++) {
    const result = await run(cmd, args, env, cwd);
    last = result;
    if (result.code !== 0) {
      throw new Error(`${cmd} ${args.join(' ')} exited ${result.code}\n${result.stderr}`);
    }
    if (i >= warmup) samples.push(result.seconds);
  }
  return { ...summarize(samples), warmup, stdout: last.stdout, stderr: last.stderr };
}

async function peakRssKb(cmd, args, env, cwd) {
  if (!existsSync('/usr/bin/time')) return null;
  const result = await run('/usr/bin/time', ['-v', cmd, ...args], env, cwd);
  const match = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

const home = await mkdtemp(path.join(tmpdir(), 'lexicon-startup-'));
try {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  delete env.LEXICON_PATH;

  const versionArgs = [cli, '--version'];
  const normalizeArgs = [cli, 'normalize', '--diff', NORMALIZE_SENTENCE];
  const version = await timeCommand(process.execPath, versionArgs, env, home, VERSION_N, 1);
  const versionRss = await peakRssKb(process.execPath, versionArgs, env, home);
  const normalize = await timeCommand(process.execPath, normalizeArgs, env, home, NORMALIZE_N, 1);
  const normalizeRss = await peakRssKb(process.execPath, normalizeArgs, env, home);

  // Dynamic on purpose: a static import of dist/ fails with ERR_MODULE_NOT_FOUND
  // before the "run npm run build" message above can run.
  const { buildIndex, normalize: normalizeText, normalizeWithIndex } = await import(core);
  const lexicon = parse(readFileSync(lexiconPath, 'utf8'));
  const full = [];
  for (let i = 0; i < LIBRARY_N + LIBRARY_WARMUP; i++) {
    const t0 = performance.now();
    normalizeText(LIBRARY_SENTENCE, lexicon);
    if (i >= LIBRARY_WARMUP) full.push((performance.now() - t0) / 1000);
  }
  const index = buildIndex(lexicon);
  const indexed = [];
  for (let i = 0; i < LIBRARY_N + LIBRARY_WARMUP; i++) {
    const t0 = performance.now();
    normalizeWithIndex(LIBRARY_SENTENCE, index);
    if (i >= LIBRARY_WARMUP) indexed.push((performance.now() - t0) / 1000);
  }

  const cpu = cpus()[0];
  const report = {
    measured_at: new Date().toISOString(),
    command: 'node scripts/bench/startup.mjs',
    node: process.version,
    os: `${process.platform} ${release()}`,
    cpus: cpus().length,
    cpu_model: cpu ? cpu.model.trim() : null,
    mem_total_kb: Math.round(totalmem() / 1024),
    cli: path.relative(root, cli),
    cwd: 'empty temporary HOME (not the repo)',
    lexicon_path: 'unset',
    version: {
      args: ['--version'],
      ...version,
      peak_rss_kb: versionRss,
      stdout: version.stdout.trim(),
      stderr: version.stderr.trim(),
    },
    normalize: {
      args: ['normalize', '--diff', NORMALIZE_SENTENCE],
      ...normalize,
      peak_rss_kb: normalizeRss,
      stdout: normalize.stdout.trim(),
      stderr: normalize.stderr.trim(),
    },
    library: {
      lexicon: 'bench/lexicon.yaml',
      sentence: LIBRARY_SENTENCE,
      warmup: LIBRARY_WARMUP,
      normalize: summarize(full),
      normalizeWithIndex: summarize(indexed),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(home, { recursive: true, force: true });
}
