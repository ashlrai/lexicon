/**
 * whisper model files: the models directory setting, the check that an
 * existing file is a model, and the sha256 recorded at download. Temp
 * directories only; no network (fetch is stubbed where a download runs).
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctorReport } from '../src/cli/cmd-doctor.js';
import { GGML_MAGIC, REPO_MODELS_DIR, checkModelHashRecord, claimedSha256, defaultDownloader, ensureModel, inspectModelFile, modelFileName, modelHashPath, resolveModel } from '../src/voice/models.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'lexicon-voice-models-'));
  dirs.push(d);
  return d;
}

describe('lexicon doctor and the models directory', () => {
  it('warns about a relative LEXICON_WHISPER_MODELS instead of failing the report', async () => {
    const home = tmp();
    const report = await runDoctorReport({ cwd: home }, { home, platform: 'linux', env: { PATH: '', LEXICON_WHISPER_MODELS: 'models' }, exec: () => 'no servers' });
    expect(report.checks).toContainEqual({
      level: 'warn',
      message: expect.stringMatching(/^LEXICON_WHISPER_MODELS must be an absolute path or start with ~\/ \(it is "models"\).*lexicon voice refuses to run with it\)$/),
    });

  });
});

const MODEL = Buffer.concat([GGML_MAGIC, Buffer.from('weights')]);
const NOT_A_MODEL = 'it is not a ggml whisper model (it does not start with the ggml magic bytes)';

describe('an existing model file is checked before it is used', () => {
  it('inspectModelFile: missing, empty, not ggml, or a model', () => {
    const d = tmp();
    expect(inspectModelFile(path.join(d, 'nope.bin'))).toBe('missing');
    expect(inspectModelFile(d)).toBe('missing');
    writeFileSync(path.join(d, 'empty.bin'), '');
    expect(inspectModelFile(path.join(d, 'empty.bin'))).toBe('the file is empty');
    writeFileSync(path.join(d, 'page.bin'), '<html>login</html>');
    expect(inspectModelFile(path.join(d, 'page.bin'))).toBe(NOT_A_MODEL);
    writeFileSync(path.join(d, 'short.bin'), 'lm');
    expect(inspectModelFile(path.join(d, 'short.bin'))).toBe(NOT_A_MODEL);
    writeFileSync(path.join(d, 'ok.bin'), MODEL);
    expect(inspectModelFile(path.join(d, 'ok.bin'))).toBeUndefined();
  });

  // Catches: any file at the model's path was taken as the model, so an empty
  // file or a saved error page failed every dictation until deleted by hand.
  it('resolveModel passes over a broken file: not present, the reason given, a broken fallback skipped', () => {
    const d = tmp();
    const globalPath = path.join(d, 'lexicon.yaml');
    const models = path.join(d, 'models');
    const fallback = path.join(d, 'fallback');
    mkdirSync(models);
    mkdirSync(fallback);
    writeFileSync(path.join(models, modelFileName('base.en')), '');
    writeFileSync(path.join(fallback, modelFileName('base.en')), 'not a model');
    expect(resolveModel('base.en', { globalPath, env: {}, fallbackDirs: [fallback] })).toMatchObject({
      path: path.join(models, modelFileName('base.en')),
      present: false,
      problem: 'the file is empty',
    });
    writeFileSync(path.join(fallback, modelFileName('base.en')), MODEL);
    expect(resolveModel('base.en', { globalPath, env: {}, fallbackDirs: [fallback] })).toMatchObject({ present: true, foundIn: fallback });
    const explicit = path.join(d, 'mine.bin');
    writeFileSync(explicit, 'oops');
    expect(resolveModel(explicit, { globalPath, env: {} })).toEqual({ name: 'mine', path: explicit, present: false, problem: NOT_A_MODEL });
  });

  it('ensureModel downloads a named model again over a broken file, and refuses a broken explicit path', async () => {
    const d = tmp();
    const globalPath = path.join(d, 'lexicon.yaml');
    const dest = path.join(d, 'models', modelFileName('tiny.en'));
    mkdirSync(path.dirname(dest));
    writeFileSync(dest, '<html>captive portal</html>');
    const lines: string[] = [];
    const urls: string[] = [];
    const model = await ensureModel('tiny.en', {
      globalPath,
      env: {},
      fallbackDirs: [],
      log: (l) => lines.push(l),
      progress: () => undefined,
      download: async (url, to) => {
        urls.push(url);
        writeFileSync(to, MODEL);
      },
    });
    expect(model).toMatchObject({ path: dest, present: true });
    expect(urls).toHaveLength(1);
    expect(lines[0]).toBe(`whisper model tiny.en at ${dest} is not usable (${NOT_A_MODEL}); fetching ${urls[0]} again`);
    const explicit = path.join(d, 'mine.bin');
    writeFileSync(explicit, '');
    await expect(ensureModel(explicit, { globalPath, env: {} })).rejects.toThrow(`whisper model ${explicit} is not usable: the file is empty`);
  });

  // A checkout that ran the audio benchmark has a real base.en there, which doctor would rightly use.
  const benchModel = REPO_MODELS_DIR !== undefined && existsSync(path.join(REPO_MODELS_DIR, modelFileName('base.en')));
  it.skipIf(benchModel)('lexicon doctor warns about a broken default model', async () => {
    const home = tmp();
    const models = path.join(home, 'models');
    mkdirSync(models);
    writeFileSync(path.join(models, modelFileName('base.en')), '');
    const report = await runDoctorReport({ cwd: home }, { home, platform: 'linux', env: { PATH: '', LEXICON_WHISPER_MODELS: models }, exec: () => 'no servers' });
    expect(report.checks).toContainEqual({ level: 'warn', message: expect.stringContaining('is not usable: the file is empty (lexicon voice downloads it again on its next run)') });
  });
});

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** fetch answering `body` with the given headers: no network. */
function stubFetch(body: Buffer, headers: Record<string, string> = {}): void {
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length), ...headers } }));
}

describe('the sha256 of a downloaded model', () => {
  it('claimedSha256 reads the 64-hex X-Linked-Etag or ETag, nothing else', () => {
    const h = 'a'.repeat(64);
    expect(claimedSha256(new Headers({ 'x-linked-etag': `"${h}"` }))).toBe(h);
    expect(claimedSha256(new Headers({ etag: `W/"${h.toUpperCase()}"` }))).toBe(h);
    expect(claimedSha256(new Headers({ etag: '"abc123-git-sha1"' }))).toBeUndefined();
    expect(claimedSha256(new Headers({}))).toBeUndefined();
  });

  // Catches: a download was never checked against a hash, and nothing noticed a model that changed on disk later.
  it('is checked against the server\'s, recorded beside the model, and a mismatch keeps nothing', async () => {
    const d = tmp();
    const dest = path.join(d, modelFileName('tiny.en'));
    stubFetch(MODEL, { 'x-linked-etag': `"${sha(MODEL)}"` });
    await defaultDownloader('https://example.invalid/m', dest, () => undefined);
    expect(JSON.parse(readFileSync(modelHashPath(dest), 'utf8'))).toMatchObject({ version: 1, sha256: sha(MODEL), size: MODEL.length });

    const other = path.join(d, modelFileName('base.en'));
    stubFetch(MODEL, { 'x-linked-etag': `"${'0'.repeat(64)}"` });
    await expect(defaultDownloader('https://example.invalid/m', other, () => undefined)).rejects.toThrow(
      `the file downloaded does not match the sha256 the server gave for it (${'0'.repeat(64)}; the download's is ${sha(MODEL)})`,
    );
    expect(existsSync(other)).toBe(false);
    expect(existsSync(modelHashPath(other))).toBe(false);
  });

  it('later loads notice a model that changed, hash again only when size or mtime moved, and never download over it', async () => {
    const d = tmp();
    const globalPath = path.join(d, 'lexicon.yaml');
    const dest = path.join(d, 'models', modelFileName('tiny.en'));
    stubFetch(MODEL);
    await defaultDownloader('https://example.invalid/m', dest, () => undefined);
    const opts = { globalPath, env: {}, fallbackDirs: [] };
    expect(resolveModel('tiny.en', opts)).toMatchObject({ present: true });

    // Same bytes, new mtime: hashed again, still the model, and the record follows the mtime.
    const later = new Date(Date.now() + 60_000);
    utimesSync(dest, later, later);
    expect(resolveModel('tiny.en', opts)).toMatchObject({ present: true });
    expect((JSON.parse(readFileSync(modelHashPath(dest), 'utf8')) as { mtimeMs: number }).mtimeMs).toBe(statSync(dest).mtimeMs);

    // Changed bytes, same size: the sha256 says so.
    writeFileSync(dest, Buffer.concat([GGML_MAGIC, Buffer.from('weightz')]));
    const changed = resolveModel('tiny.en', opts);
    expect(changed).toMatchObject({ present: false, modified: true });
    expect(changed.problem).toMatch(/^it changed since Lexicon downloaded it \(its sha256 is [0-9a-f]{64}, not the [0-9a-f]{64} recorded\); delete it to download it again, or delete .*\.sha256\.json to keep using it as it is$/);
    const download = vi.fn(async () => undefined);
    await expect(ensureModel('tiny.en', { ...opts, download, log: () => undefined })).rejects.toThrow('is not usable: it changed since Lexicon downloaded it');
    expect(download).not.toHaveBeenCalled();

    // Changed size: no hash needed.
    appendFileSync(dest, 'x');
    expect(checkModelHashRecord(dest)).toMatch(/^it changed since Lexicon downloaded it \(\d+ bytes now, \d+ then\)/);
  });
});

describe('a download that fails says why', () => {
  // Catches: every failed download said "check the network", for a misspelt model name (a 404) and a full disk alike.
  it('names a model that does not exist instead of blaming the network', async () => {
    const d = tmp();
    vi.stubGlobal('fetch', async () => new Response('Entry not found', { status: 404, statusText: 'Not Found' }));
    const err = await defaultDownloader('https://example.invalid/ggml-base-en.bin', path.join(d, 'm.bin'), () => undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 404 });

    const globalPath = path.join(d, 'lexicon.yaml');
    const opts = { globalPath, env: {}, fallbackDirs: [], log: () => undefined, progress: () => undefined };
    const thrown = await ensureModel('base-en', opts).catch((e: unknown) => (e as Error).message);
    expect(thrown).toContain('there is no whisper model named base-en');
    expect(thrown).toContain('base.en');
    expect(thrown).not.toContain('check the network');
  });

  it('says the disk is full, with the model size, rather than blaming the network', async () => {
    const d = tmp();
    const globalPath = path.join(d, 'lexicon.yaml');
    const download = async (_url: string, _dest: string, onProgress: (p: { received: number; total?: number }) => void): Promise<void> => {
      onProgress({ received: 1_048_576, total: 147_951_465 });
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const thrown = await ensureModel('base.en', { globalPath, env: {}, fallbackDirs: [], download, log: () => undefined, progress: () => undefined }).catch(
      (e: unknown) => (e as Error).message,
    );
    expect(thrown).toContain(`there is no space left for it in ${path.join(d, 'models')} (it is 141 MB)`);
    expect(thrown).toContain('LEXICON_WHISPER_MODELS');
    expect(thrown).not.toContain('check the network');
  });
});
