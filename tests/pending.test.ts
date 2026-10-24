import { promises as fs } from 'node:fs';
import os from 'node:os';
import { isHeldLockError } from '../src/util/atomic.js';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PENDING,
  PendingFileError,
  acceptPending,
  addTerm,
  listPending,
  loadLexicon,
  normalize,
  pendingId,
  pendingPathFor,
  queueCorrections,
  readPending,
  rejectPending,
  withLexiconLock,
} from '../src/core/index.js';
import { Command } from 'commander';
import { registerPendingCommands, runPendingAccept, runPendingList, runPendingReject } from '../src/cli/cmd-pending.js';
import { makeIO } from './helpers.js';

let dir: string;
let globalPath: string;
let cwd: string;

async function opts() {
  return { globalPath, cwd };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-pending-'));
  globalPath = path.join(dir, 'config', 'lexicon.yaml');
  cwd = path.join(dir, 'work');
  await fs.mkdir(cwd, { recursive: true });
  await addTerm({ canonical: 'Ashlr.AI', aliases: [], category: 'brand' }, { globalPath, cwd });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function corrected(text: string): Promise<string> {
  const loaded = await loadLexicon(await opts());
  return normalize(text, loaded.merged).output;
}

describe('pending aliases are queued, never applied', () => {
  it('queues a correction without touching the lexicon or matching', async () => {
    const before = await fs.readFile(globalPath, 'utf8');
    const outBefore = await corrected('ping Quibbletron today');
    const res = await queueCorrections([{ heard: 'Quibbletron', meant: 'Ashlr.AI' }], { ...(await opts()), source: 'prompt-hook' });
    expect(res.queued).toHaveLength(1);
    expect(res.file).toBe(pendingPathFor(globalPath));
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
    expect(await corrected('ping Quibbletron today')).toBe(outBefore);
    expect(outBefore).toBe('ping Quibbletron today');
    const { entries } = await listPending(await opts());
    expect(entries).toEqual([
      expect.objectContaining({ id: pendingId('Quibbletron', 'Ashlr.AI'), heard: 'Quibbletron', meant: 'Ashlr.AI', source: 'prompt-hook', count: 1 }),
    ]);
    const text = await fs.readFile(res.file, 'utf8');
    expect(text).toContain('Nothing here changes matching');
    if (process.platform !== 'win32') expect((await fs.stat(res.file)).mode & 0o777).toBe(0o600);
  });

  it('dedupes, counts repeats and skips invalid or already known corrections', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Ashler', meant: 'Ashlr.AI' }], { ...o, now: new Date('2026-01-01T00:00:00Z') });
    const res = await queueCorrections(
      [
        { heard: ' ashler ', meant: 'ashlr.ai' },
        { heard: '', meant: 'X' },
        { heard: 'same', meant: 'same' },
        { heard: 'x'.repeat(61), meant: 'Y' },
      ],
      { ...o, now: new Date('2026-01-02T00:00:00Z') },
    );
    expect(res.skipped).toBe(3);
    const { entries } = await listPending(o);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ count: 2, firstSeen: '2026-01-01T00:00:00.000Z', lastSeen: '2026-01-02T00:00:00.000Z' });

    await addTerm({ canonical: 'Vercel', aliases: ['versel'], category: 'product' }, o);
    const loaded = await loadLexicon(o);
    const known = await queueCorrections([{ heard: 'versel', meant: 'Vercel' }], { ...o, lexicon: loaded.merged });
    expect(known.skipped).toBe(1);
    expect((await listPending(o)).entries).toHaveLength(1);
  });

  it(`keeps at most ${MAX_PENDING} entries, dropping the least recently seen`, async () => {
    const o = await opts();
    const many = Array.from({ length: MAX_PENDING + 5 }, (_, i) => ({ heard: `garble${i}`, meant: `Name${i}` }));
    for (let i = 0; i < many.length; i++) {
      await queueCorrections([many[i]], { ...o, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
    }
    const { entries } = await listPending(o);
    expect(entries).toHaveLength(MAX_PENDING);
    expect(entries.some((e) => e.heard === 'garble0')).toBe(false);
    expect(entries.some((e) => e.heard === `garble${MAX_PENDING + 4}`)).toBe(true);
  }, 30_000);

  it('accept learns the alias (matching changes only now) and removes it from the queue', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Quibbletron', meant: 'Ashlr.AI' }, { heard: 'versel', meant: 'Vercel' }], o);
    expect(await corrected('ping Quibbletron')).toBe('ping Quibbletron');
    const res = await acceptPending({ ids: [pendingId('Quibbletron', 'Ashlr.AI')] }, o);
    expect(res.accepted[0].error).toBeUndefined();
    expect(await corrected('ping Quibbletron')).toBe('ping Ashlr.AI');
    const left = (await listPending(o)).entries;
    expect(left.map((e) => e.heard)).toEqual(['versel']);
  });

  it('reject drops the entry without learning it', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Quibbletron', meant: 'Ashlr.AI' }], o);
    const before = await fs.readFile(globalPath, 'utf8');
    const res = await rejectPending({ all: true }, o);
    expect(res.rejected).toHaveLength(1);
    expect((await listPending(o)).entries).toEqual([]);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
    expect(await corrected('ping Quibbletron')).toBe('ping Quibbletron');
  });

  it('a failed accept stays queued', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Ashler', meant: 'Ashlr.AI' }], o);
    const res = await acceptPending({ all: true }, o, async () => {
      throw new Error('disk full');
    });
    expect(res.accepted[0].error).toBe('disk full');
    expect((await listPending(o)).entries).toHaveLength(1);
  });

  it('accept takes the lexicon lock outside the pending lock (the contract order), so a lexicon writer that queues does not deadlock with it', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Quibbletron', meant: 'Ashlr.AI' }], o);
    // A writer that holds the lexicon lock and then queues a correction: the
    // order every other caller uses. With the pending lock outer in accept,
    // accept held it while waiting for the lexicon lock, and this writer
    // held the lexicon lock while waiting for the pending one.
    let release!: () => void;
    const holding = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const hasLexiconLock = new Promise<void>((resolve) => (entered = resolve));
    const writer = withLexiconLock(globalPath, async () => {
      entered();
      await holding;
      await queueCorrections([{ heard: 'versel', meant: 'Vercel' }], o);
    });
    await hasLexiconLock;
    const accept = acceptPending({ all: true }, o);
    // Let accept run as far as it can before the writer asks for the pending lock.
    await new Promise((r) => setTimeout(r, 150));
    release();
    const outcome = await Promise.race([
      Promise.all([writer, accept]).then(() => 'done'),
      new Promise((r) => setTimeout(() => r('deadlock'), 4_000)),
    ]);
    expect(outcome).toBe('done');
    const res = await accept;
    // Accept read the queue only once it had the lexicon lock, after the
    // writer queued, so it took both entries and lost neither.
    expect(res.accepted.map((a) => [a.entry.heard, a.error])).toEqual([['Quibbletron', undefined], ['versel', undefined]]);
    expect((await listPending(o)).entries).toEqual([]);
    expect(await corrected('ping Quibbletron')).toBe('ping Ashlr.AI');
  }, 15_000);

  it('lockTimeoutMs bounds the wait for a pending lock another live process holds', async () => {
    const o = await opts();
    const file = pendingPathFor(globalPath);
    await fs.writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'other', at: new Date().toISOString() }));
    const started = Date.now();
    const err = await queueCorrections([{ heard: 'Ashler', meant: 'Ashlr.AI' }], { ...o, lockTimeoutMs: 50 }).catch((e: unknown) => e);
    expect(isHeldLockError(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    await fs.rm(`${file}.lock`);
  });

  it('never overwrites a pending file it cannot read', async () => {
    const o = await opts();
    const file = pendingPathFor(globalPath);
    await fs.writeFile(file, 'pending: [not, valid, entries]\n');
    await expect(queueCorrections([{ heard: 'Ashler', meant: 'Ashlr.AI' }], o)).rejects.toBeInstanceOf(PendingFileError);
    expect(await fs.readFile(file, 'utf8')).toBe('pending: [not, valid, entries]\n');
    await fs.writeFile(file, ': : :\n  - [');
    await expect(readPending(file)).rejects.toBeInstanceOf(PendingFileError);
  });
});

describe('lexicon pending CLI', () => {
  it('lists, accepts and rejects by id', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Ashler', meant: 'Ashlr.AI' }, { heard: 'versel', meant: 'Vercel' }], o);
    const a = pendingId('Ashler', 'Ashlr.AI');
    const v = pendingId('versel', 'Vercel');

    let io = makeIO();
    expect(await runPendingList(o, io)).toBe(0);
    expect(io.out).toContain('2 pending aliases');
    expect(io.out).toContain('none of them changes matching until accepted');
    expect(io.out).toContain(a);

    io = makeIO();
    expect(await runPendingAccept([a], { ...o, json: true }, io)).toBe(0);
    const doc = JSON.parse(io.out) as { ok: boolean; accepted: Array<{ id: string; canonical: string }> };
    expect(doc.ok).toBe(true);
    expect(doc.accepted).toEqual([expect.objectContaining({ id: a, canonical: 'Ashlr.AI' })]);

    io = makeIO();
    expect(await runPendingReject([v], o, io)).toBe(0);
    expect(io.out).toContain('not learned');

    io = makeIO();
    expect(await runPendingList({ ...o, json: true }, io)).toBe(0);
    expect((JSON.parse(io.out) as { pending: unknown[] }).pending).toEqual([]);
  });

  // Catches: `accept --all` / `reject --all` on an empty queue printed nothing.
  it('--all on an empty queue says so, with where entries come from', async () => {
    const o = await opts();
    for (const [verb, run] of [['accept', runPendingAccept], ['reject', runPendingReject]] as const) {
      const io = makeIO();
      expect(await run([], { ...o, all: true }, io)).toBe(0);
      expect(io.out).toMatch(new RegExp(`^no pending aliases to ${verb} \\(.*pending-aliases\\.yaml\\); .*lexicon pending lists them\\n$`));
      expect(io.err).toBe('');
      const json = makeIO();
      expect(await run([], { ...o, all: true, json: true }, json)).toBe(0);
      expect(JSON.parse(json.out)).toMatchObject({ ok: true, unknown: [] });
    }
  });

  it('refuses without a selection and reports unknown ids', async () => {
    const o = await opts();
    let io = makeIO();
    expect(await runPendingAccept([], o, io)).toBe(1);
    expect(io.err).toContain('name one or more ids, or pass --all');
    io = makeIO();
    expect(await runPendingReject(['deadbeef'], o, io)).toBe(1);
    expect(io.err).toContain('no pending alias with id deadbeef; run lexicon pending list to see the ids\n');
    io = makeIO();
    expect(await runPendingAccept(['deadbeef'], o, io)).toBe(1);
    expect(io.err).toContain('no pending alias with id deadbeef; run lexicon pending list to see the ids\n');
  });

  // Catches: an unknown id exited 1 with `ok: true` under --json, and said
  // nothing on stderr there.
  it('--json leads with ok: false when an id is unknown, and names it on stderr', async () => {
    const o = await opts();
    for (const run of [runPendingAccept, runPendingReject]) {
      const io = makeIO();
      expect(await run(['deadbeef'], { ...o, json: true }, io)).toBe(1);
      expect(JSON.parse(io.out)).toMatchObject({
        ok: false,
        error: 'no pending alias with id deadbeef',
        nextStep: 'run lexicon pending list to see the ids',
        unknown: ['deadbeef'],
      });
      expect(io.err).toContain('no pending alias with id deadbeef');
    }
    const io = makeIO();
    expect(await runPendingReject(['deadbeef'], o, io)).toBe(1);
    expect(io.out).toBe('');
  });

  // Catches: `pending` defines --json too, and commander handed the flag to
  // it, so `pending accept <id> --json` printed text and `pending list --json`
  // printed the table.
  it('pending list|accept|reject honour their own --json', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Quibbletron', meant: 'Ashlr.AI' }, { heard: 'Ashlur', meant: 'Ashlr.AI' }], o);
    const id = pendingId('Quibbletron', 'Ashlr.AI');
    const other = pendingId('Ashlur', 'Ashlr.AI');
    const saved = process.env.LEXICON_PATH;
    process.env.LEXICON_PATH = globalPath;
    try {
      const parse = async (args: string[]) => {
        const io = makeIO();
        const program = new Command().exitOverride().option('--cwd <dir>');
        registerPendingCommands(program, io);
        await program.parseAsync([...args, '--cwd', cwd], { from: 'user' });
        return io;
      };
      expect(JSON.parse((await parse(['pending', 'list', '--json'])).out)).toMatchObject({ ok: true, pending: [{}, {}] });
      expect(JSON.parse((await parse(['pending', 'accept', id, '--json'])).out)).toMatchObject({ ok: true, accepted: [{ id, canonical: 'Ashlr.AI' }], unknown: [] });
      expect(JSON.parse((await parse(['pending', 'reject', other, '--json'])).out)).toMatchObject({ ok: true, rejected: [other], unknown: [] });
      expect(JSON.parse((await parse(['pending', '--json'])).out)).toMatchObject({ ok: true, pending: [] });
    } finally {
      if (saved === undefined) delete process.env.LEXICON_PATH;
      else process.env.LEXICON_PATH = saved;
      process.exitCode = undefined;
    }
  });

  it('marks entries the lexicon already knows', async () => {
    const o = await opts();
    await queueCorrections([{ heard: 'Ashler', meant: 'Ashlr.AI' }], o);
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' }, o);
    const io = makeIO();
    await runPendingList({ ...o, json: true }, io);
    expect((JSON.parse(io.out) as { pending: Array<{ alreadyKnown: boolean }> }).pending[0].alreadyKnown).toBe(true);
  });
});
