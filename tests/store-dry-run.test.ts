/** Preview writes run the same final-document validation as persisted writes. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTerm, addTerms } from '../src/core/store.js';
import { LIMITS } from '../src/core/schema.js';
import type { Term } from '../src/core/types.js';

let dir: string;
let globalPath: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-store-preview-'));
  globalPath = path.join(dir, 'lexicon.yaml');
});
afterEach(async () => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

async function sameRefusal(
  original: string,
  run: (dryRun: boolean) => Promise<unknown>,
  reason: string,
): Promise<void> {
  await fs.writeFile(globalPath, original);
  const messages: string[] = [];
  for (const dryRun of [true, false]) {
    let failure: unknown;
    try { await run(dryRun); } catch (err) { failure = err; }
    expect(failure, `dryRun=${dryRun} must refuse the invalid result`).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(reason);
    messages.push(message);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(original);
    await expect(fs.stat(`${globalPath}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  expect(messages[0]).toBe(messages[1]);
}

describe('store dry-run final validation', () => {
  it.each(['aliases', 'never'] as const)('refuses a merged term exceeding the %s limit in both preview and real writes', async (field) => {
    const original = JSON.stringify({ version: 1, terms: [{ canonical: 'QuasarBridge', aliases: [], [field]: Array.from({ length: LIMITS.aliases }, (_, i) => `spelling ${i}`) }] });
    const incoming: Term = { canonical: 'QuasarBridge', aliases: [], [field]: ['extra spelling'] };
    await sameRefusal(original, (dryRun) => addTerm(incoming, { globalPath, dryRun }), `at most ${LIMITS.aliases}`);
  });

  it('refuses a batch that would exceed the document term limit', async () => {
    const original = JSON.stringify({ version: 1, terms: Array.from({ length: LIMITS.terms }, (_, i) => ({ canonical: `Quasar${i}`, aliases: [] })) });
    await sameRefusal(original, (dryRun) => addTerms([{ canonical: 'ExtraQuasar', aliases: [] }], { globalPath, dryRun }), `at most ${LIMITS.terms} terms`);
  });

  it('retains the invalid-settings refusal before planning or saving an add', async () => {
    const original = JSON.stringify({ version: 1, settings: { minConfidence: 2 }, terms: [] });
    await sameRefusal(original, (dryRun) => addTerm({ canonical: 'QuasarBridge', aliases: [] }, { globalPath, dryRun }), 'minConfidence');
  });

  it('keeps committed hits when previewing a replacement, exactly as a real write does', async () => {
    const original = JSON.stringify({ version: 1, terms: [{ canonical: 'QuasarBridge', aliases: ['quasar bridge'], hits: 5 }] });
    await fs.writeFile(globalPath, original);
    const incoming: Term = { canonical: 'QuasarBridge', aliases: ['new spelling'], hits: 999 };
    const plan = await addTerm(incoming, { globalPath, dryRun: true, merge: false });
    expect(plan.term.hits).toBe(5);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(original);
    const applied = await addTerm(incoming, { globalPath, merge: false });
    expect(applied.term.hits).toBe(plan.term.hits);
    expect(applied.term.aliases).toEqual(plan.term.aliases);
  });

  it('drops caller-supplied hits from a new term in the plan and real result', async () => {
    const incoming: Term = { canonical: 'QuasarBridge', aliases: [], hits: 999 };
    const plan = await addTerm(incoming, { globalPath, dryRun: true });
    expect(plan.term.hits).toBeUndefined();
    await expect(fs.stat(globalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const applied = await addTerm(incoming, { globalPath });
    expect(applied.term.hits).toBeUndefined();
  });
});
