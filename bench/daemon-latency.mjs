import { execFile } from 'node:child_process';
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
  await measure('cold CLI daemon absent',()=>command('index'));
  await measure('cold CLI direct',()=>command('run'));
} finally {
  controller.abort();
  await done;
  process.chdir(root);
  await rm(dir, { recursive: true, force: true });
}
