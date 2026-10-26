#!/usr/bin/env node
/**
 * Wall-clock startup of the built CLI and MCP server.
 *
 *   node bench/startup.mjs [--warmup 3] [--runs 15]
 *
 * Requires `npm run build` first. Times `node dist/cli/index.js` for
 * --version, --help and doctor, and `node dist/mcp/server.js` until it
 * writes the initialize response. Prints one row per command: median, mean,
 * min, max, in milliseconds. doctor exits 1 when the machine has nothing
 * configured; that exit is still a completed startup. This script is not a
 * CI job.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const WARMUP = Number(flag('warmup', '3'));
const RUNS = Number(flag('runs', '15'));
const CLI = path.join(root, 'dist/cli/index.js');
const MCP = path.join(root, 'dist/mcp/server.js');

if (!existsSync(CLI) || !existsSync(MCP)) {
  console.error('dist/ is missing. Run npm run build first.');
  process.exit(1);
}

const INIT = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench-startup', version: '0' } },
})}\n`;

function timeCli(cliArgs, accept) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, ...cliArgs], { cwd: root, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!accept.includes(r.status)) {
    throw new Error(`${cliArgs.join(' ') || '(no args)'} exited ${r.status}: ${r.stderr}`);
  }
  return ms;
}

function timeMcp() {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const child = spawn(process.execPath, [MCP], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP initialize timed out. stderr: ${err}`));
    }, 20_000);
    child.stdout.on('data', (buf) => {
      out += buf.toString();
      if (!out.includes('"protocolVersion"')) return;
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      child.kill();
      resolve(ms);
    });
    child.stderr.on('data', (buf) => {
      err += buf.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.write(INIT);
  });
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const mean = samples.reduce((sum, n) => sum + n, 0) / samples.length;
  const round = (n) => (Math.round(n * 10) / 10).toFixed(1);
  return { median: round(median), mean: round(mean), min: round(sorted[0]), max: round(sorted[sorted.length - 1]) };
}

const cases = [
  { name: '--version', run: () => timeCli(['--version'], [0]) },
  { name: '--help', run: () => timeCli(['--help'], [0]) },
  { name: 'doctor', run: () => timeCli(['doctor'], [0, 1]) },
  { name: 'MCP initialize', run: () => timeMcp() },
];

console.log(`node ${process.version}  warmup ${WARMUP}  runs ${RUNS}  cwd ${root}`);
console.log('command\tmedian\tmean\tmin\tmax');
for (const item of cases) {
  for (let i = 0; i < WARMUP; i += 1) await item.run();
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) samples.push(await item.run());
  const row = summarize(samples);
  console.log(`${item.name}\t${row.median}\t${row.mean}\t${row.min}\t${row.max}`);
}
