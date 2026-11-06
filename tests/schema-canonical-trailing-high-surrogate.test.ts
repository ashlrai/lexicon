import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

// A canonical word whose high surrogate (U+D800 to U+DBFF) is the LAST code
// unit, so nothing follows it to pair with. [description, canonical, unit, name shown in the error]
const TRAILING: ReadonlyArray<readonly [string, string, string, string]> = [
  ['a high surrogate ending the word', 'Ashlr\uD800', 'U+D800', 'Ashlr\\uD800'],
  ['the last high surrogate ending the word', 'Ashlr\uDBFF', 'U+DBFF', 'Ashlr\\uDBFF'],
  ['a high surrogate after a valid pair', 'Rocket\u{1F680}\uD83D', 'U+D83D', 'Rocket\u{1F680}\\uD83D'],
  ['two unpaired units, naming the first', 'A\uD801B\uD802', 'U+D801', 'A\\uD801B\\uD802'],
];

const message = (unit: string, shown: string) => `must not contain ${unit} (${UNENCODABLE_NOTE}) in term "${shown}"`;

describe('unpaired trailing high surrogate in a canonical word', () => {
  it.each(TRAILING)('TermSchema rejects %s with one issue naming the code unit', (_d, canonical, unit, shown) => {
    const result = TermSchema.safeParse({ canonical });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the trailing high surrogate to be rejected');
    expect(result.error.issues.map(({ path, message: m }) => ({ path, message: m }))).toEqual([
      { path: ['canonical'], message: message(unit, shown) },
    ]);
  });

  it.each(TRAILING)('parseLexicon reports %s at terms[0].canonical', (_d, canonical, unit, shown) => {
    expect(() => parseLexicon({ terms: [{ canonical }] })).toThrow(
      `Invalid lexicon:\n  - terms[0].canonical: ${message(unit, shown)}`,
    );
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Ok' }, { canonical }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the trailing high surrogate to be rejected');
    expect(result.error.issues[0].path).toEqual(['terms', 1, 'canonical']);
  });

  it('accepts the same unit once a low surrogate completes the pair', () => {
    expect(TermSchema.parse({ canonical: 'Ashlr🚀' }).canonical).toBe('Ashlr\u{1F680}');
  });
});
