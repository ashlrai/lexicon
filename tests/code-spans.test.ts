import { describe, expect, it } from 'vitest';
import { normalize } from '../src/core/normalize.js';
import { collectRanges } from '../src/core/matcher/tokenize.js';
import type { Lexicon } from '../src/core/types.js';

const LEX: Lexicon = {
  version: 1,
  terms: [{ canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar'] }],
};

const out = (text: string): string => normalize(text, LEX).output;

describe('code the matcher leaves alone', () => {
  it('skips a tilde fence, the other fenced code block', () => {
    expect(out('~~~\nashler deploy\n~~~\nand ashler')).toBe('~~~\nashler deploy\n~~~\nand Ashlr.AI');
    expect(out('Run this:\n\n  ~~~sh\n  ashler run\n  ~~~\n')).toBe('Run this:\n\n  ~~~sh\n  ashler run\n  ~~~\n');
  });

  it('runs an unclosed tilde fence to the end, as an unclosed backtick fence does', () => {
    expect(out('ashler said:\n~~~\nashler run')).toBe('Ashlr.AI said:\n~~~\nashler run');
  });

  it('does not treat tildes inside a line as a fence', () => {
    expect(out('about ~~~ ashler ~~~ here')).toBe('about ~~~ Ashlr.AI ~~~ here');
  });

  it('skips a code span opened by two or more backticks', () => {
    expect(out('try ``ashler `x` run`` then ashler')).toBe('try ``ashler `x` run`` then Ashlr.AI');
    expect(out('```ashler``` and ashler')).toBe('```ashler``` and Ashlr.AI');
  });

  it('pairs backtick runs only with a run of the same length', () => {
    // The single backtick in the middle neither opens nor closes the double span.
    expect(out('``a ` ashler`` ashler')).toBe('``a ` ashler`` Ashlr.AI');
    // An unmatched run is literal text; the single-backtick span after it still counts.
    expect(out('`` stray, ashler and `ashler`')).toBe('`` stray, Ashlr.AI and `ashler`');
  });

  it('keeps a code span on one line, as before', () => {
    expect(out('``ashler\nashler``')).toBe('``Ashlr.AI\nAshlr.AI``');
  });

  it('finds backtick spans in linear time', () => {
    // Many unmatched runs of different lengths on one line.
    const line = Array.from({ length: 4000 }, (_, i) => '`'.repeat((i % 50) + 1) + ' x ').join('');
    const t0 = performance.now();
    collectRanges(line);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
