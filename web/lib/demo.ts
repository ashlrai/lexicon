/**
 * The one place that touches the generated demo bundle.
 *
 * `lib/generated/lexicon-core.js` is the project's real `src/core` matcher,
 * bundled for the browser by `scripts/build-demo-bundle.mjs`. It is loaded on
 * demand so the 41 KB of matcher, phonetic index and stoplist never sits in the
 * critical path -- nothing here runs until a visitor reaches the demo.
 *
 * Everything below runs in the browser. No transcript a visitor types is sent
 * anywhere; there is no endpoint to send it to.
 */
import type { Lexicon, NormalizeResult, Term } from './generated/lexicon-core';

export type { Lexicon, NormalizeResult, Term };
export type Replacement = NormalizeResult['replacements'][number];

export type Core = {
  normalize: (text: string, lexicon: Lexicon) => NormalizeResult;
  suggestAliases: (canonical: string) => string[];
  minConfidence: number;
  lexicon: Lexicon;
  packs: { id: string; title: string; count: number }[];
  packTotal: number;
};

let pending: Promise<Core> | undefined;

export function loadCore(): Promise<Core> {
  pending ??= (async () => {
    const [core, data] = await Promise.all([
      import('./generated/lexicon-core.js'),
      import('./generated/demo-lexicon.json'),
    ]);
    const demo = (data as { default?: unknown }).default ?? data;
    const { lexicon, packs, packTotal } = demo as {
      lexicon: Lexicon;
      packs: Core['packs'];
      packTotal: number;
    };
    return {
      normalize: core.normalize,
      suggestAliases: core.suggestAliases,
      minConfidence: core.DEFAULT_MIN_CONFIDENCE,
      lexicon,
      packs,
      packTotal,
    };
  })();
  return pending;
}

/**
 * Split `result.output` into plain runs and replaced runs so the corrected text
 * can carry the same marks the hero uses. `normalize()` returns offsets into
 * the INPUT, so the output offsets are accumulated as we walk left to right.
 */
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'fix'; text: string; replacement: Replacement };

export function segment(result: NormalizeResult): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const r of result.replacements) {
    if (r.start > cursor) out.push({ kind: 'text', text: result.input.slice(cursor, r.start) });
    out.push({ kind: 'fix', text: r.replacement, replacement: r });
    cursor = r.end;
  }
  if (cursor < result.input.length) out.push({ kind: 'text', text: result.input.slice(cursor) });
  return out;
}

/**
 * Build a Term from what someone typed into "try your own name". Kept here
 * rather than using the project's zod schema because pulling `schema.js` into
 * the browser would add 445 KB for one object literal.
 */
export function makeTerm(canonical: string, aliases: string[]): Term {
  return {
    canonical: canonical.trim(),
    aliases: aliases.map((a) => a.trim()).filter(Boolean),
    category: 'brand',
  };
}

export function addTerm(lexicon: Lexicon, term: Term): Lexicon {
  return {
    ...lexicon,
    terms: [term, ...lexicon.terms.filter((t) => t.canonical !== term.canonical)],
  };
}
