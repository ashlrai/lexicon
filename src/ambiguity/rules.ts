/**
 * Term-rule detector, ported from Pellucid (apps/api/app/detectors/rules.py).
 * Pure functions, no IO.
 *
 * Every term in terms.ts is compiled once to a boundary-aware regex: a match
 * must not start or end inside a word, hyphen or slash, so 'etc' hits the
 * standalone token but never 'etcetera' (which has its own rule) and 'fast'
 * never fires inside 'fasten'.
 */
import type { AmbiguityFinding, Severity } from './types.js';
import { QUANTIFIER_PHRASES, VAGUE_MODIFIERS, WEAK_VERBS } from './terms.js';
import { SOURCE_RULES } from './types.js';

interface CompiledRule {
  readonly pattern: RegExp;
  readonly type: AmbiguityFinding['type'];
  readonly severity: Severity;
  readonly rationale: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const COMPILED: readonly CompiledRule[] = [...VAGUE_MODIFIERS, ...WEAK_VERBS, ...QUANTIFIER_PHRASES].map(
  ([term, type, severity, rationale]) => ({
    pattern: new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(term)}(?![A-Za-z0-9_-])`, 'gi'),
    type,
    severity,
    rationale,
  }),
);

/** Base confidence a rule-layer finding carries for a given severity. */
export function severityToConfidence(severity: Severity): number {
  switch (severity) {
    case 'low':
      return 0.6;
    case 'medium':
      return 0.75;
    case 'high':
      return 0.85;
    case 'critical':
      return 0.95;
  }
}

/** Scan text for INCOSE vague terms, weak verbs and open-ended quantifiers. */
export function findTermFindings(text: string): AmbiguityFinding[] {
  const results: AmbiguityFinding[] = [];
  for (const { pattern, type, severity, rationale } of COMPILED) {
    pattern.lastIndex = 0;
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      results.push({
        start,
        end,
        text: text.slice(start, end),
        type,
        severity,
        rationale,
        confidence: severityToConfidence(severity),
        source: SOURCE_RULES,
      });
      // Guard against zero-width matches looping forever.
      if (m[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return results;
}
