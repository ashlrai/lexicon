/**
 * Cross-platform half of the dev setup. `scripts/setup.sh` (macOS and Linux)
 * and `scripts/setup.ps1` (Windows) make sure Node 20+ is on PATH, then run
 * this file. It installs lockfile dependencies and runs the smoke test.
 * Safe to run again. No prompts.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const major = Number(process.versions.node.split('.')[0]);

if (!Number.isInteger(major) || major < 20) {
  console.error(`setup: Node 20 or newer is required, found ${process.version}`);
  process.exit(1);
}

console.log(`lexicon dev setup (${root})`);
console.log(`node ${process.version}`);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    // npm on Windows is npm.cmd, which CreateProcess will not start.
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      npm_config_update_notifier: 'false',
    },
  });
  if (result.error) {
    console.error(`setup: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('npm ci');
run('npm', ['ci', '--no-fund', '--no-audit']);
console.log('npm run smoke');
run('npm', ['run', 'smoke']);
console.log('setup complete');
