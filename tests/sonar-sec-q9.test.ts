/**
 * Regression coverage for the Sonar findings of RQ-LEXSONAR8Q8:
 *
 * - S2245 (insecure randomness): Math.random minted the cross-process lock
 *   token, the lock backoff jitter, the download `.part` name and the
 *   recorder's stop-claim name. All of them are now `node:crypto`, and a
 *   source scan keeps `Math.random` out of `src/` for good.
 * - S1523 (dynamic code execution): web/scripts/gen-faq-doc.mjs eval'd the
 *   FAQ array out of web/lib/site.ts to generate docs/FAQ.md. It now parses
 *   the string literals without executing anything, so an edit to site.ts can
 *   never turn doc generation into code execution.
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withFileLock } from '../src/util/atomic.js';
import { GGML_MAGIC, defaultDownloader } from '../src/voice/models.js';
import { claimStop, stateFilePath, voiceDir } from '../src/voice/recorder.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tmp: string;

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-sonar-q9-')));
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Every TypeScript file under `dir`, recursively. */
async function* tsFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(p);
    else if (entry.name.endsWith('.ts')) yield p;
  }
}

describe('crypto-safe randomness (S2245)', () => {
  it('src/ keeps no Math.random at all', async () => {
    const offenders: string[] = [];
    for await (const file of tsFiles(path.join(root, 'src'))) {
      if (/\bMath\.random\b/.test(await fs.readFile(file, 'utf8'))) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  it('the lock token is a crypto-random value, distinct per acquisition', async () => {
    const target = path.join(tmp, 'lexicon.yaml');
    const tokens: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      await withFileLock(target, async () => {
        const owner = JSON.parse(await fs.readFile(`${target}.lock`, 'utf8')) as { token: string };
        tokens.push(owner.token);
      });
    }
    for (const token of tokens) expect(token).toMatch(/^\d+-[0-9a-z]+-[0-9a-f]{16}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it('a download still lands atomically and leaves no .part behind', async () => {
    const payload = Buffer.concat([GGML_MAGIC, Buffer.alloc(1024, 0xab)]);
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-length': payload.length, 'content-type': 'application/octet-stream' });
      res.end(payload);
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ggml-tiny.bin`;
      const dest = path.join(tmp, 'models', 'ggml-tiny.bin');
      const progress: number[] = [];
      await defaultDownloader(url, dest, (p) => progress.push(p.received));
      expect(await fs.readFile(dest)).toEqual(payload);
      expect(progress.at(-1)).toBe(payload.length);
      expect((await fs.readdir(path.dirname(dest))).filter((n) => n.endsWith('.part'))).toEqual([]);
      // The sha256 record is written for the file that checked out.
      expect(JSON.parse(await fs.readFile(`${dest}.sha256.json`, 'utf8'))).toMatchObject({ sha256: expect.any(String) });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('claimStop still claims the state file under a fresh, unique name', async () => {
    const globalPath = path.join(tmp, 'voice-home', 'lexicon.yaml');
    const dir = voiceDir(globalPath);
    await fs.mkdir(dir, { recursive: true });
    const state = { pid: 12345, wav: path.join(dir, 'recording-1.wav'), startedAt: new Date().toISOString() };
    await fs.writeFile(stateFilePath(globalPath), JSON.stringify(state));
    const claimed = await claimStop(globalPath);
    expect(claimed).toEqual(state);
    // The rename consumed the state file and the claim breadcrumb is gone.
    await expect(fs.stat(stateFilePath(globalPath))).rejects.toThrow();
    expect((await fs.readdir(dir)).filter((n) => n.startsWith('stopping-'))).toEqual([]);
    // A second press finds nothing to stop.
    expect(await claimStop(globalPath)).toBeUndefined();
  });
});

describe('no dynamic execution in the FAQ generator (S1523)', () => {
  it('gen-faq-doc.mjs keeps no eval, Function or vm code path', async () => {
    const src = await fs.readFile(path.join(root, 'web/scripts/gen-faq-doc.mjs'), 'utf8');
    expect(src).not.toMatch(/\beval\s*\(/);
    expect(src).not.toMatch(/new\s+Function\s*\(/);
    expect(src).not.toMatch(/\bvm\.(?:runIn|createContext|compileFunction)/);
  });

  it('the parser reproduces docs/FAQ.md exactly (--check passes)', () => {
    const run = spawnSync(process.execPath, [path.join(root, 'web/scripts/gen-faq-doc.mjs'), '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
  });

  it('the generated doc states the resource count the code derives', async () => {
    const faq = await fs.readFile(path.join(root, 'docs/FAQ.md'), 'utf8');
    // Three resources: lexicon://me, lexicon://json and lexicon://glossary.
    // The count used to be hardcoded in the generator and read "two" a year
    // after the third one shipped.
    expect(faq).toMatch(/three resources/);
    expect(faq).not.toMatch(/\btwo resources\b/);
  });

  /**
   * Run a copy of the generator against a fixture `lib/site.ts`. The script
   * resolves webRoot and repoRoot from its own path, so a copy inside
   * `<dir>/web/scripts/` reads `<dir>/web/lib/site.ts` and writes
   * `<dir>/docs/FAQ.md`, leaving the real tree alone.
   */
  async function fixtureRun(siteTs: string): Promise<{ status: number | null; stdout: string; stderr: string; faq: string | null }> {
    const dir = await fs.mkdtemp(path.join(tmp, 'faq-fixture-'));
    const web = path.join(dir, 'web');
    await fs.mkdir(path.join(web, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(web, 'lib'), { recursive: true });
    await fs.mkdir(path.join(dir, 'docs'), { recursive: true });
    await fs.copyFile(path.join(root, 'web/scripts/gen-faq-doc.mjs'), path.join(web, 'scripts/gen-faq-doc.mjs'));
    await fs.writeFile(path.join(web, 'lib/site.ts'), siteTs);
    const run = spawnSync(process.execPath, [path.join(web, 'scripts/gen-faq-doc.mjs')], { encoding: 'utf8' });
    const faq = await fs.readFile(path.join(dir, 'docs/FAQ.md'), 'utf8').catch(() => null);
    return { status: run.status, stdout: run.stdout, stderr: run.stderr, faq };
  }

  const SITE_HEAD = `
export const SITE_URL = 'https://lexicon.ashlr.ai';
export const REPO = 'https://github.com/ashlrai/lexicon';
export const MCP_TOOLS = [{ name: 'a', summary: 'b' }, { name: 'c', summary: 'd' }];
export const MCP_RESOURCES = [{ uri: 'lexicon://me', summary: 'm' }];
export const MCP_PROMPTS = [{ name: 'p', summary: 'q' }];
`;

  it('parses escapes, joined literals and markdown brackets without executing', async () => {
    const run = await fixtureRun(`${SITE_HEAD}
export type Faq = { q: string; a: string };
export const FAQ: Faq[] = [
  { q: 'It\\'s a [linked](page) question?', a: 'An answer with a \\'quote\\' and a [markdown](link).' },
  // A comment inside the array is skipped, and '+' joins like the site does.
  { q: 'Second?', a: 'A ' + 'joined' + ' literal.' },
];
`);
    expect(run.status).toBe(0);
    expect(run.faq).toContain("## It's a [linked](page) question?");
    expect(run.faq).toContain("An answer with a 'quote' and a [markdown](link).");
    expect(run.faq).toContain('A joined literal.');
    expect(run.faq).toContain('the two tools, one resource and one prompt');
  });

  it('an expression in the array stops the build instead of running', async () => {
    const run = await fixtureRun(`${SITE_HEAD}
export const FAQ = [
  { q: 'hi', a: (process.stdout.write('PWNED'), 'x') },
];
`);
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('PWNED');
    expect(run.stderr).toMatch(/the FAQ array in lib\/site\.ts/);
  });

  it('a template interpolation stops the build instead of evaluating', async () => {
    const run = await fixtureRun(`${SITE_HEAD}
export const FAQ = [
  { q: 'hi', a: \`\${process.env.HOME}\` },
];
`);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/template \$\{\.\.\.\} is an expression/);
  });
});
