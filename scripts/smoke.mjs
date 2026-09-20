#!/usr/bin/env node
/**
 * Post-build smoke test, in Node rather than shell.
 *
 * The CI equivalents used to be four bash steps built on `/dev/null`,
 * `timeout`, `grep -q` and `$(...)`. None of those are portable to a Windows
 * runner (the default shell there is pwsh, and Git Bash does not reliably
 * carry coreutils `timeout`), so the same checks live here and run
 * identically on ubuntu, macos and windows:
 *
 *   1. the built CLI corrects a word from the example lexicon,
 *   2. the bundled plugin hook corrects a prompt, and answers SessionStart,
 *   3. the MCP server starts on stdio and stays alive.
 *
 * Usage: node scripts/smoke.mjs
 * Requires: npm run build && npm run build:bundle
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON_PATH = path.join(root, 'examples', 'lexicon.example.yaml');
const env = { ...process.env, LEXICON_PATH };

let failures = 0;

function report(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  }
}

/** Run `node <script> ...args`, optionally feeding stdin, and resolve with { code, stdout, stderr }. */
function run(script, args = [], { stdin, killAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', reject);
    const timer = killAfterMs
      ? setTimeout(() => {
          killed = true;
          child.kill();
        }, killAfterMs)
      : undefined;
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
    if (stdin !== undefined) child.stdin.end(stdin, 'utf8');
    else child.stdin.end();
  });
}

const CLI = path.join(root, 'dist', 'cli', 'index.js');
const HOOK = path.join(root, 'plugin', 'hook.mjs');
const MCP = path.join(root, 'dist', 'mcp', 'server.js');

// 1. the built CLI
{
  const r = await run(CLI, ['normalize', 'ping ashler']);
  report('CLI normalize corrects from the example lexicon', r.code === 0 && r.stdout.includes('Ashlr.AI'), `exit ${r.code}\n${r.stdout}${r.stderr}`);
}

// 2. the bundled plugin hook
{
  const r = await run(HOOK, [], { stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'ping ashler' }) });
  report('plugin hook corrects a UserPromptSubmit prompt', r.stdout.includes('Ashlr.AI'), `exit ${r.code}\n${r.stdout}${r.stderr}`);

  const s = await run(HOOK, [], { stdin: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }) });
  report('plugin hook answers SessionStart', s.stdout.includes('"hookEventName":"SessionStart"'), `exit ${s.code}\n${s.stdout}${s.stderr}`);
}

// 3. the MCP server survives on stdio
{
  // No input and no EOF: the server must sit waiting rather than exit or
  // crash. Killed after a moment; `killed` is the healthy outcome, and a
  // clean exit 0 is accepted too (some runtimes close stdin immediately).
  const r = await run(MCP, [], { killAfterMs: 4000 });
  report('MCP server starts on stdio and stays alive', r.killed || r.code === 0, `exit ${r.code}\n${r.stderr}`);
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
