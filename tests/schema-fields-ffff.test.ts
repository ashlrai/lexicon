import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLexiconFile } from '../src/core/store.js';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFF (${UNENCODABLE_NOTE})`;

// U+FFFF is a Unicode noncharacter: no lexicon file can carry it, so any
// free-text field holding one is refused and the message names the code point.
const WORDS: ReadonlyArray<readonly [string, string]> = [
  ['in the middle', 'Ash￿lr'],
  ['at the start', '￿Ashlr'],
  ['at the end', 'Ashlr￿'],
  ['alone', '￿'],
  ['after a valid surrogate pair', 'Rocket \u{1F680}￿'],
];

describe('U+FFFF in a term', () => {
  it.each(WORDS)('findUnencodableChar reports U+FFFF %s', (_label, word) => {
    expect(findUnencodableChar(word)).toBe('U+FFFF');
  });

  it.each(WORDS)('TermSchema rejects U+FFFF %s at the canonical path', (_label, canonical) => {
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it.each(WORDS)('LexiconSchema rejects U+FFFF %s and points at the term', (_label, canonical) => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Valid' }, { canonical }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(['terms', 1, 'canonical']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('rejects U+FFFF in an alias at its index', () => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ash￿lar'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues[0]?.path).toEqual(['aliases', 1]);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('rejects U+FFFF in notes', () => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', notes: 'brand￿' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues[0]?.path).toEqual(['notes']);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('parseLexicon throws an error that lists the path and the code point', () => {
    expect(() => parseLexicon({ terms: [{ canonical: 'Ash￿lr' }] })).toThrow(
      `terms[0].canonical: ${reason}`,
    );
  });

  it('accepts the neighbouring code points U+FFFD and U+FFFC', () => {
    expect(TermSchema.safeParse({ canonical: 'Ash�lr￼' }).success).toBe(true);
  });

  // docs/CONTRACT.md: every free-text field is refused, and a term's fields name the term
  // (the canonical with U+FFFF written \uFFFF) after the reason.
  it.each(['aliases', 'never'] as const)('rejects U+FFFF in %s and names the term as the contract says', (field) => {
    const result = TermSchema.safeParse({ canonical: 'Ash￿lr', [field]: ['ok', 'b￿d'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    const issue = result.error.issues.find((i) => i.path[0] === field);
    expect(issue?.path).toEqual([field, 1]);
    expect(issue?.message).toBe(`${reason} in term "Ash\\uFFFFlr"`);
  });

  it.each(['phonetic', 'notes', 'createdAt'] as const)('rejects U+FFFF in %s', (field) => {
    const result = TermSchema.safeParse({ canonical: 'Ashlr.AI', [field]: 'x￿' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues[0]?.path).toEqual([field]);
    expect(result.error.issues[0]?.message).toBe(`${reason} in term "Ashlr.AI"`);
  });

  it.each(['protectedWords', 'packs'] as const)('rejects U+FFFF in settings %s', (field) => {
    const result = LexiconSchema.safeParse({ terms: [], settings: { [field]: ['fine', 'b￿d'] } });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    expect(result.error.issues[0]?.path).toEqual(['settings', field, 1]);
    expect(result.error.issues[0]?.message).toContain(reason);
  });

  it('cuts a long term name to 40 characters in the message', () => {
    const result = TermSchema.safeParse({ canonical: `${'a'.repeat(50)}￿`, notes: 'x￿' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    const shown = result.error.issues.find((i) => i.path[0] === 'notes')?.message.split(' in term ')[1];
    expect(shown).toBe(`"${'a'.repeat(39)}\u2026"`);
  });
});

// A YAML double-quoted "\uFFFF" escape is the only way a file can hold the
// unit; reading such a file must fail with a diagnostic that says U+FFFF.
describe('U+FFFF in a lexicon file on disk', () => {
  it('readLexiconFile rejects a YAML \\uFFFF escape and the message identifies U+FFFF', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-ffff-file-'));
    try {
      const file = path.join(dir, 'lexicon.yaml');
      await fs.writeFile(file, 'terms:\n  - canonical: Ashlr.AI\n    aliases: ["Ash\\uFFFFler"]\n');
      const err = await readLexiconFile(file, 'global').catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : '';
      expect(message).toContain('U+FFFF');
      expect(message).toContain('aliases[0]');
      expect(message).not.toContain('\uFFFF');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
