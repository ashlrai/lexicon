/**
 * INCOSE-derived vague-term lexicon, ported verbatim from Pellucid
 * (apps/api/app/detectors/rules.py). Curated from the INCOSE Guide to
 * Writing Requirements: vague modifiers, weak verbs, escape clauses and
 * ambiguous quantifiers.
 */
import type { FindingType, Severity } from './types.js';

/** (term, finding type, severity, rationale) - one compiled rule per row. */
export type TermRule = readonly [term: string, type: FindingType, severity: Severity, rationale: string];

export const VAGUE_MODIFIERS: readonly TermRule[] = [
  ['user-friendly', 'vague_term', 'high', 'Subjective and untestable - define concrete usability criteria.'],
  ['user friendly', 'vague_term', 'high', 'Subjective and untestable - define concrete usability criteria.'],
  ['efficient', 'vague_term', 'medium', 'Quantify: efficient relative to what target?'],
  ['efficiently', 'vague_term', 'medium', 'Quantify: efficient relative to what target?'],
  ['optimal', 'vague_term', 'medium', 'Optimization criterion is undefined.'],
  ['optimally', 'vague_term', 'medium', 'Optimization criterion is undefined.'],
  ['optimize', 'vague_term', 'medium', 'Specify the optimization objective and constraints.'],
  ['minimize', 'vague_term', 'medium', 'Specify a target value or upper bound rather than a directive.'],
  ['maximize', 'vague_term', 'medium', 'Specify a target value or lower bound rather than a directive.'],
  ['fast', 'vague_term', 'high', 'Define a concrete latency or throughput target.'],
  ['quickly', 'vague_term', 'high', 'Define a concrete latency target.'],
  ['slow', 'vague_term', 'medium', 'Slow relative to what threshold?'],
  ['robust', 'vague_term', 'high', 'Robust against what failure modes? Quantify the tolerance.'],
  ['reliable', 'vague_term', 'high', 'Specify availability target (e.g. 99.9%).'],
  ['scalable', 'vague_term', 'medium', 'Define the scaling dimension and target load.'],
  ['flexible', 'vague_term', 'medium', 'Flexible along which axis? Specify the variation supported.'],
  ['intuitive', 'vague_term', 'high', 'Subjective - replace with measurable usability criteria.'],
  ['seamless', 'vague_term', 'high', 'Marketing language - describe the concrete behavior.'],
  ['modern', 'vague_term', 'high', 'Modern compared to what baseline? Specify the technology constraint.'],
  ['appropriate', 'vague_term', 'high', 'Appropriate per what criterion? Define the rule.'],
  ['appropriately', 'vague_term', 'high', 'Appropriate per what criterion? Define the rule.'],
  ['reasonable', 'vague_term', 'high', 'Reasonable per what criterion? Define a measurable threshold.'],
  ['reasonably', 'vague_term', 'high', 'Reasonable per what criterion? Define a measurable threshold.'],
  ['adequate', 'vague_term', 'high', 'Adequate by what measure? Specify the threshold.'],
  ['sufficient', 'vague_term', 'high', 'Sufficient relative to what target? Specify.'],
  ['various', 'vague_term', 'medium', 'Enumerate the variations supported.'],
  ['several', 'vague_term', 'medium', 'Specify the exact count or range.'],
  ['many', 'vague_term', 'medium', 'Specify the count threshold.'],
  ['most', 'vague_term', 'medium', 'Specify the percentage threshold.'],
  ['some', 'vague_term', 'medium', 'Specify which subset and the criterion.'],
  ['possibly', 'vague_term', 'high', 'Specify the conditions under which this happens.'],
  ['approximately', 'vague_term', 'medium', 'Specify the tolerance band.'],
  ['about', 'vague_term', 'low', 'Quantify with an explicit tolerance.'],
  ['usually', 'vague_term', 'high', 'Specify the conditions and the percentage of time.'],
  ['typically', 'vague_term', 'high', 'Specify the conditions and frequency.'],
  ['normally', 'vague_term', 'high', 'Specify the normal-case condition.'],
  ['generally', 'vague_term', 'high', 'Specify the conditions where this applies.'],
  ['often', 'vague_term', 'high', 'Specify the frequency or conditions.'],
  ['sometimes', 'vague_term', 'high', 'Specify when this applies.'],
  ['clear', 'vague_term', 'medium', 'Clear by what test? Specify measurable clarity.'],
  ['clearly', 'vague_term', 'medium', 'Specify the measurable clarity criterion.'],
  ['simple', 'vague_term', 'medium', 'Simple by what measure? Specify constraints.'],
  ['easy', 'vague_term', 'medium', 'Easy per what user task model? Specify.'],
  ['nice', 'vague_term', 'low', 'Subjective - replace with a measurable property.'],
  ['better', 'vague_term', 'high', 'Better than what baseline? Specify the comparison.'],
  ['improved', 'vague_term', 'high', 'Improved over what baseline? Specify the metric.'],
  ['enhanced', 'vague_term', 'high', 'Enhanced over what baseline? Specify the metric.'],
  ['high-quality', 'vague_term', 'high', 'Quality measured how? Specify.'],
  ['state-of-the-art', 'vague_term', 'high', 'State-of-the-art per which benchmark and date? Specify.'],
  ['world-class', 'vague_term', 'high', 'Marketing language - replace with a concrete benchmark.'],
  ['real-time', 'vague_term', 'medium', 'Real-time has multiple meanings - specify the latency budget.'],
  ['near real-time', 'vague_term', 'medium', 'Specify the maximum permitted latency.'],
  ['timely', 'vague_term', 'high', 'Specify the maximum permitted delay.'],
  ['in a timely manner', 'vague_term', 'high', 'Specify the maximum permitted delay.'],
  ['as soon as possible', 'vague_term', 'high', 'Specify the maximum permitted latency.'],
  ['when applicable', 'vague_term', 'high', 'Specify the conditions of applicability.'],
  ['where applicable', 'vague_term', 'high', 'Specify the conditions of applicability.'],
  ['if necessary', 'vague_term', 'high', "Specify when 'necessary' is true."],
  ['if needed', 'vague_term', 'high', "Specify when 'needed' is true."],
  ['etc.', 'etcetera', 'medium', "Enumerate the full list - 'etc.' leaves the requirement open-ended."],
  ['etc', 'etcetera', 'medium', "Enumerate the full list - 'etc.' leaves the requirement open-ended."],
  ['and/or', 'and_or', 'high', "Resolve the ambiguity: choose 'and', 'or', or 'either'."],
  ['and / or', 'and_or', 'high', "Resolve the ambiguity: choose 'and', 'or', or 'either'."],
  ['etcetera', 'etcetera', 'medium', 'Enumerate the full list.'],
];

export const WEAK_VERBS: readonly TermRule[] = [
  ['should', 'vague_term', 'medium', "Use 'shall' for binding requirements; 'should' is non-binding."],
  ['may', 'vague_term', 'low', "'May' is permissive - confirm intent."],
  ['might', 'vague_term', 'medium', "'Might' is non-binding - confirm intent."],
  ['could', 'vague_term', 'medium', "'Could' is non-binding - confirm intent."],
  ['will', 'vague_term', 'low', "'Will' is descriptive; use 'shall' for binding requirements."],
];

export const QUANTIFIER_PHRASES: readonly TermRule[] = [
  ['all reasonable', 'vague_term', 'high', "'Reasonable' is undefined - specify the conditions."],
  ['all standard', 'vague_term', 'medium', 'Specify which standards qualify.'],
  ['all normal', 'vague_term', 'high', "Specify what 'normal' means in this context."],
  ['any device', 'quantifier', 'high', "'Any device' is unbounded - enumerate supported device classes."],
  ['any user', 'quantifier', 'medium', "'Any user' is unbounded - define user roles."],
  ['any time', 'quantifier', 'medium', 'Specify the operational window.'],
  ['at all times', 'quantifier', 'high', 'Effectively unbounded - define the SLA window.'],
  ['most cases', 'vague_term', 'high', 'Define the conditions and percentage.'],
];
