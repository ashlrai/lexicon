/**
 * An alias one character over the documented word limit (`word` 80 in
 * docs/CONTRACT.md's LIMITS paragraph, `LIMITS.word` in src/core/schema.ts)
 * at the write surfaces the schema and `lexicon add` boundary tests do not
 * reach: `lexicon import` of a foreign dictionary, MCP `apply_suggestion`
 * with an agent-supplied alias, `lexicon edit`'s re-parse of what an editor
 * saved, and the read-back check inside `writeLexiconFile` for write paths
 * that add no term of their own. Each refuses the entry as
 * `must be at most 80 characters`; the schema, store, CLI, serve and e2e
 * layers prove the same boundary for `add` in
 * schema-alias-word-limit.test.ts, contract-alias-word-limit.test.ts,
 * store.test.ts, serve.test.ts and e2e.test.ts.
 */
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/schema.js';
import { readLexiconFile, writeLexiconFile } from '../src/core/store.js';
import { runImport } from '../src/cli/cmd-import.js';
import { runEdit } from '../src/cli/cmd-review.js';
import type { SpawnEditor } from '../src/cli/cmd-review.js';
import { createServer } from '../src/mcp/server.js';
import { makeIO } from './helpers.js';

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

/**
 * The alias word cap the contract publishes, read back out of the doc so a
 * change to either side fails here. CONTRACT.md states it inside the
 * src/core/schema.ts section as "`word` 80 (canonical, alias)".
 */
const documentedLimit = (() => {
  const section = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = section?.match(/`word` (\d+) \(canonical, alias\)/);
  if (!match) throw new Error('docs/CONTRACT.md no longer documents the alias word limit');
  return Number(match[1]);
})();

const OVER = 'x'.repeat(documentedLimit + 1);
/** The entry as `term not added`'s `(...)` shows it: JSON.stringify of the first 24 characters. */
const SHOWN = JSON.stringify(`${'x'.repeat(24)}...`);
const REFUSAL = `must be at most ${documentedLimit} characters`;

let tmp: string;
let globalPath: string;
const savedEnv = process.env.LEXICON_PATH;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-alias-over-limit-')));
  globalPath = path.join(tmp, 'lexicon.yaml');
  process.env.LEXICON_PATH = globalPath;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = savedEnv;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('the documented limit this file pins', () => {
  it('is the 80 the schema caps an alias at', () => {
    expect(documentedLimit).toBe(80);
    expect(documentedLimit).toBe(LIMITS.word);
    expect(OVER).toHaveLength(81);
  });
});

describe('lexicon import of a foreign dictionary', () => {
  const read = (content: string) => async (): Promise<string> => content;

  it('refuses an alias one over the limit, naming the entry, and writes nothing', async () => {
    await expect(runImport('foreign.txt', { format: 'text', cwd: tmp }, makeIO(), read(`Zed: ${OVER}\n`))).rejects.toThrow(
      `term not added: aliases[0] (${SHOWN}): ${REFUSAL}. Nothing was written; fix that field and try again.`,
    );
    expect(existsSync(globalPath)).toBe(false);
  });

  it('stops at the refused term: an entry before it already landed, the file holds only that one', async () => {
    await expect(
      runImport('foreign.txt', { format: 'text', cwd: tmp }, makeIO(), read(`Good: good\nZed: ${OVER}\nLater: later\n`)),
    ).rejects.toThrow(`term not added: aliases[0] (${SHOWN}): ${REFUSAL}`);

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms.map((t) => t.canonical)).toEqual(['Good']);
  });
});

describe('MCP apply_suggestion', () => {
  async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
    const server = createServer({ cwd: tmp });
    const client = new Client({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content?: { type: string; text?: string }[];
      };
      return { isError: result.isError === true, text: (result.content ?? []).map((c) => c.text ?? '').join('\n') };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it('refuses an over-limit alias on an existing term, a never word, and a new term\'s alias list, writing nothing', async () => {
    expect((await call('add_term', { canonical: 'Zed', aliases: ['zedd'] })).isError).toBe(false);
    const before = await fs.readFile(globalPath, 'utf8');

    const alias = await call('apply_suggestion', { suggestion: { kind: 'alias', canonical: 'Zed', alias: OVER } });
    expect(alias.isError).toBe(true);
    expect(alias.text).toBe(`term not added: aliases[0] (${SHOWN}): ${REFUSAL}. Nothing was written; fix that field and try again.`);

    const never = await call('apply_suggestion', { suggestion: { kind: 'never', canonical: 'Zed', alias: OVER } });
    expect(never.isError).toBe(true);
    expect(never.text).toBe(`term not added: never[0] (${SHOWN}): ${REFUSAL}. Nothing was written; fix that field and try again.`);

    const term = await call('apply_suggestion', { suggestion: { kind: 'term', canonical: 'Newterm', aliases: ['ok', OVER] } });
    expect(term.isError).toBe(true);
    expect(term.text).toBe(`term not added: aliases[1] (${SHOWN}): ${REFUSAL}. Nothing was written; fix that field and try again.`);

    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });
});

describe('lexicon edit re-parse of what the editor saved', () => {
  /** A $EDITOR that writes `content` into the file and exits 0, as a real one would. */
  const writes = (content: string): SpawnEditor => async (_command, _args, filePath) => {
    await fs.writeFile(filePath, content);
    return 0;
  };

  it('reports the over-limit alias by field path, leaves the file for a hand fix, and exits 1', async () => {
    const bad = `version: 1\nterms:\n  - canonical: Zed\n    aliases: [${OVER}]\n`;
    const io = makeIO();
    expect(await runEdit({ cwd: tmp, globalPath }, io, writes(bad), { EDITOR: 'fake' })).toBe(1);
    expect(io.err).toContain(`terms[0].aliases[0]: ${REFUSAL}`);
    expect(io.err).toContain(`your edits are still in ${globalPath}`);
    // runEdit never rewrites the file: what the editor saved is there to fix.
    expect(await fs.readFile(globalPath, 'utf8')).toBe(bad);

    // The fix the error prescribes: edit again, save a valid alias, the term loads.
    const fixed = `version: 1\nterms:\n  - canonical: Zed\n    aliases: [${OVER.slice(0, documentedLimit)}]\n`;
    const io2 = makeIO();
    expect(await runEdit({ cwd: tmp, globalPath }, io2, writes(fixed), { EDITOR: 'fake' })).toBe(0);
    expect(io2.out).toContain('ok: 1 term');
    expect((await readLexiconFile(globalPath, 'global')).lexicon.terms[0].aliases).toEqual([OVER.slice(0, documentedLimit)]);
  });
});

describe('the read-back check inside writeLexiconFile', () => {
  // The backstop for write paths that add no term of their own (a review's
  // edits, an in-place file update): the serialized bytes are re-parsed
  // before the atomic write, so an over-limit alias never reaches disk.
  it('refuses an over-limit alias as a whole-file error before the file is touched', async () => {
    await expect(
      writeLexiconFile({
        path: globalPath,
        scope: 'global',
        lexicon: { version: 1, terms: [{ canonical: 'Zed', aliases: [OVER] }] },
        exists: false,
      }),
    ).rejects.toThrow(`Refusing to write lexicon at ${globalPath}: Invalid lexicon:\n  - terms[0].aliases[0]: ${REFUSAL}`);
    expect(existsSync(globalPath)).toBe(false);
  });
});
