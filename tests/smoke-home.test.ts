/**
 * Catches: `npm run smoke` pointing LEXICON_PATH at the committed example
 * file, which made every run write hits.json, index-cache.json and
 * node-compile-cache/ into examples/ (and run with the real HOME).
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without a declaration file
import { prepareSmokeHome } from '../scripts/smoke-home.mjs';

interface SmokeHome {
  dir: string;
  lexiconPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('smoke home', () => {
  it('runs the hook against a temp copy of the example and leaves examples/ alone', async () => {
    const before = (await fs.readdir(path.join(root, 'examples'))).sort();
    const home = (await prepareSmokeHome(root, { PATH: process.env.PATH, HOME: '/nonexistent-real-home' })) as SmokeHome;
    try {
      expect(home.dir.startsWith(path.resolve(os.tmpdir())) || home.dir.startsWith(await fs.realpath(os.tmpdir()))).toBe(true);
      expect(home.dir.startsWith(root)).toBe(false);
      for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LEXICON_PATH'] as const) {
        expect(home.env[key]?.startsWith(home.dir), key).toBe(true);
      }
      expect(await fs.readFile(home.lexiconPath, 'utf8')).toBe(
        await fs.readFile(path.join(root, 'examples', 'lexicon.example.yaml'), 'utf8'),
      );

      const r = spawnSync(process.execPath, [path.join(root, 'plugin', 'hook.mjs')], {
        cwd: home.dir,
        env: home.env,
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'ping ashler' }),
        encoding: 'utf8',
      });
      expect(r.stdout).toContain('Ashlr.AI');
      expect((await fs.readdir(path.join(root, 'examples'))).sort()).toEqual(before);
      // What the hook does write lands beside the copy instead.
      expect((await fs.readdir(path.dirname(home.lexiconPath))).length).toBeGreaterThan(1);
    } finally {
      await home.cleanup();
    }
    await expect(fs.access(home.dir)).rejects.toThrow();
  });
});
