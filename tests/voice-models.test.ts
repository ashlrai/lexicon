/**
 * whisper model files: the models directory setting, the check that an
 * existing file is a model, and the sha256 recorded at download. Temp
 * directories only; no network (fetch is stubbed where a download runs).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctorReport } from '../src/cli/cmd-doctor.js';

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
