/**
 * Shared types for the ambiguity engine. Ported from Pellucid
 * (apps/api/app/schemas.py) and kept dependency-free: every module in
 * src/ambiguity codes against these shapes.
 *
 * Pellucid is now part of lexicon. The port keeps Pellucid's finding model
 * (a typed, scored span with a rationale) and its detector/vote contracts so
 * the deterministic rule layer and any stage-2 detectors can share one
 * aggregation and calibration path. See docs/design/two-stage-correction.md.
 */

/** The four severity levels, in ascending order. */
export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * What kind of ambiguity a finding reports. `other` is the catch-all a
 * detector-specific type falls back to when it does not parse.
 */
export const FINDING_TYPES = [
  'vague_term',
  'passive_voice',
  'pronoun_antecedent',
  'quantifier',
  'and_or',
  'etcetera',
  'polysemy',
  'modifier_attachment',
  'untestable',
  'missing_acceptance',
  'hidden_assumption',
  'high_consequence',
  'garden_path',
  'negation_scope',
  'other',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

/** Source tag the deterministic rule layer stamps on its findings. */
export const SOURCE_RULES = 'rules';
/** Source tag the aggregator stamps on findings merged from >1 source. */
export const SOURCE_ENSEMBLE = 'ensemble';

/** A character offset range within the input text. */
export interface Span {
  start: number;
  end: number;
}

/**
 * A single ambiguity finding: a flagged span plus severity, rationale and a
 * pre-ensemble confidence in 0..1.
 */
export interface AmbiguityFinding extends Span {
  /** Verbatim slice `text[start:end]` as produced by the detector. */
  text: string;
  type: FindingType;
  severity: Severity;
  rationale: string;
  /** Detector-reported confidence, 0..1. The calibrator re-scores it. */
  confidence: number;
  /** Who flagged it: 'rules', a detector name, or 'ensemble' after a merge. */
  source: string;
  /** Optional suggested rewrite a detector attached. */
  suggestion?: string;
}

/**
 * One detector's contribution to the ensemble: its findings plus a short
 * read of the text and how sure it is of itself. Stage-2 model detectors
 * produce these through parseDetectorReport (./parse.ts).
 */
export interface DetectorReport {
  source: string;
  findings: AmbiguityFinding[];
  reasoning: string;
  /** Self-reported detector confidence, 0..1. */
  selfConfidence: number;
}

/**
 * One detector's AGREE/DISAGREE vote on another detector's finding, used by
 * the aggregator as a corroboration/dispute signal.
 */
export interface FindingVote {
  voter: string;
  /** Index into the target detector's findings list. */
  targetIndex: number;
  targetSource: string;
  agree: boolean;
  reasoning: string;
}

/**
 * The signal bundle the confidence calibrator scores. Mirrors the per-cluster
 * state the aggregator computes in aggregate.ts.
 */
export interface CalibrationInput {
  /** Confidence of the cluster's canonical (highest-severity) finding. */
  baseConfidence: number;
  /**
   * Additional distinct non-rule sources that flagged the span beyond the
   * canonical one. 0 = a single source, 3 = four sources agreed.
   */
  agentCorroboration: number;
  /** AGREE votes targeting any finding in the cluster. */
  clusterAgree: number;
  /** DISAGREE votes targeting any finding in the cluster. */
  clusterDisagree: number;
  /** The deterministic rule layer also flagged an overlapping span. */
  ruleCorroborated: boolean;
  /** Max severity in the cluster. */
  severity: Severity;
}

/**
 * The unit both stages of the correction pipeline emit and merge: a span of
 * the input worth changing (or at least flagging), an optional replacement,
 * and a confidence. Stage 1 (deterministic glossary + phonetic) and stage 2
 * (ambiguity scoring + small local model) both produce these; the ensemble
 * calibrator then merges candidates that overlap. Defined here so the
 * RQ-LEX-CONTEXT-NORMALIZE and RQ-LEX-STAGE2-LOCALMODEL work can consume one
 * shape. See docs/design/two-stage-correction.md.
 */
export interface CorrectionCandidate extends Span {
  /** Verbatim slice of the input this candidate refers to. */
  text: string;
  /** Proposed replacement. Absent = flag-only finding, no rewrite. */
  replacement?: string;
  /** Pre-ensemble confidence, 0..1. */
  confidence: number;
  /** Producer tag: 'glossary', 'phonetic', 'rules', 'model', ... */
  source: string;
  /** Optional human-readable reason, shown in review surfaces. */
  rationale?: string;
}
