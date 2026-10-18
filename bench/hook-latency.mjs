#!/usr/bin/env node
/**
 * Wall-clock latency of the bundled prompt hook (plugin/hook.mjs), the number
 * CLAUDE.md promises stays under 200 ms. Each run spawns a fresh `node`, the
 * way Claude Code does, against a synthetic lexicon in a temp directory
 * (LEXICON_PATH, HOME and XDG_CONFIG_HOME all point there; nothing under the
 * real home is read or written).
 *
 *   npm run bench:hook -- [--terms 2000] [--runs 5] [--hook plugin/hook.mjs]
 *                         [--project-terms N [--untrusted | --alternate]] [--after-write [global|project]]
 *
 * Prints best-of-N and median for a short UserPromptSubmit prompt (cold: the
 * first run after the lexicon is written; warm: every later run) and for
 * SessionStart. Best-of-N is the figure to compare between builds; the cold
 * run includes writing whatever caches the hook keeps.
 *
 * `--project-terms N` adds a trusted `.lexicon.yaml` of N more terms in the
 * prompt's repo (trusted with `lexicon trust --yes`), so the hook matches
 * against the global and project merge. With `--untrusted` the file is left
 * untrusted, so the hook skips it: the cost of a repo lexicon nobody approved.
 * With `--alternate` a second trusted repo of N other terms is added and the
 * warm prompts alternate between the two repos, the cost of switching.
 *
 * `--after-write` adds the "after a CLI write" mode: each of the N runs first
 * adds one term with `lexicon add` (into the global lexicon, or with
 * `--after-write project` the repo's, which needs `--project-terms`), then
 * times the first prompt after it: the prompt that pays for whatever that
 * write left stale. The add's own wall time is printed too. The CLI is
 * dist/cli/index.js when built, else src/cli/index.ts through tsx.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const PROJECT_TERMS = Number(flag('project-terms', '0'));
const UNTRUSTED = args.includes('--untrusted');
if (UNTRUSTED && PROJECT_TERMS === 0) throw new Error('--untrusted needs --project-terms N');
const ALTERNATE = args.includes('--alternate');
if (ALTERNATE && (PROJECT_TERMS === 0 || UNTRUSTED)) throw new Error('--alternate needs --project-terms N and no --untrusted');
const afterWriteAt = args.indexOf('--after-write');
const AFTER_WRITE = afterWriteAt === -1 ? undefined : args[afterWriteAt + 1] === 'project' ? 'project' : 'global';
if (AFTER_WRITE === 'project' && PROJECT_TERMS === 0) throw new Error('--after-write project needs --project-terms N');
const DIST_CLI = resolve(root, 'dist/cli/index.js');
const CLI = existsSync(DIST_CLI) ? [DIST_CLI] : ['--import', 'tsx', resolve(root, 'src/cli/index.ts')];

/** Runs the lexicon CLI; returns its wall time in ms and throws when it fails. */
function cli(cliArgs, env) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [...CLI, ...cliArgs], { env, encoding: 'utf8', cwd: root });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`lexicon ${cliArgs.join(' ')} exited ${r.status}: ${r.stderr}`);
  return ms;
}

/** Deterministic pseudo-words, so every run benches the same lexicon. */
function lexiconYaml(n, seed = 42, prefix = '') {
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const syll = ['ka', 'lo', 'vex', 'tri', 'shu', 'mar', 'zen', 'qui', 'dra', 'pol', 'nix', 'bel', 'cor', 'fen', 'gra', 'hul'];
  const word = (k) => Array.from({ length: k }, () => syll[Math.floor(rand() * syll.length)]).join('');
  const lines = ['version: 1', 'terms:', '  - canonical: Ashlr.AI', '    aliases: [Ashler, Ashlar]'];
  for (let i = 1; i < n; i++) {
    const canonical = word(2 + Math.floor(rand() * 2));
    const cap = prefix + canonical[0].toUpperCase() + canonical.slice(1) + i;
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
  // The .git ends the project-file walk here, so nothing above the temp dir is read.
  mkdirSync(join(project, '.git'), { recursive: true });
  const env = { PATH: process.env.PATH ?? '', HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), XDG_CACHE_HOME: join(dir, 'cache'), LEXICON_PATH: lexPath };
  if (PROJECT_TERMS > 0) {
    writeFileSync(join(project, '.lexicon.yaml'), lexiconYaml(PROJECT_TERMS + 1, 7, 'P').replace(/^ {2}- canonical: Ashlr\.AI\n {4}aliases: \[Ashler, Ashlar\]\n/m, ''));
    if (!UNTRUSTED) cli(['trust', '--yes', '--cwd', project], env);
  }
  const project2 = join(dir, 'project2');
  if (ALTERNATE) {
    mkdirSync(join(project2, '.git'), { recursive: true });
    writeFileSync(join(project2, '.lexicon.yaml'), lexiconYaml(PROJECT_TERMS + 1, 11, 'Q').replace(/^ {2}- canonical: Ashlr\.AI\n {4}aliases: \[Ashler, Ashlar\]\n/m, ''));
    cli(['trust', '--yes', '--cwd', project2], env);
  }
  const promptIn = (cwd) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt: 'ping ashler about the deploy and the release notes' });
  const prompt = promptIn(project);
  const session = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: project });

  const cold = time(prompt, env);
  if (!cold.stdout.includes('Ashlr.AI')) throw new Error(`hook did not correct the prompt: ${cold.stdout}`);
  const warm = [];
  // With --alternate, prime the second repo's caches once, then switch on every prompt.
  if (ALTERNATE) time(promptIn(project2), env);
  for (let i = 0; i < RUNS; i++) warm.push(time(ALTERNATE && i % 2 === 0 ? promptIn(project2) : prompt, env).ms);
  const ss = [];
  for (let i = 0; i < RUNS; i++) ss.push(time(session, env).ms);
  const afterWrite = [];
  const writes = [];
  if (AFTER_WRITE) {
    for (let i = 0; i < RUNS; i++) {
      const scope = AFTER_WRITE === 'project' ? ['--project'] : [];
      writes.push(cli(['add', `Benchword${i}`, `bench word ${i}`, ...scope, '--cwd', project], env));
      const r = time(prompt, env);
      if (!r.stdout.includes('Ashlr.AI')) throw new Error(`hook did not correct the prompt after a write: ${r.stdout}`);
      afterWrite.push(r.ms);
    }
  }
  process.stdout.write(
    `hook ${relative(root, HOOK)}, ${TERMS} terms${PROJECT_TERMS > 0 ? ` + ${PROJECT_TERMS} in ${UNTRUSTED ? 'an untrusted' : 'a trusted'} project lexicon` : ''}${ALTERNATE ? ', alternating between two repos' : ''}, ${RUNS} runs\n` +
      `  UserPromptSubmit cold  ${cold.ms.toFixed(1)} ms\n` +
      `  UserPromptSubmit warm  ${stats(warm)}\n` +
      `  SessionStart           ${stats(ss)}\n` +
      (AFTER_WRITE
        ? `  after a CLI write (lexicon add${AFTER_WRITE === 'project' ? ' --project' : ''})\n` +
          `    first prompt         ${stats(afterWrite)}\n` +
          `    the add itself       ${stats(writes)}\n`
        : ''),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
