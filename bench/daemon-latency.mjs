import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// Run from the repository root after npm run build. No real user data is read.
const root = process.cwd();
const dir = await mkdtemp(path.join(os.tmpdir(), 'lxb-'));
Object.assign(process.env, { HOME: dir, XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir,
  XDG_RUNTIME_DIR: dir, LEXICON_PATH: path.join(dir, 'lexicon.yaml'), LEXICON_TRUST_ALL: '0', NO_COLOR: '1' });
await writeFile(process.env.LEXICON_PATH, JSON.stringify({ version: 1, terms: Array.from({ length: 20 }, (_, i) => ({ canonical: `Product${i}`, aliases: [`Prduct${i}`] })) }));
const { runExpanderServer } = await import(path.join(root, 'dist/daemon/expander-server.js'));
const { tryFastRead } = await import(path.join(root, 'dist/daemon/fast-client.js'));
process.chdir(dir);
const exec = promisify(execFile);
const command = (entry) => exec(process.execPath, [path.join(root, `dist/cli/${entry}.js`), 'list', '--json']);
const measure = async (label, fn) => {
  const times = [];
  // Ten filesystem/import warmups, then fifty new Node processes per CLI path.
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    await fn();
    if (i >= 10) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, n: times.length, p50: times[24].toFixed(2), p95: times[47].toFixed(2) }));
};
const controller = new AbortController();
let ready;
const listening = new Promise((resolve) => { ready = resolve; });
const done = runExpanderServer({ signal: controller.signal, quiet: true, onListening: ready });
try {
  await Promise.race([listening,done]);
  const result = await tryFastRead(['list','--json'], undefined, 1000);
  if (!result) throw new Error('daemon did not answer');
  const direct = await command('run');
  const fast = await command('index');
  if (direct.stdout !== fast.stdout || direct.stderr !== fast.stderr) throw new Error('output mismatch');
  await measure('cold CLI daemon up',()=>command('index'));
  await measure('resident socket only', async () => {
    if (!await tryFastRead(['list', '--json'], undefined, 1000)) throw new Error('daemon miss');
  });
  controller.abort(); await done;
  // The memory half of the gap: a real `lexicon daemon --expander` child,
  // warmed with cli-read requests, peak RSS reported by the child itself over
  // stderr (NODE_OPTIONS --import), so no ps(1) and POSIX-only APIs are needed.
  // stdout is inherited so the child's cliReadContext() (which includes
  // stdout.isTTY) matches this process.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const reporter = 'data:text/javascript,' + encodeURIComponent(
    "setInterval(() => process.stderr.write('RSS ' + process.memoryUsage().rss + '\\n'), 25).unref()");
  const daemon = spawn(process.execPath, [path.join(root, 'dist/cli/index.js'), 'daemon', '--expander', '--quiet'],
    { stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, NODE_OPTIONS: `--import=${reporter}` } });
  let daemonErr = '';
  let errBuf = '';
  let peakRss = 0;
  daemon.stderr.setEncoding('utf8');
  daemon.stderr.on('data', (chunk) => {
    errBuf += chunk;
    let nl;
    while ((nl = errBuf.indexOf('\n')) !== -1) {
      const line = errBuf.slice(0, nl);
      errBuf = errBuf.slice(nl + 1);
      const m = /^RSS (\d+)$/.exec(line);
      if (m) peakRss = Math.max(peakRss, Number(m[1]));
      else if (line.trim()) daemonErr += `${line}\n`;
    }
  });
  daemon.once('error', () => {});
  const daemonExit = new Promise((resolve) => daemon.once('close', resolve));
  try {
    // A refused connect returns at once, so a count would burn out before a
    // cold daemon under load has even bound the socket: poll for 30 s instead.
    const upDeadline = Date.now() + 30_000;
    let up = false;
    while (!up && Date.now() < upDeadline && daemon.exitCode === null && daemon.signalCode === null) {
      up = (await tryFastRead(['list', '--json'], undefined, 500)) !== undefined;
      if (!up) await sleep(100);
    }
    if (!up) throw new Error(`expander child did not answer${daemonErr.trim() ? `: ${daemonErr.trim()}` : ''}`);
    for (let i = 0; i < 30; i++) {
      if (!await tryFastRead(['list', '--json'], undefined, 1000)) throw new Error('expander child stopped answering');
    }
    await sleep(150);
    if (peakRss <= 0) throw new Error('the expander child reported no RSS samples');
    console.log(JSON.stringify({ label: 'resident daemon peak RSS', kB: Math.round(peakRss / 1024) }));
  } catch (e) {
    console.log(JSON.stringify({ label: 'resident daemon peak RSS', error: e instanceof Error ? e.message : String(e) }));
  } finally {
    daemon.kill('SIGTERM');
    if (await Promise.race([daemonExit.then(() => false), sleep(1500).then(() => true)])) daemon.kill('SIGKILL');
    await daemonExit;
  }
  await measure('cold CLI daemon absent',()=>command('index'));
  await measure('cold CLI direct',()=>command('run'));
} finally {
  controller.abort();
  await done;
  process.chdir(root);
  await rm(dir, { recursive: true, force: true });
}
