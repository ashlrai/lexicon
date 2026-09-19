/**
 * normalize(): run the matcher over a transcript and splice canonical spellings in.
 * Pure; the index is rebuilt per call (cheap, and the lexicon file may change
 * between hook invocations).
 */
import { buildIndex, findReplacements } from './matcher.js';
import type { Lexicon, NormalizeOptions, NormalizeResult } from './types.js';

export function normalize(text: string, lexicon: Lexicon, opts: NormalizeOptions = {}): NormalizeResult {
  const index = buildIndex(lexicon);
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
