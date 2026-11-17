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
import { describe, expect, it, vi } from 'vitest';
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
  it('runs the hook successfully in an isolated home whose path contains spaces', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon fake smoke home-')));
    let home: SmokeHome | undefined;
    try {
      const fixtureRoot = path.join(parent, 'fake repository');
      await fs.mkdir(path.join(fixtureRoot, 'examples'), { recursive: true });
      await fs.writeFile(path.join(fixtureRoot, 'examples', 'lexicon.example.yaml'),
        'version: 1\nterms:\n  - canonical: FakeQuokka\n    aliases: [fake quokka]\n');
      // The helper still creates its real scratch home; only its temp parent changes.
      const tempDir = vi.spyOn(os, 'tmpdir').mockReturnValue(parent);
      try {
        home = (await prepareSmokeHome(fixtureRoot, { PATH: process.env.PATH })) as SmokeHome;
      } finally {
        tempDir.mockRestore();
      }
      expect(home.dir).toContain(' ');
      expect(home.env.HOME).toBe(home.dir);
      expect(home.lexiconPath.startsWith(home.dir + path.sep)).toBe(true);

      const result = spawnSync(process.execPath, [path.join(root, 'plugin', 'hook.mjs')], {
        cwd: home.dir,
        env: home.env,
        input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'ping fake quokka' }),
        encoding: 'utf8',
        timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('FakeQuokka');
      expect(result.stderr).toBe('');
      await home.cleanup();
      await expect(fs.access(home.dir)).rejects.toThrow();
    } finally {
      await fs.rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

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
