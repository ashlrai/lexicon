/**
 * Tests for cleanLiteral / resolveSpan / parseDetectorReport. Mirrors the
 * contract in Pellucid's tests/test_agent_parsing.py: trust the model's
 * verbatim text, never its offsets; refuse findings whose span cannot be
 * resolved unambiguously.
 */
import { describe, expect, it } from 'vitest';
import { parseDetectorReport } from '../src/ambiguity/parse.js';
import { cleanLiteral, resolveSpan } from '../src/ambiguity/resolve.js';

const DOC =
  'The system shall be user-friendly and respond quickly. ' +
  'All standard interfaces must be supported. ' +
  'Data may be sampled while in motion.';

describe('cleanLiteral', () => {
  it('strips markdown bullets, markers and quotes from both ends', () => {
    expect(cleanLiteral('- Authentication s')).toBe('Authentication s');
    expect(cleanLiteral('  *"secure"*  ')).toBe('secure');
    expect(cleanLiteral('`fast`')).toBe('fast');
    expect(cleanLiteral("don't")).toBe("don't");
    expect(cleanLiteral('user-friendly')).toBe('user-friendly');
  });
});

describe('resolveSpan', () => {
  it('finds a unique occurrence', () => {
    const span = resolveSpan(DOC, 'standard', 0);
    expect(span).toEqual({ start: DOC.indexOf('standard'), end: DOC.indexOf('standard') + 8 });
  });

  it('returns undefined when the literal is absent', () => {
    expect(resolveSpan(DOC, 'nonexistent phrase', 0)).toBeUndefined();
    expect(resolveSpan(DOC, '', 0)).toBeUndefined();
  });

  it('picks the occurrence nearest a decisive hint', () => {
    const filler = 'x'.repeat(300);
    const doc = `target ${filler} target`;
    const second = doc.lastIndexOf('target');
    const span = resolveSpan(doc, 'target', second - 2);
    expect(span).toEqual({ start: second, end: second + 6 });
  });

  it('refuses close occurrences even when the hint is near one', () => {
    // Two 'target's 10 chars apart: the 200-char margin can never be met.
    const doc = 'aa target xx target yy';
    const second = doc.lastIndexOf('target');
    expect(resolveSpan(doc, 'target', second - 2)).toBeUndefined();
  });

  it('refuses when the hint is far from every occurrence', () => {
    const doc = 'target ' + 'x'.repeat(500) + ' target';
    expect(resolveSpan(doc, 'target', 250)).toBeUndefined();
  });
});

describe('parseDetectorReport', () => {
  const spec = { source: 'lexical', validTypes: ['polysemy', 'vague_term', 'other'] as const };

  it('parses a finding with correct offsets', () => {
    const start = DOC.indexOf('user-friendly');
    const report = parseDetectorReport(spec.source, spec.validTypes, DOC, {
      findings: [
        {
          start,
          end: start + 13,
          text: 'user-friendly',
          type: 'vague_term',
          severity: 'high',
          rationale: 'Subjective.',
          confidence: 0.9,
        },
      ],
      reasoning: 'ok',
      self_confidence: 0.8,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ start, text: 'user-friendly', type: 'vague_term', source: 'lexical' });
    expect(report.selfConfidence).toBe(0.8);
  });

  it('recovers from misaligned offsets (the live-prod bug)', () => {
    const start = DOC.indexOf('standard');
    const report = parseDetectorReport(spec.source, spec.validTypes, DOC, {
      findings: [
        { start: start + 2, end: start + 10, text: 'standard', type: 'vague_term', severity: 'medium', rationale: 'Standard what?', confidence: 0.7 },
      ],
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ start, end: start + 8, text: 'standard' });
  });

  it('drops text that is not in the document', () => {
    const report = parseDetectorReport(spec.source, spec.validTypes, DOC, {
      findings: [{ start: 0, end: 10, text: 'nonexistent phrase', type: 'vague_term', severity: 'low', rationale: 'n/a', confidence: 0.5 }],
    });
    expect(report.findings).toHaveLength(0);
  });

  it('recovers when offsets are out of bounds', () => {
    const start = DOC.indexOf('in motion');
    const report = parseDetectorReport(spec.source, spec.validTypes, DOC, {
      findings: [{ start: 9999, end: 10010, text: 'in motion', type: 'vague_term', severity: 'low', rationale: 'r', confidence: 0.5 }],
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].start).toBe(start);
  });

  it('falls back to other/medium/0.5 on invalid fields', () => {
    const start = DOC.indexOf('quickly');
    const report = parseDetectorReport(spec.source, spec.validTypes, DOC, {
      findings: [{ start, end: start + 7, text: 'quickly', type: 'undefined_jargon', severity: 'extreme', confidence: 'high' }],
    });
    expect(report.findings[0]).toMatchObject({ type: 'other', severity: 'medium', confidence: 0.5 });
  });

  it('drops report-level noise without losing valid findings', () => {
    const start = DOC.indexOf('quickly');
    const report = parseDetectorReport(spec.source, spec.validTypes, DOC, {
      findings: [
        null,
        'garbage',
        { start, end: start + 7, text: 'quickly', type: 'vague_term', severity: 'high', rationale: 'r', confidence: 0.8 },
        { start: 0, end: 4, text: '', type: 'vague_term' },
      ],
      reasoning: 'read ok',
      self_confidence: 'bogus',
    });
    expect(report.findings).toHaveLength(1);
    expect(report.reasoning).toBe('read ok');
    expect(report.selfConfidence).toBe(0.6);
  });
});
