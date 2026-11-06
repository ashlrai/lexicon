/**
 * Span resolution for model-produced findings, ported from Pellucid
 * (apps/api/app/agents/base.py). Pure functions, no IO.
 *
 * The load-bearing insight from production: LLMs reliably reproduce the
 * verbatim text they are flagging but routinely hallucinate character
 * offsets - they guess at index arithmetic rather than measuring. So we
 * trust the text and recover the span by searching the document, biased
 * toward the model's claimed start. When the literal appears more than once
 * and the hint cannot decisively pick one occurrence, the finding is refused:
 * silently anchoring to the wrong occurrence is worse than dropping it.
 */
import type { Span } from './types.js';

/**
 * Characters stripped from both ends of a model-returned literal: whitespace
 * plus markdown bullets, markers and quotes a model wraps around its target.
 * Internal punctuation and apostrophes survive ("don't", "user-friendly") -
 * the trimmed result must still appear verbatim in the document, so a wrong
 * trim causes a drop, not a corruption.
 */
const LEAD_TRAIL = ' \t\n\r-*#•·>‣◦"\'`';

/** Strip LEAD_TRAIL characters from both ends of `text`. */
export function cleanLiteral(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && LEAD_TRAIL.includes(text[start])) start += 1;
  while (end > start && LEAD_TRAIL.includes(text[end - 1])) end -= 1;
  return text.slice(start, end).trim();
}

/**
 * A model hint within this distance of the nearest occurrence is considered
 * aimed at it, provided the next-nearest occurrence is decisively farther.
 */
const NEAR_HINT = 80;
/** Required gap between nearest and runner-up occurrence distances. */
const CLEAR_MARGIN = 200;

/**
 * Find `literal` in `documentText`, biased toward the model's hint.
 *
 * Returns the resolved span, or undefined when the literal is absent or the
 * occurrence cannot be picked unambiguously: with several occurrences the
 * hint must land within NEAR_HINT of the nearest and CLEAR_MARGIN closer
 * than the runner-up. Dropping ambiguous findings is the safer trade - a
 * downstream apply that trusts document[start:end] === text would pass
 * trivially on the wrong occurrence and corrupt the document.
 */
export function resolveSpan(
  documentText: string,
  literal: string,
  hintStart: number,
): Span | undefined {
  if (!literal) return undefined;
  const occurrences: number[] = [];
  let cursor = 0;
  for (;;) {
    const idx = documentText.indexOf(literal, cursor);
    if (idx === -1) break;
    occurrences.push(idx);
    cursor = idx + 1;
  }
  if (occurrences.length === 0) return undefined;
  if (occurrences.length === 1) {
    const chosen = occurrences[0];
    return { start: chosen, end: chosen + literal.length };
  }

  if (!(hintStart >= 0 && hintStart < documentText.length)) return undefined;
  const byDistance = [...occurrences].sort(
    (a, b) => Math.abs(a - hintStart) - Math.abs(b - hintStart),
  );
  const nearestDist = Math.abs(byDistance[0] - hintStart);
  const runnerUpDist = Math.abs(byDistance[1] - hintStart);
  if (nearestDist > NEAR_HINT || runnerUpDist - nearestDist < CLEAR_MARGIN) {
    return undefined;
  }
  return { start: byDistance[0], end: byDistance[0] + literal.length };
}
