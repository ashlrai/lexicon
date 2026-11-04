import { describe, expect, it } from 'vitest';
import { TermSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

// An unpaired LOW surrogate (U+DC00..U+DFFF): one with no high surrogate in
// front of it. The diagnostic must write it as a literal `\uXXXX`, never raw.
const LOW: ReadonlyArray<readonly [string, string, string, string]> = [
  ['the first low surrogate', 'Ro\uDC00cket', 'U+DC00', 'Ro\\uDC00cket'],
  ['the last low surrogate', 'Ro\uDFFFcket', 'U+DFFF', 'Ro\\uDFFFcket'],
  ['a trailing low surrogate', 'Rocket\uDD00', 'U+DD00', 'Rocket\\uDD00'],
  ['a low surrogate after a valid pair', '\u{1F680}\uDC00', 'U+DC00', '\u{1F680}\\uDC00'],
  ['a low surrogate after a lone high one', '\uD800x\uDC00', 'U+D800', '\\uD800x\\uDC00'],
];

describe('unpaired low surrogate in a diagnostic', () => {
  it.each(LOW)('canonical: %s is written as a \\uXXXX escape', (_d, canonical, unit, shown) => {
    const result = TermSchema.safeParse({ canonical });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `must not contain ${unit} (${UNENCODABLE_NOTE}) in term "${shown}"` },
    ]);
  });

  it.each(['aliases', 'never'] as const)('%s entry is reported at its index', (field) => {
    const result = TermSchema.safeParse({ canonical: 'Rocket', [field]: ['fine', 'bad\uDC01'] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues[0].path).toEqual([field, 1]);
    expect(result.error.issues[0].message).toBe(`must not contain U+DC01 (${UNENCODABLE_NOTE}) in term "Rocket"`);
  });

  it.each(['notes', 'phonetic'] as const)('%s text is reported with the escape', (field) => {
    const result = TermSchema.safeParse({ canonical: 'Rocket', [field]: 'x\uDEAD' });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    expect(result.error.issues[0].path).toEqual([field]);
    expect(result.error.issues[0].message).toContain('U+DEAD');
  });

  it('parseLexicon message holds the literal backslash escape and no raw surrogate', () => {
    let message = '';
    try {
      parseLexicon({ terms: [{ canonical: 'Ro\uDC00cket' }] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('in term "Ro\\uDC00cket"');
    expect(message).not.toMatch(/[\uD800-\uDFFF]/);
  });
});
