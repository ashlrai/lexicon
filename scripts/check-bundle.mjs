#!/usr/bin/env node
/** Rebuild plugin bundles and report a reviewable, capped patch on drift. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = resolve(root, 'artifacts/bundle-diff.patch');
const MAX_DIFF_LINES = 400;

export function capDiff(diff, limit = MAX_DIFF_LINES) {
  const lines = diff.split('\n');
  if (lines.length <= limit) return diff;
  return `${lines.slice(0, limit).join('\n')}\n... diff truncated after ${limit} lines (full patch: artifacts/bundle-diff.patch)\n`;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout;
}

function main() {
  run('npm', ['run', 'build:bundle']);
  const diff = run('git', ['diff', '--no-ext-diff', '--unified=3', '--', 'plugin']);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '--', 'plugin']).trim();
  if (!diff && !untracked) {
    process.stdout.write('Plugin bundle is up to date.\n');
    return;
  }

  const completeDiff = `${diff}${untracked ? `\nUntracked bundle files:\n${untracked}\n` : ''}`;
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, completeDiff);
  process.stderr.write(`Plugin bundle drift detected. Patch saved to ${artifact}\n`);
  process.stderr.write(capDiff(completeDiff));
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
