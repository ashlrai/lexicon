import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { TermSchema, parseLexicon } from '../src/core/schema.js';

describe('a supplementary character in notes', () => {
  const notes = 'launch 🚀 and 𠀋 at 􏿿';

  it('is accepted and preserved exactly', () => {
    const lexicon = parseLexicon({ terms: [{ canonical: 'Rocket', notes }] });
    expect(lexicon.terms[0].notes).toBe(notes);
    expect([...lexicon.terms[0].notes!]).toHaveLength([...notes].length);
  });

  it('survives a YAML write and read', () => {
    const first = parseLexicon({ terms: [{ canonical: 'Rocket', notes }] });
    const second = parseLexicon(parse(stringify(first)));
    expect(second.terms[0].notes).toBe(notes);
  });

  it('accepts a high surrogate followed by its low surrogate written as escapes', () => {
    const pair = '\uD83D\uDE80';
    const result = TermSchema.safeParse({ canonical: 'Rocket', notes: `go ${pair}` });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.notes).toBe('go 🚀');
  });
});
