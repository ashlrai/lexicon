/**
 * Tests for the term-rule detector and the rule-layer pipeline. Mirrors
 * Pellucid's tests/test_rules.py plus the dedupe contract.
 */
import { describe, expect, it } from 'vitest';
import { dedupeFindings, runRuleLayer } from '../src/ambiguity/index.js';
import { findTermFindings, severityToConfidence } from '../src/ambiguity/rules.js';
import type { AmbiguityFinding } from '../src/ambiguity/types.js';

function f(partial: Partial<AmbiguityFinding> & Pick<AmbiguityFinding, 'start' | 'end'>): AmbiguityFinding {
  return {
    text: '',
    type: 'vague_term',
    severity: 'medium',
    rationale: 'r',
    confidence: 0.7,
    source: 'rules',
    ...partial,
  };
}

describe('findTermFindings', () => {
  it('flags vague terms', () => {
    const text = 'The system shall be user-friendly and provide optimal performance.';
    const findings = findTermFindings(text);
    const matched = new Set(findings.map((x) => x.text.toLowerCase()));
    expect(matched.has('user-friendly')).toBe(true);
    expect(matched.has('optimal')).toBe(true);
  });

  it('flags and/or at high severity', () => {
    const text = 'The user can configure which alerts they want to receive and/or suppress.';
    const findings = findTermFindings(text);
    const andOr = findings.filter((x) => x.type === 'and_or');
    expect(andOr).toHaveLength(1);
    expect(andOr[0].severity).toBe('high');
  });

  it('flags etcetera', () => {
    const text = 'If connectivity is lost, the system will buffer data and retransmit it later, etc.';
    const findings = findTermFindings(text);
    expect(findings.some((x) => x.type === 'etcetera')).toBe(true);
  });

  it('flags quantifier phrases', () => {
    const text = 'Sensitive data must be protected at all times.';
    const findings = findTermFindings(text);
    expect(findings.some((x) => x.type === 'quantifier' && x.text.toLowerCase().includes('all times'))).toBe(true);
  });

  it('respects word boundaries', () => {
    // 'fast' must not fire inside 'fasten'; 'etc' must not fire inside 'etcetera-ish'.
    const findings = findTermFindings('Fasten the connector. The etcetera-ish list goes on.');
    expect(findings.some((x) => x.text.toLowerCase() === 'fast')).toBe(false);
    expect(findings.filter((x) => x.type === 'etcetera')).toHaveLength(0);
  });

  it('is case-insensitive and keeps the verbatim span text', () => {
    const text = 'The UI must be INTUITIVE.';
    const findings = findTermFindings(text);
    const hit = findings.find((x) => x.text === 'INTUITIVE');
    expect(hit).toBeDefined();
    expect(text.slice(hit!.start, hit!.end)).toBe('INTUITIVE');
  });
});

describe('severityToConfidence', () => {
  it('maps the four severities', () => {
    expect(severityToConfidence('low')).toBe(0.6);
    expect(severityToConfidence('medium')).toBe(0.75);
    expect(severityToConfidence('high')).toBe(0.85);
    expect(severityToConfidence('critical')).toBe(0.95);
  });
});

describe('runRuleLayer', () => {
  it('runs all detectors and spans point at real text', () => {
    const text =
      'The system shall be user-friendly and respond quickly. Sensitive data must be ' +
      'protected at all times. It will be encrypted, etc.';
    const findings = runRuleLayer(text);
    expect(findings.length).toBeGreaterThanOrEqual(4);
    for (const finding of findings) {
      expect(text.slice(finding.start, finding.end)).toBe(finding.text);
    }
    const types = new Set(findings.map((x) => x.type));
    expect(types.has('vague_term')).toBe(true);
    expect(types.has('passive_voice')).toBe(true);
    expect(types.has('etcetera')).toBe(true);
    expect(types.has('quantifier')).toBe(true);
  });
});

describe('dedupeFindings', () => {
  it('drops same-span same-type duplicates, preferring higher confidence', () => {
    const low = f({ start: 0, end: 5, confidence: 0.6 });
    const high = f({ start: 0, end: 5, confidence: 0.9 });
    const out = dedupeFindings([low, high]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(0.9);
  });

  it('keeps same-span different-type findings and sorts by span', () => {
    const a = f({ start: 10, end: 15, type: 'vague_term' });
    const b = f({ start: 0, end: 5, type: 'passive_voice' });
    const c = f({ start: 0, end: 5, type: 'quantifier' });
    const out = dedupeFindings([a, b, c]);
    expect(out).toHaveLength(3);
    expect(out[0].start).toBe(0);
  });
});
