// Wall-clock bound on the paragraph-wide quote anchor. It lives in its own
// file so vitest.config.ts can run it in the `perf` project: one forked
// worker, after every other file has finished, so no other suite competes for
// the CPU while it is timed.
import { describe, expect, it } from 'vitest';
import { declineCollapsedMentions } from '../src/core/matcher/enumeration.js';

/**
 * The paragraph-wide quote anchor is answered from one fold of each paragraph.
 * Recomputing the paragraph for every quoted mention (walking back to the blank
 * line and folding the whole paragraph each time) made a long paragraph of
 * quoted aliases quadratic: 32k quoted mentions in one paragraph took minutes.
 */
function quotedParagraph(n: number, lead: string): { text: string; spans: Array<{ start: number; end: number; original: string; replacement: string }> } {
  let text = lead;
  const spans = [];
  for (let i = 0; i < n; i++) {
    text += 'x "';
    spans.push({ start: text.length, end: text.length + 6, original: 'Ashler', replacement: 'Ashlr.AI' });
    text += 'Ashler" y. ';
  }
  return { text, spans };
}

function bestOf(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe('declineCollapsedMentions: paragraph-wide quote anchor', () => {
  it('declines quoted aliases when the canonical opens the paragraph, and keeps them when it is in another paragraph', () => {
    const anchored = quotedParagraph(50, 'Ashlr.AI ships. Something else entirely. ');
    expect(declineCollapsedMentions(anchored.text, anchored.spans)).toHaveLength(0);
    const elsewhere = quotedParagraph(50, 'Ashlr.AI ships.\n\nSomething else entirely. ');
    expect(declineCollapsedMentions(elsewhere.text, elsewhere.spans)).toHaveLength(50);
  });

  it('stays near-linear in the number of quoted mentions in one paragraph', () => {
    const small = quotedParagraph(4000, 'Something else entirely. ');
    const large = quotedParagraph(16000, 'Something else entirely. ');
    declineCollapsedMentions(small.text, small.spans); // warm-up
    declineCollapsedMentions(large.text, large.spans); // warm-up
    const tSmall = bestOf(() => declineCollapsedMentions(small.text, small.spans));
    const tLarge = bestOf(() => declineCollapsedMentions(large.text, large.spans));
    // 4x the input: linear is ~4x, the quadratic it replaces was ~16x.
    expect(tLarge).toBeLessThan(Math.max(tSmall * 9, 50));
  }, 60_000);
});
