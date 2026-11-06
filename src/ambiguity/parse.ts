/**
 * Model-response parser, ported from Pellucid (_parse_report in
 * apps/api/app/agents/base.py). Pure functions, no IO.
 *
 * A stage-2 detector (small local model, remote model, scripted checker)
 * returns JSON shaped like {findings: [...], reasoning, self_confidence}.
 * parseDetectorReport validates each finding against the document: the
 * claimed text must appear verbatim (recovered via resolveSpan when the
 * model's offsets are wrong, which is the common case), the type must be one
 * the detector is allowed to emit, and confidences are coerced into 0..1.
 * Anything that fails validation is dropped rather than corrected - one bad
 * span must not sink the rest of the report.
 */
import { cleanLiteral, resolveSpan } from './resolve.js';
import type { DetectorReport, FindingType, Severity } from './types.js';
import { FINDING_TYPES, SEVERITIES } from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Python int() parity: accept numbers and numeric strings, else -1. */
function asInt(value: unknown): number {
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : -1;
}

/** Python float() parity: accept numbers and numeric strings, else fallback. */
function asFloat(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function asType(value: unknown, validTypes: readonly FindingType[]): FindingType {
  return (FINDING_TYPES as readonly string[]).includes(value as string) &&
    validTypes.includes(value as FindingType)
    ? (value as FindingType)
    : 'other';
}

function asSeverity(value: unknown): Severity {
  return (SEVERITIES as readonly string[]).includes(value as string) ? (value as Severity) : 'medium';
}

/**
 * Parse a detector's raw JSON response into a DetectorReport.
 *
 * @param source       the detector's source tag stamped on its findings
 * @param validTypes   finding types this detector may emit; others -> 'other'
 * @param documentText the text the detector analyzed; spans anchor into it
 * @param raw          the decoded JSON body (any shape; bad parts are dropped)
 */
export function parseDetectorReport(
  source: string,
  validTypes: readonly FindingType[],
  documentText: string,
  raw: unknown,
): DetectorReport {
  const body = asRecord(raw) ?? {};
  const items = Array.isArray(body.findings) ? body.findings : [];
  const findings: DetectorReport['findings'] = [];

  for (const item of items) {
    const rec = asRecord(item);
    if (!rec) continue;
    const llmStart = asInt(rec.start);
    const llmEnd = asInt(rec.end);

    const literal = cleanLiteral(typeof rec.text === 'string' ? rec.text : String(rec.text ?? ''));
    if (!literal) continue;

    // Trust the model's text over its offsets. If the offsets it gave point
    // at exactly the text it claimed, keep them; otherwise recover by search.
    let span: { start: number; end: number } | undefined;
    if (llmStart >= 0 && llmStart < llmEnd && llmEnd <= documentText.length) {
      if (documentText.slice(llmStart, llmEnd).trim() === literal) {
        span = { start: llmStart, end: llmEnd };
      }
    }
    span ??= resolveSpan(documentText, literal, llmStart);
    if (!span) continue;

    findings.push({
      start: span.start,
      end: span.end,
      text: documentText.slice(span.start, span.end),
      type: asType(rec.type, validTypes),
      severity: asSeverity(rec.severity),
      rationale: typeof rec.rationale === 'string' ? rec.rationale.trim() : String(rec.rationale ?? '').trim(),
      confidence: asFloat(rec.confidence, 0.5),
      source,
    });
  }

  return {
    source,
    findings,
    reasoning: typeof body.reasoning === 'string' ? body.reasoning.trim() : String(body.reasoning ?? '').trim(),
    selfConfidence: asFloat(body.self_confidence ?? body.selfConfidence, 0.6),
  };
}
