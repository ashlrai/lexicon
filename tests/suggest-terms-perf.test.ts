// Wall-clock bound on suggestTerms over a large history. It lives in its own
// file so vitest.config.ts can run it in the `perf` project: one forked worker,
// after every other file has finished, so no other suite competes for the CPU
// while it is timed. Inside tests/suggest-terms.test.ts it ran alongside every
// other file and missed the 100 ms bound under load without any regression.
import { describe, expect, it } from 'vitest';
import { normalize } from '../src/core/normalize.js';
import { suggestTerms } from '../src/core/suggestTerms.js';
import type { SuggestInput, VoiceHistoryEntry } from '../src/core/suggestTerms.js';
import type { Lexicon, LoadedLexicon, Term } from '../src/core/types.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const OLD = new Date(NOW - 90 * DAY).toISOString();

function load(lexicon: Lexicon): LoadedLexicon {
  return { merged: lexicon, global: { path: '/tmp/lexicon-suggest-perf/lexicon.yaml', scope: 'global', lexicon, exists: true } };
}

/** A history entry; `output` defaults to `raw` (nothing was corrected when it was recorded). */
function entry(raw: string, output = raw): VoiceHistoryEntry {
  return { at: '2026-09-10T00:00:00.000Z', raw, output, model: 'base.en', ms: { record: 1, transcribe: 2, normalize: 3 } };
}

describe('suggestTerms: performance', () => {
  it('handles 1000 history lines and 200 terms in under 100 ms', async () => {
    const terms: Term[] = [];
    for (let i = 0; i < 200; i++) {
      terms.push({ canonical: `Brand${i}corp`, aliases: [`brand ${i} corp`, `brandcorp${i}`], hits: i % 3, createdAt: OLD });
    }
    const lexicon: Lexicon = { version: 1, terms };
    const vocabulary =
      'please deploy the new build to versal tonight and ping ashlur about the process which lacks locks then talk to Siobhan Reilly before the standup so we can ship the release notes and update the changelog for brand7corp customers'.split(' ');
    const history: VoiceHistoryEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      const n = 6 + (i % 14);
      const words: string[] = [];
      for (let j = 0; j < n; j++) words.push(vocabulary[(i * 7 + j * 3) % vocabulary.length]);
      const raw = words.join(' ');
      // Every third line was corrected when it was recorded.
      history.push(entry(raw, i % 3 === 0 ? normalize(raw, lexicon).output : raw));
    }
    const input: SuggestInput = { loaded: load(lexicon), history, now: NOW };
    await suggestTerms(input); // warm up the JIT once, as a long-running MCP server would be
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const t0 = performance.now();
      const out = await suggestTerms(input);
      best = Math.min(best, performance.now() - t0);
      expect(out.length).toBeGreaterThan(0);
    }
    expect(best).toBeLessThan(100);
  });
});
