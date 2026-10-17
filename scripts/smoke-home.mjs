/**
 * The throwaway home `scripts/smoke.mjs` runs in. The checks used to point
 * LEXICON_PATH at examples/lexicon.example.yaml, so every run wrote hits.json,
 * index-cache.json and node-compile-cache/ beside it (inside the repo), and
 * left HOME as the real one. Now the example is copied into a fresh temp
 * directory that also stands in for HOME and the XDG directories, and is
 * removed afterwards.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {string} root repository root
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {Promise<{ dir: string, lexiconPath: string, env: NodeJS.ProcessEnv, cleanup: () => Promise<void> }>}
 */
export async function prepareSmokeHome(root, baseEnv = process.env) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-smoke-')));
  const configDir = path.join(dir, '.config', 'lexicon');
  await fs.mkdir(configDir, { recursive: true });
  const lexiconPath = path.join(configDir, 'lexicon.yaml');
  await fs.copyFile(path.join(root, 'examples', 'lexicon.example.yaml'), lexiconPath);
  const env = {
    ...baseEnv,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    XDG_CACHE_HOME: path.join(dir, '.cache'),
    XDG_DATA_HOME: path.join(dir, '.local', 'share'),
    LEXICON_PATH: lexiconPath,
  };
  delete env.LEXICON_TRUST_ALL;
  const cleanup = () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  return { dir, lexiconPath, env, cleanup };
}
