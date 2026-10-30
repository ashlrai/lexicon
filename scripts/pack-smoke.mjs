#!/usr/bin/env node
/**
 * Packed-package smoke: the bytes a release would publish, installed the way a
 * user gets them, driven through the surface Phantom relies on.
 *
 * `scripts/smoke.mjs` checks the built tree; this checks the tarball. It packs
 * once (scripts off, as release.yml packs), installs the tarball into an empty
 * project, and runs the installed bins under Node:
 *
 *   1. every source version carrier agrees (release-contract.mjs `source`),
 *   2. the tarball carries both bins and both plugin bundles,
 *   3. `lexicon --version` and `lexicon normalize` work from the install,
 *   4. `lexicon-mcp` negotiates the MCP protocol versions Phantom's companion
 *      smoke uses and lists normalize_transcript and serve_status,
 *   5. the installed plugin hook answers UserPromptSubmit with JSON and exit 0.
 *
 * Never publishes and needs no registry credentials.
 * Usage: node scripts/pack-smoke.mjs
 * Requires: npm run build && npm run build:bundle
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSource } from './release-contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const shell = process.platform === 'win32';
// What Phantom's companion smoke (scripts/companion-workflow-smoke.mjs) negotiates and requires.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'];
const REQUIRED_TOOLS = ['normalize_transcript', 'serve_status'];

let failures = 0;
function report(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) {
    failures += 1;
    if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
  }
  return ok;
}

const work = mkdtempSync(path.join(os.tmpdir(), 'lexicon-pack-smoke-'));
try {
  // 1. version carriers
  try {
    report(`source version carriers agree on ${checkSource(root, `v${pkg.version}`)}`, true);
  } catch (err) {
    report('source version carriers agree', false, err.message);
  }

  // 2. pack once
  const packed = spawnSync(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: root, encoding: 'utf8', shell });
  if (!report('npm pack', packed.status === 0, packed.stderr)) throw new Error('pack failed');
  // Lifecycle output can precede the JSON report on stdout.
  const [info] = JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')));
  const files = new Set(info.files.map((f) => f.path));
  const needed = [...Object.values(pkg.bin), 'plugin/hook.mjs', 'plugin/hook-main.mjs', 'plugin/mcp-server.mjs', '.claude-plugin/plugin.json', 'README.md'].map((f) => f.replace(/^\.\//, ''));
  const missing = needed.filter((f) => !files.has(f));
  report(`${info.id}: ${info.entryCount} files, ${(info.size / 1024).toFixed(0)} kB packed`, missing.length === 0, `missing ${missing.join(', ')}`);

  // 3. install the tarball into an empty project
  const app = path.join(work, 'app');
  mkdirSync(app);
  writeFileSync(path.join(app, 'package.json'), '{"private":true}\n');
  const install = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', path.join(work, info.filename)], { cwd: app, encoding: 'utf8', shell });
  if (!report('tarball installs', install.status === 0, install.stderr)) throw new Error('install failed');
  const installed = path.join(app, 'node_modules', ...pkg.name.split('/'));
  const bin = (name) => path.join(installed, pkg.bin[name]);

  const home = path.join(work, 'home');
  mkdirSync(home);
  // A copy: the hook records hits beside the lexicon, which must not land in the repo.
  const lexicon = path.join(home, 'lexicon.yaml');
  copyFileSync(path.join(root, 'examples', 'lexicon.example.yaml'), lexicon);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    LEXICON_PATH: lexicon,
  };
  const node = (script, args = [], input) => spawnSync(process.execPath, [script, ...args], { cwd: home, env, input, encoding: 'utf8', timeout: 20_000 });

  const version = node(bin('lexicon'), ['--version']);
  report(`installed lexicon --version prints ${pkg.version}`, version.stdout.trim() === pkg.version, `${version.stdout}${version.stderr}`);
  const normalize = node(bin('lexicon'), ['normalize', 'ping ashler', '--cwd', home]);
  report('installed lexicon normalize corrects from the example lexicon', normalize.status === 0 && normalize.stdout.includes('Ashlr.AI'), `exit ${normalize.status}\n${normalize.stdout}${normalize.stderr}`);

  // 4. MCP, the way Phantom drives it
  for (const protocolVersion of PROTOCOL_VERSIONS) {
    const r = await handshake(bin('lexicon-mcp'), { env, cwd: home, protocolVersion });
    const absent = REQUIRED_TOOLS.filter((t) => !r.tools?.includes(t));
    report(
      `installed lexicon-mcp@${r.serverVersion} on ${protocolVersion}: ${r.tools?.length} tools`,
      !r.error && r.serverVersion === pkg.version && absent.length === 0,
      r.error ?? `serverInfo.version ${r.serverVersion}, missing ${absent.join(', ')}`,
    );
  }

  // 5. the installed plugin hook
  const hook = node(path.join(installed, 'plugin', 'hook.mjs'), [], JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'ping ashler', cwd: home, session_id: 'pack-smoke' }));
  let parsed = null;
  try {
    parsed = JSON.parse(hook.stdout);
  } catch {
    // reported below
  }
  report('installed plugin hook answers UserPromptSubmit with JSON', hook.status === 0 && parsed?.hookSpecificOutput?.additionalContext?.includes('Ashlr.AI'), `exit ${hook.status}\n${hook.stdout}${hook.stderr}`);
} catch (err) {
  if (failures === 0) report('pack smoke', false, err.message);
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

if (failures > 0) {
  console.error(`\n${failures} pack smoke check(s) failed`);
  process.exit(1);
}
console.log('\nall pack smoke checks passed');

/** initialize + tools/list over stdio; resolves with { serverVersion, tools } or { error }. */
function handshake(script, { env, cwd, protocolVersion }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map();
    let buffer = '';
    let stderr = '';
    let nextId = 0;
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => done({ error: `timed out\n${stderr.trim().slice(-300)}` }), 20_000);
    child.once('error', (err) => done({ error: String(err) }));
    child.stderr.setEncoding('utf8').on('data', (c) => (stderr += c));
    child.stdout.setEncoding('utf8').on('data', (c) => {
      buffer += c;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          waiting.get(message.id)?.(message);
        } catch {
          // not a JSON-RPC frame
        }
      }
    });
    const request = (method, params = {}) =>
      new Promise((res) => {
        const id = ++nextId;
        waiting.set(id, res);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    (async () => {
      const init = await request('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'lexicon-pack-smoke', version: '1' } });
      if (init.error) return done({ error: JSON.stringify(init.error) });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const list = await request('tools/list');
      done({ serverVersion: init.result?.serverInfo?.version, tools: (list.result?.tools ?? []).map((t) => t.name) });
    })().catch((error) => done({ error: String(error) }));
  });
}
