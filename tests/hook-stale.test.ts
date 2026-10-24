/**
 * The first prompt after a hand edit of a large global lexicon: matched
 * against the previous version (the stale note says so) while a background
 * refresh parses and indexes the new one, instead of parsing and indexing
 * inside the prompt (about 600 ms at 5000 terms, three times the hook's
 * budget). Real store, temp directories only.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARSE_CACHE_FILE_NAME, STALE_GLOBAL_MIN_BYTES, loadLexicon, writeLexiconFile } from '../src/core/store.js';
import type { Lexicon } from '../src/core/types.js';
import {
  REFRESH_LOCK_FILE,
  REFRESH_LOCK_STALE_MS,
  STALE_LEXICON_NOTE,
  STALE_SESSION_NOTE,
  claimCacheRefresh,
  refreshHookCaches,
  runHook,
} from '../src/hooks/user-prompt-submit.js';

/** The hook's background hit counting, awaited before a test's directory is removed. */
const pendingHits = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock('../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/index.js')>();
  return {
    ...actual,
    recordHits: (...args: Parameters<typeof actual.recordHits>) => {
      const p = actual.recordHits(...args);
      pendingHits.push(p);
      return p;
    },
  };
});

let tmp: string;
let globalPath: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};

/** A lexicon well past STALE_GLOBAL_MIN_BYTES, with Ashlr.AI (alias Ashler) in it. */
function bigLexicon(): Lexicon {
  const terms = [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }];
  for (let i = 0; i < 1500; i += 1) terms.push({ canonical: `Filler${i}word`, aliases: [`fillerx${i}y`, `fillerz${i}q`] });
  return { version: 1, terms };
}

const lockPath = (): string => path.join(path.dirname(globalPath), REFRESH_LOCK_FILE);
const payload = (prompt: string): string => JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd, prompt });
const session = (): string => JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd });
const context = (out: string): string => (out ? (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext : '');

/** Hand edit: a new term appended to the YAML, as an editor would. */
async function appendTerm(yaml: string): Promise<void> {
  await fs.appendFile(globalPath, yaml);
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-hook-stale-')));
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  cwd = path.join(tmp, 'repo');
  await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
  for (const key of ['LEXICON_PATH', 'LEXICON_QUEUE_CORRECTIONS', 'LEXICON_TRUST_ALL']) saved[key] = process.env[key];
  process.env.LEXICON_PATH = globalPath;
  process.env.LEXICON_QUEUE_CORRECTIONS = '0';
  delete process.env.LEXICON_TRUST_ALL;
  await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: bigLexicon(), exists: false });
  expect((await fs.stat(globalPath)).size).toBeGreaterThan(STALE_GLOBAL_MIN_BYTES);
  // A first prompt builds the index cache, as a warm hook has.
  expect(context(await runHook(payload('ask Ashler')))).toContain('"Ashler" -> "Ashlr.AI"');
});

afterEach(async () => {
  await Promise.all(pendingHits.splice(0));
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('a changed large global lexicon is served stale while a background refresh runs', () => {
  // Catches: the first prompt after a hand edit parsed and indexed the whole lexicon inside the prompt.
  it('matches the previous version with the stale note, starts one refresh, and the next prompt sees the edit', async () => {
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    const startRefresh = vi.fn(async () => undefined);
    const ctx = context(await runHook(payload('ask Ashler about kwertyon'), { startRefresh }));
    expect(ctx).toContain('"Ashler" -> "Ashlr.AI"');
    expect(ctx).not.toContain('Qwertyon');
    expect(ctx).toContain(STALE_LEXICON_NOTE);
    expect(startRefresh).toHaveBeenCalledTimes(1);
    expect(startRefresh).toHaveBeenCalledWith(cwd);
    await expect(fs.stat(lockPath())).resolves.toBeDefined();

    // A second prompt while the refresh runs: still stale, no second refresh.
    expect(context(await runHook(payload('ask Ashler'), { startRefresh }))).toContain(STALE_LEXICON_NOTE);
    expect(startRefresh).toHaveBeenCalledTimes(1);

    await refreshHookCaches(cwd);
    await expect(fs.stat(lockPath())).rejects.toThrow();
    const after = context(await runHook(payload('ask Ashler about kwertyon'), { startRefresh }));
    expect(after).toContain('"kwertyon" -> "Qwertyon"');
    expect(after).not.toContain(STALE_LEXICON_NOTE);
    expect(startRefresh).toHaveBeenCalledTimes(1);
  });

  it('parses at once without a refresher (library callers), as before', async () => {
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    const ctx = context(await runHook(payload('ask kwertyon')));
    expect(ctx).toContain('"kwertyon" -> "Qwertyon"');
    expect(ctx).not.toContain(STALE_LEXICON_NOTE);
  });

  it('parses at once when a refresh lock is older than REFRESH_LOCK_STALE_MS, and removes it', async () => {
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    await fs.writeFile(lockPath(), '{}\n');
    const old = new Date(Date.now() - REFRESH_LOCK_STALE_MS - 1000);
    await fs.utimes(lockPath(), old, old);
    const startRefresh = vi.fn(async () => undefined);
    expect(context(await runHook(payload('ask kwertyon'), { startRefresh }))).toContain('"kwertyon" -> "Qwertyon"');
    expect(startRefresh).not.toHaveBeenCalled();
    await expect(fs.stat(lockPath())).rejects.toThrow();
  });

  it('parses at once and releases the lock when the refresh cannot start', async () => {
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const startRefresh = vi.fn(async () => {
        throw new Error('spawn EACCES');
      });
      expect(context(await runHook(payload('ask kwertyon'), { startRefresh }))).toContain('"kwertyon" -> "Qwertyon"');
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain('[lexicon hook] could not start the cache refresh: spawn EACCES');
    } finally {
      stderr.mockRestore();
    }
    await expect(fs.stat(lockPath())).rejects.toThrow();
  });

  it('reports an edit that broke the file once the refresh has recorded the failure', async () => {
    await appendTerm('  - canonical: ""\n');
    const startRefresh = vi.fn(async () => undefined);
    expect(context(await runHook(payload('ask Ashler'), { startRefresh }))).toContain(STALE_LEXICON_NOTE);
    await refreshHookCaches(cwd);
    const ctx = context(await runHook(payload('ask Ashler'), { startRefresh }));
    expect(ctx).toContain('Lexicon is installed but is correcting nothing');
    expect(startRefresh).toHaveBeenCalledTimes(1);
  });

  // Catches: SessionStart parsed the changed file inline (about 450 ms at 5000 terms) while UserPromptSubmit was served stale.
  it('SessionStart after a hand edit lists the previous version with its note and starts one refresh', async () => {
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    const startRefresh = vi.fn(async () => undefined);
    const ctx = context(await runHook(session(), { startRefresh }));
    expect(ctx).toContain('Ashlr.AI');
    expect(ctx).not.toContain('Qwertyon');
    expect(ctx).toContain(STALE_SESSION_NOTE);
    expect(ctx.length).toBeLessThanOrEqual(4000);
    expect(startRefresh).toHaveBeenCalledTimes(1);
    expect(startRefresh).toHaveBeenCalledWith(cwd);
    // A prompt while that refresh runs does not start a second one.
    expect(context(await runHook(payload('ask Ashler'), { startRefresh }))).toContain(STALE_LEXICON_NOTE);
    expect(startRefresh).toHaveBeenCalledTimes(1);
    await refreshHookCaches(cwd);
    const after = context(await runHook(session(), { startRefresh }));
    expect(after).not.toContain(STALE_SESSION_NOTE);
    expect(startRefresh).toHaveBeenCalledTimes(1);
  });

  it('SessionStart without a refresher parses at once, as before', async () => {
    await appendTerm('  - canonical: Aaaqwertyon\n    aliases: [kwertyon]\n');
    const ctx = context(await runHook(session()));
    expect(ctx).toContain('Aaaqwertyon');
    expect(ctx).not.toContain(STALE_SESSION_NOTE);
  });

  it('never serves a small lexicon stale', async () => {
    await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }, ...bigLexicon().terms.slice(1, 300)] }, exists: true });
    expect((await fs.stat(globalPath)).size).toBeLessThan(STALE_GLOBAL_MIN_BYTES);
    await runHook(payload('ask Ashler'));
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    const startRefresh = vi.fn(async () => undefined);
    expect(context(await runHook(payload('ask kwertyon'), { startRefresh }))).toContain('"kwertyon" -> "Qwertyon"');
    expect(startRefresh).not.toHaveBeenCalled();
  });

  it('loadLexicon with staleGlobal flags the previous parse and writes nothing', async () => {
    const cache = path.join(path.dirname(globalPath), PARSE_CACHE_FILE_NAME);
    const before = await fs.readFile(cache, 'utf8');
    await appendTerm('  - canonical: Qwertyon\n    aliases: [kwertyon]\n');
    const stale = await loadLexicon({ cwd, staleGlobal: true });
    expect(stale.globalStale).toBe(true);
    expect(stale.merged.terms.some((t) => t.canonical === 'Qwertyon')).toBe(false);
    expect(await fs.readFile(cache, 'utf8')).toBe(before);
    const fresh = await loadLexicon({ cwd });
    expect(fresh.globalStale).toBeUndefined();
    expect(fresh.merged.terms.some((t) => t.canonical === 'Qwertyon')).toBe(true);
  });

  it('claimCacheRefresh: claimed, then running, then unavailable once the lock is old', async () => {
    expect(await claimCacheRefresh(globalPath)).toBe('claimed');
    expect(await claimCacheRefresh(globalPath)).toBe('running');
    expect(await claimCacheRefresh(globalPath, Date.now() + REFRESH_LOCK_STALE_MS + 1000)).toBe('unavailable');
    await expect(fs.stat(lockPath())).rejects.toThrow();
    expect(await claimCacheRefresh(path.join(tmp, 'missing-dir', 'lexicon.yaml'))).toBe('unavailable');
  });
});
