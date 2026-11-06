/**
 * The ambiguity engine: deterministic ambiguity detection and calibrated
 * ensemble scoring, ported from Pellucid and adapted to the lexicon core's
 * style. Pellucid is now part of lexicon.
 *
 * Layers:
 *   terms.ts      the INCOSE-derived vague-term lexicon (data)
 *   rules.ts      term-rule matching over the lexicon data
 *   syntax.ts     passive-voice and dangling-pronoun detectors
 *   resolve.ts    trust-text-over-offsets span resolution for model output
 *   parse.ts      raw model JSON -> DetectorReport
 *   calibrate.ts  PAV isotonic confidence calibration
 *   aggregate.ts  overlap clustering and ensemble confidence
 *
 * Stage-1/stage-2 pipeline contract is in docs/design/two-stage-correction.md.
 */
import type { AmbiguityFinding } from './types.js';
import { findTermFindings } from './rules.js';
import { findDanglingPronouns, findPassiveVoice } from './syntax.js';

export * from './types.js';
export * from './terms.js';
export * from './rules.js';
export * from './syntax.js';
export * from './resolve.js';
export * from './parse.js';
export * from './calibrate.js';
export * from './aggregate.js';

/**
 * Run every rule-layer detector and dedupe overlapping spans of the same
 * type - the deterministic half of the ambiguity engine. Ported from
 * Pellucid's run_rule_layer; the database-backed custom-rule hook has no
 * equivalent here (lexicon terms come from the lexicon, not detector rules).
 */
export function runRuleLayer(text: string): AmbiguityFinding[] {
  const findings = [
    ...findTermFindings(text),
    ...findPassiveVoice(text),
    ...findDanglingPronouns(text),
  ];
  return dedupeFindings(findings);
}

/**
 * Drop exact duplicates (same span + same type), preferring higher
 * confidence, and return a stable order by span. Port of _dedupe.
 */
export function dedupeFindings(findings: readonly AmbiguityFinding[]): AmbiguityFinding[] {
  const seen = new Map<string, AmbiguityFinding>();
  for (const f of findings) {
    const key = `${f.start}:${f.end}:${f.type}`;
    const existing = seen.get(key);
    if (!existing || f.confidence > existing.confidence) seen.set(key, f);
  }
  return [...seen.values()].sort(
    (a, b) => a.start - b.start || a.end - b.end || (a.type < b.type ? -1 : a.type > b.type ? 1 : 0),
  );
}
