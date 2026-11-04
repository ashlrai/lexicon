import { describe, expect, it } from 'vitest';
import { LexiconSchema, TermSchema, UNENCODABLE_NOTE, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFF (${UNENCODABLE_NOTE})`;
const RAW = '￿';

// A rejected canonical word names the offending code unit as text (U+FFFF in
// the reason, ￿ in the quoted term) and never echoes the raw character.
describe('U+FFFF diagnostic escaping in a canonical word', () => {
  it.each([
    ['middle', `Ash${RAW}lr`, 'Ash\\uFFFFlr'],
    ['start', `${RAW}Ashlr`, '\\uFFFFAshlr'],
    ['end', `Ashlr${RAW}`, 'Ashlr\\uFFFF'],
    ['alone', RAW, '\\uFFFF'],
    ['repeated', `a${RAW}${RAW}b`, 'a\\uFFFF\\uFFFFb'],
    ['next to an emoji', `\u{1F680}${RAW}`, '\u{1F680}\\uFFFF'],
  ])('TermSchema escapes U+FFFF at the %s', (_where, canonical, shown) => {
    const result = TermSchema.safeParse({ canonical });
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    const message = result.error.issues[0]?.message ?? '';
    expect(message).toContain(reason);
    expect(message).toContain(`in term "${shown}"`);
    expect(message).not.toContain(RAW);
  });

  it('parseLexicon throws without the raw code unit anywhere in the message', () => {
    let thrown: unknown;
    try {
      parseLexicon({ terms: [{ canonical: `Ash${RAW}lr` }] });
    } catch (e) {
      thrown = e;
    }
    const text = thrown instanceof Error ? thrown.message : '';
    expect(text).toContain(`terms[0].canonical: ${reason}`);
    expect(text).not.toContain(RAW);
  });

  it('LexiconSchema issues carry no raw U+FFFF in any message', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: `x${RAW}` }] });
    if (result.success) throw new Error('Expected U+FFFF to be rejected');
    for (const issue of result.error.issues) expect(issue.message).not.toContain(RAW);
  });
});
