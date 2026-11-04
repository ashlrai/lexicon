/**
 * An overlength `notes` field: not the +1 boundary probe of
 * schema-notes-text-limit.test.ts but a value plainly past docs/CONTRACT.md's
 * `text` limit (200 characters), the shape the cap exists to stop. A hand
 * editor pastes a paragraph, a harvested note grows with every run, a hostile
 * repository ships a notes field carrying kilobytes of text into model
 * context. Pinned here: a notes several times the limit is refused through
 * every schema surface with the documented message, the schema rejects rather
 * than truncates (a legal 200-character prefix saves nothing), the thrown
 * error names the field path and never echoes the oversized content, every
 * overlength notes in a file is reported, and cleaning the value first does
 * not rescue a note that stays over the limit.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LIMITS, LexiconSchema, TermSchema, parseLexicon } from '../src/core/schema.js';

const ZW = '\u200b'; // a zero-width space: stripped before the limit is measured

const contract = readFileSync(new URL('../docs/CONTRACT.md', import.meta.url), 'utf8');

describe('an overlength notes value', () => {
  const schemaSection = contract.split('## src/core/schema.ts\n')[1]?.split('\n## ')[0];
  const match = schemaSection?.match(/`text` (\d+) \(notes, phonetic\)/);

  it('takes the limit from the contract: 200 characters', () => {
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(200);
    expect(LIMITS.text).toBe(200);
  });

  it.each([
    ['TermSchema', TermSchema, (term: object) => term, ['notes']],
    ['LexiconSchema', LexiconSchema, (term: object) => ({ terms: [term] }), ['terms', 0, 'notes']],
  ] as const)('refuses a notes several times the limit through %s', (_name, schema, wrap, path) => {
    const limit = Number(match![1]);
    const overlength = 'n'.repeat(limit * 3);

    const result = schema.safeParse(wrap({ canonical: 'X', notes: overlength }));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected an overlength notes field to be rejected');
    expect(result.error.issues).toMatchObject([
      { code: 'too_big', path, maximum: limit, message: `must be at most ${limit} characters` },
    ]);
  });

  it('rejects rather than truncates: a legal 200-character prefix saves nothing', () => {
    const limit = Number(match![1]);
    const atLimit = 'n'.repeat(limit);
    const overlength = `${atLimit} and the sentence that keeps going past the end of the field`;

    // The value at the limit parses verbatim; the same value with more text
    // after it throws. No parse path clips the tail and returns a 200-char note.
    expect(parseLexicon({ terms: [{ canonical: 'X', notes: atLimit }] }).terms[0].notes).toBe(atLimit);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: overlength }] })).toThrow(
      `terms[0].notes: must be at most ${limit} characters`,
    );
  });

  it('keeps the error bounded: the oversized content is never echoed', () => {
    const limit = Number(match![1]);
    const overlength = `preamble ${'x'.repeat(limit * 25)}`;
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: 'X', notes: overlength }] });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain(`terms[0].notes: must be at most ${limit} characters`);
    expect(message).not.toContain('x'.repeat(limit + 1));
    expect(message.length).toBeLessThan(overlength.length);
  });

  it('names every overlength notes in the file, not just the first', () => {
    const limit = Number(match![1]);
    const overlength = 'n'.repeat(limit * 2);
    const raw = {
      terms: [
        { canonical: 'First', notes: overlength },
        { canonical: 'Within', notes: 'a fine note' },
        { canonical: 'Third', notes: overlength },
      ],
    };

    const result = LexiconSchema.safeParse(raw);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the overlength notes fields to be rejected');
    expect(result.error.issues).toHaveLength(2);
    expect(result.error.issues.map((issue) => issue.path)).toEqual([
      ['terms', 0, 'notes'],
      ['terms', 2, 'notes'],
    ]);
    expect(() => parseLexicon(raw)).toThrow(/terms\[0\]\.notes[\s\S]*terms\[2\]\.notes/);
  });

  it('still refuses a notes that stays over the limit once invisible characters are stripped', () => {
    const limit = Number(match![1]);
    // 300 raw code units, 220 after every zero-width space is gone: still over.
    const raw = `${'n'.repeat(100)}${ZW.repeat(80)}${'n'.repeat(120)}`;
    expect(Array.from(raw)).toHaveLength(300);

    expect(() => parseLexicon({ terms: [{ canonical: 'X', notes: raw }] })).toThrow(
      `terms[0].notes: must be at most ${limit} characters`,
    );
  });

  it('refuses a hand-edited YAML term whose notes scalar is well over the limit', () => {
    const limit = Number(match![1]);
    const overlength = 'n'.repeat(limit * 4);
    const doc = ['version: 1', 'terms:', '  - canonical: Boundary Co', `    notes: ${overlength}`, ''].join('\n');

    expect(() => parseLexicon(parseYaml(doc))).toThrow(`terms[0].notes: must be at most ${limit} characters`);
  });

  it('accepts a hand-edited YAML note at the 200-code-point boundary without truncation', () => {
    const notes = `${'context '.repeat(24)}note 🚀!!`;
    expect(Array.from(notes)).toHaveLength(200);
    const doc = `terms:\n  - canonical: Boundary Co\n    notes: "${notes}"\n`;

    expect(parseLexicon(parseYaml(doc)).terms[0].notes).toBe(notes);
    expect(() => parseLexicon(parseYaml(doc.replace('🚀!!', '🚀!!!')))).toThrow(
      'terms[0].notes: must be at most 200 characters',
    );
  });
});
