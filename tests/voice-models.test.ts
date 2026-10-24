/**
 * whisper model files: the models directory setting, the check that an
 * existing file is a model, and the sha256 recorded at download. Temp
 * directories only; no network (fetch is stubbed where a download runs).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctorReport } from '../src/cli/cmd-doctor.js';
import { GGML_MAGIC, REPO_MODELS_DIR, ensureModel, inspectModelFile, modelFileName, resolveModel } from '../src/voice/models.js';

const dirs: string[] = [];
afterEach(() => {
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
