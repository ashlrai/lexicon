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

describe('HTML code elements', () => {
  it('skips a real <code> or <pre> element, attributes and any case included', () => {
    expect(out('<p>ashler is <code>ashler run</code></p>')).toBe('<p>Ashlr.AI is <code>ashler run</code></p>');
    expect(out('<pre class="sh">\nashler deploy\n</pre> then ashler')).toBe('<pre class="sh">\nashler deploy\n</pre> then Ashlr.AI');
    expect(out('<CODE>ashler</CODE> and <pre><code>ashler</code></pre> and ashler')).toBe(
      '<CODE>ashler</CODE> and <pre><code>ashler</code></pre> and Ashlr.AI',
    );
  });

  it('corrects escaped markup, which is text the page shows, not code', () => {
    expect(out('wrap &lt;code&gt;ashler&lt;/code&gt; here')).toBe('wrap &lt;code&gt;Ashlr.AI&lt;/code&gt; here');
    // ...unless the escaped sample itself sits inside a real code element.
    expect(out('<pre>&lt;code&gt;ashler&lt;/code&gt;</pre>')).toBe('<pre>&lt;code&gt;ashler&lt;/code&gt;</pre>');
  });

  it('treats an unclosed tag, or a longer tag name, as text', () => {
    expect(out('the <code> tag holds ashler')).toBe('the <code> tag holds Ashlr.AI');
    expect(out('<codex>ashler</codex> <code-block>ashler</code-block>')).toBe(
      '<codex>Ashlr.AI</codex> <code-block>Ashlr.AI</code-block>',
    );
  });

  it('finds HTML code elements in linear time', () => {
    const unclosed = '<code> ashler <pre> '.repeat(20000);
    const t0 = performance.now();
    collectRanges(unclosed);
    const closed = '<code>x</code> <pre> '.repeat(20000);
    collectRanges(closed);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
