import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCTOR_CONFIG_MAX_BYTES, readDoctorConfigJson, readDoctorConfigText } from '../src/cli/doctor-config-read.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-doctor-reader-'));
  file = path.join(dir, '.config.json');
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }); });

describe('bounded Doctor configuration inspection', () => {
  it('preserves valid dotfile JSON, empty JSON and textual declarations', async () => {
    await fs.writeFile(file, '{"mcpServers":{"lexicon":{"command":"fixture"}}}');
    expect(await readDoctorConfigJson(file)).toEqual({ exists: true, value: { mcpServers: { lexicon: { command: 'fixture' } } } });
    await fs.writeFile(file, '   ');
    expect(await readDoctorConfigJson(file)).toEqual({ exists: true, value: {} });
    await fs.writeFile(file, '[mcp_servers.lexicon]\ncommand = "fixture"');
    expect(await readDoctorConfigText(file)).toEqual({ status: 'read', text: '[mcp_servers.lexicon]\ncommand = "fixture"' });
  });
  it('silently distinguishes initial absence from malformed JSON without leaking content', async () => {
    expect(await readDoctorConfigJson(file)).toEqual({ exists: false });
    await fs.writeFile(file, '{"private-token":"DO_NOT_REPORT",');
    expect(await readDoctorConfigJson(file)).toEqual({ exists: true, error: 'invalid-json' });
  });
  it('accepts exactly the inspection cap and refuses oversize before opening', async () => {
    await fs.writeFile(file, Buffer.alloc(DOCTOR_CONFIG_MAX_BYTES, 32));
    const read = await readDoctorConfigText(file);
    expect(read.status).toBe('read');
    if (read.status === 'read') expect(read.text.length).toBe(DOCTOR_CONFIG_MAX_BYTES);
    await fs.appendFile(file, 'x');
    const opened = vi.spyOn(fs, 'open');
    expect(await readDoctorConfigText(file)).toEqual({ status: 'unconfirmed', reason: 'too-large' });
    expect(opened).not.toHaveBeenCalled();
  });
  it('refuses directories and file symlinks without following them', async () => {
    expect(await readDoctorConfigText(dir)).toEqual({ status: 'unconfirmed', reason: 'nonregular' });
    await fs.writeFile(file, '{}');
    const link = path.join(dir, 'link');
    await fs.symlink(process.platform === 'win32' ? dir : file, link, process.platform === 'win32' ? 'junction' : 'file');
    expect(await readDoctorConfigText(link)).toEqual({ status: 'unconfirmed', reason: 'nonregular' });
  });
  it('refuses invalid UTF-8 with a fixed reason', async () => {
    await fs.writeFile(file, Buffer.from([0xc3, 0x28]));
    expect(await readDoctorConfigText(file)).toEqual({ status: 'unconfirmed', reason: 'invalid-utf8' });
  });
  it('preserves an initial BOM instead of newly accepting malformed JSON', async () => {
    await fs.writeFile(file, '\uFEFF{"mcpServers":{"lexicon":{"command":"fixture"}}}');
    expect(await readDoctorConfigText(file)).toEqual({ status: 'read', text: '\uFEFF{"mcpServers":{"lexicon":{"command":"fixture"}}}' });
    expect(await readDoctorConfigJson(file)).toEqual({ exists: true, error: 'invalid-json' });
  });
  it('refuses removal after the initial stat rather than fabricating absence', async () => {
    await fs.writeFile(file, '{}');
    const original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { await fs.unlink(file); return original(...args); });
    expect(await readDoctorConfigText(file)).toEqual({ status: 'unconfirmed', reason: 'unreadable' });
  });
  it('refuses a same-size replacement between stat and open and closes its descriptor', async () => {
    await fs.writeFile(file, '{}');
    const original = fs.open.bind(fs);
    let closed = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      await fs.rename(file, `${file}.old`); await fs.writeFile(file, '{}');
      const handle = await original(...args); const close = handle.close.bind(handle);
      handle.close = async () => { closed++; return close(); }; return handle;
    });
    expect(await readDoctorConfigText(file)).toEqual({ status: 'unconfirmed', reason: 'changed' });
    expect(closed).toBe(1);
  });
  for (const change of ['growth', 'shrink', 'mode', 'replacement', 'read-error'] as const) {
    it(`refuses ${change} during the FD read and closes exactly once`, async () => {
      await fs.writeFile(file, '{}', { mode: 0o600 });
      const original = fs.open.bind(fs);
      let closed = 0; let reads = 0; let allocation = 0;
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args); const close = handle.close.bind(handle); const read = handle.read.bind(handle);
        handle.close = async () => { closed++; return close(); };
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          reads++;
          if (reads === 1) {
            allocation = (readArgs[0] as unknown as Buffer).length;
            if (change === 'growth') await fs.appendFile(file, 'PRIVATE_GROWTH');
            if (change === 'shrink') await fs.truncate(file, 0);
            if (change === 'mode') {
              if (process.platform === 'win32') await fs.utimes(file, new Date(0), new Date(0));
              else await fs.chmod(file, 0o644);
            }
            if (change === 'replacement') { await fs.rename(file, `${file}.old`); await fs.writeFile(file, '{}'); }
            if (change === 'read-error') throw new Error('PRIVATE_CONTENT');
          }
          return read(...readArgs);
        }) as typeof handle.read;
        return handle;
      });
      expect(await readDoctorConfigText(file)).toEqual({ status: 'unconfirmed', reason: change === 'read-error' ? 'unreadable' : 'changed' });
      expect(allocation).toBe(3); expect(closed).toBe(1); expect(reads).toBeLessThanOrEqual(2);
    });
  }
  it('uses file URLs for child imports, preserving drive paths and special characters', async () => {
    const windowsPath = String.raw`C:\inert fixture\reader.mjs`;
    const windowsUrl = pathToFileURL(windowsPath, { windows: true });
    expect(windowsUrl.protocol).toBe('file:');
    expect(fileURLToPath(windowsUrl, { windows: true })).toBe(windowsPath);
    const env = { HOME: dir, USERPROFILE: dir, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
    // A drive-letter path is an unsupported URL scheme to the ESM loader,
    // independently of whether that synthetic file exists on this host.
    const raw = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(windowsPath)})`], { timeout: 1500, encoding: 'utf8', env });
    expect(raw.error).toBeUndefined(); expect(raw.status).toBe(1);
    expect(raw.stderr).toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME');
    const module = path.join(dir, 'reader # % with space.mjs');
    await fs.writeFile(module, 'export const marker = "portable fixture";');
    const url = pathToFileURL(module);
    expect(fileURLToPath(url)).toBe(module);
    const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', `import {marker} from ${JSON.stringify(url.href)};console.log(marker)`], { timeout: 1500, encoding: 'utf8', env });
    expect(imported.error).toBeUndefined(); expect(imported.status).toBe(0);
    expect(imported.stdout).toBe('portable fixture\n');
  });
  for (const race of [false, true]) {
    it(`refuses actual ${race ? 'post-stat' : 'existing'} FIFO/nonregular replacement within the unchanged child bound`, async () => {
      const bundle = path.join(dir, 'reader.mjs');
      const source = path.resolve('src/cli/doctor-config-read.ts');
      await build({ entryPoints: [source], outfile: bundle, bundle: true, platform: 'node', format: 'esm', plugins: [{
        name: 'inert-open-observer', setup(b) { b.onLoad({ filter: /doctor-config-read\.ts$/ }, async (args) => ({
          loader: 'ts', contents: (await fs.readFile(args.path, 'utf8')).replace('promises as fs', 'promises as actualFs') + `
import syncFs from 'node:fs'; import {execFileSync as fixtureExec} from 'node:child_process';
const fs={...actualFs,async open(...args){if(globalThis.fixtureRace){syncFs.unlinkSync(args[0]);if(process.platform==='win32')syncFs.mkdirSync(args[0]);else fixtureExec('/usr/bin/mkfifo',[args[0]]);process.stderr.write('NONREGULAR_INSTALLED\\n');}const h=await actualFs.open(...args);const r=h.read.bind(h);h.read=(...a)=>{process.stderr.write('TARGET_READ\\n');return r(...a)};return h;}};
`,
        })); },
      }] });
      if (race) await fs.writeFile(file, '{}');
      else if (process.platform === 'win32') await fs.mkdir(file);
      else expect(spawnSync('/usr/bin/mkfifo', [file]).status).toBe(0);
      const child = path.join(dir, 'child.mjs');
      await fs.writeFile(child, `import {readDoctorConfigText} from ${JSON.stringify(pathToFileURL(bundle).href)};globalThis.fixtureRace=${race};process.stdout.write(JSON.stringify(await readDoctorConfigText(${JSON.stringify(file)})));`);
      const result = spawnSync(process.execPath, [child], { timeout: 1500, encoding: 'utf8', env: { HOME: dir, USERPROFILE: dir, PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).status).toBe('unconfirmed'); expect(result.stderr).not.toContain('TARGET_READ');
      if (race) expect(result.stderr).toContain('NONREGULAR_INSTALLED');
    });
  }
});
