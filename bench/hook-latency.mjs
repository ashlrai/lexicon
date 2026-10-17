#!/usr/bin/env node
/**
 * Wall-clock latency of the bundled prompt hook (plugin/hook.mjs), the number
 * CLAUDE.md promises stays under 200 ms. Each run spawns a fresh `node`, the
 * way Claude Code does, against a synthetic lexicon in a temp directory
 * (LEXICON_PATH, HOME and XDG_CONFIG_HOME all point there; nothing under the
 * real home is read or written).
 *
 *   npm run bench:hook -- [--terms 2000] [--runs 5] [--hook plugin/hook.mjs]
 *
 * Prints best-of-N and median for a short UserPromptSubmit prompt (cold: the
 * first run after the lexicon is written; warm: every later run) and for
 * SessionStart. Best-of-N is the figure to compare between builds; the cold
 * run includes writing whatever caches the hook keeps.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const TERMS = Number(flag('terms', '2000'));
const RUNS = Number(flag('runs', '5'));
const HOOK = resolve(root, flag('hook', 'plugin/hook.mjs'));

/** Deterministic pseudo-words, so every run benches the same lexicon. */
function lexiconYaml(n) {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const syll = ['ka', 'lo', 'vex', 'tri', 'shu', 'mar', 'zen', 'qui', 'dra', 'pol', 'nix', 'bel', 'cor', 'fen', 'gra', 'hul'];
  const word = (k) => Array.from({ length: k }, () => syll[Math.floor(rand() * syll.length)]).join('');
  const lines = ['version: 1', 'terms:', '  - canonical: Ashlr.AI', '    aliases: [Ashler, Ashlar]'];
  for (let i = 1; i < n; i++) {
    const canonical = word(2 + Math.floor(rand() * 2));
    const cap = canonical[0].toUpperCase() + canonical.slice(1) + i;
    lines.push(`  - canonical: ${cap}`, `    aliases: [${word(2)}${i}, ${word(3)} ${word(1)}]`);
  }
  return `${lines.join('\n')}\n`;
}

function time(stdin, env) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [HOOK], { input: stdin, env, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`hook exited ${r.status}: ${r.stderr}`);
  return { ms, stdout: r.stdout };
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return `best ${s[0].toFixed(1)} ms, median ${s[Math.floor(s.length / 2)].toFixed(1)} ms`;
};

const dir = mkdtempSync(join(tmpdir(), 'lexicon-hook-bench-'));
try {
  const lexPath = join(dir, 'config', 'lexicon', 'lexicon.yaml');
  mkdirSync(dirname(lexPath), { recursive: true });
  writeFileSync(lexPath, lexiconYaml(TERMS));
  const project = join(dir, 'project');
  mkdirSync(project);
  const env = { PATH: process.env.PATH ?? '', HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'), LEXICON_PATH: lexPath };
  const prompt = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: project, prompt: 'ping ashler about the deploy and the release notes' });
  const session = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: project });

  const cold = time(prompt, env);
  if (!cold.stdout.includes('Ashlr.AI')) throw new Error(`hook did not correct the prompt: ${cold.stdout}`);
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push(time(prompt, env).ms);
  const ss = [];
  for (let i = 0; i < RUNS; i++) ss.push(time(session, env).ms);
  process.stdout.write(
    `hook ${relative(root, HOOK)}, ${TERMS} terms, ${RUNS} runs\n` +
      `  UserPromptSubmit cold  ${cold.ms.toFixed(1)} ms\n` +
      `  UserPromptSubmit warm  ${stats(warm)}\n` +
      `  SessionStart           ${stats(ss)}\n`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
