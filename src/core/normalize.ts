/**
 * normalize(): run the matcher over a transcript and splice canonical spellings in.
 * Pure; the index is rebuilt per call (the lexicon file may change between
 * calls). A caller that already holds the index for this lexicon (the prompt
 * hook keeps one on disk, see loadMatcherIndex) passes it to
 * normalizeWithIndex instead.
 */
import { buildIndex, findReplacements } from './matcher.js';
import type { MatcherIndex } from './matcher.js';
import type { Lexicon, NormalizeIncomplete, NormalizeOptions, NormalizeResult } from './types.js';

export function normalize(text: string, lexicon: Lexicon, opts: NormalizeOptions = {}): NormalizeResult {
  return normalizeWithIndex(text, buildIndex(lexicon), opts);
}

/** normalize() against a prebuilt index; `index.lexicon` is the lexicon it matches. */
export function normalizeWithIndex(text: string, index: MatcherIndex, opts: NormalizeOptions = {}): NormalizeResult {
  const replacements = findReplacements(text, index, opts);

  if (opts.dryRun || replacements.length === 0) {
    return { input: text, output: text, replacements, changed: false };
  }

  // Apply right-to-left so earlier offsets stay valid while splicing.
  let output = text;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const r = replacements[i];
    output = output.slice(0, r.start) + r.replacement + output.slice(r.end);
  }

  return { input: text, output, replacements, changed: output !== text };
}

/** One line per replacement: `"Ashler" -> "Ashlr.AI" (alias, 1.00)`, or "No changes." */
export function diffSummary(result: NormalizeResult): string {
  if (result.replacements.length === 0) return 'No changes.';
  return result.replacements
    .map((r) => `"${r.original}" -> "${r.replacement}" (${r.reason}, ${r.confidence.toFixed(2)})`)
    .join('\n');
}

/**
 * The `incomplete` field for a normalize whose `shouldStop` budget of
 * `budgetMs` ran out before the end of a `totalChars`-long text.
 */
export function timeBudgetIncomplete(totalChars: number, budgetMs: number): NormalizeIncomplete {
  return {
    reasons: ['time'],
    totalChars,
    note:
      `Matching stopped at the ${budgetMs} ms budget; later text may still hold uncorrected names. ` +
      'Normalize the rest again, in smaller pieces, if it matters.',
  };
}
