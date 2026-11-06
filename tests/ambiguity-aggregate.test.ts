/**
 * Tests for the ensemble aggregator. Mirrors Pellucid's
 * tests/test_aggregator.py: overlap clustering, corroboration, votes and
 * max-severity merging.
 */
import { describe, expect, it } from 'vitest';
import { aggregateFindings } from '../src/ambiguity/aggregate.js';
import type { AmbiguityFinding, DetectorReport, FindingVote, Severity } from '../src/ambiguity/types.js';

function f(start: number, end: number, source: string, severity: Severity = 'medium', confidence = 0.6): AmbiguityFinding {
  return {
    start,
    end,
    text: `span_${start}_${end}`,
    type: 'other',
    severity,
    rationale: `from ${source}`,
    confidence,
    source,
  };
}

function report(source: string, findings: AmbiguityFinding[], selfConfidence = 0.7): DetectorReport {
  return { source, findings, reasoning: '', selfConfidence };
}

describe('aggregateFindings', () => {
  it('boosts confidence on rule+detector corroboration', () => {
    const rule = f(0, 10, 'rules', 'medium', 0.6);
    const lexical = report('lexical', [f(0, 10, 'lexical', 'medium', 0.6)]);
    const out = aggregateFindings([rule], [lexical], []);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBeGreaterThan(rule.confidence);
    expect(out[0].source).toBe('ensemble');
  });

  it('keeps disjoint findings separate', () => {
    const out = aggregateFindings([f(0, 10, 'rules')], [report('domain', [f(20, 30, 'domain')])], []);
    expect(out).toHaveLength(2);
    expect(out[0].start).toBe(0);
    expect(out[1].start).toBe(20);
  });

  it('boosts confidence on AGREE votes', () => {
    const lexical = report('lexical', [f(0, 10, 'lexical', 'medium', 0.5)]);
    const vote: FindingVote = { voter: 'syntactic', targetIndex: 0, targetSource: 'lexical', agree: true, reasoning: 'agreed' };
    const out = aggregateFindings([], [lexical], [vote]);
    expect(out[0].confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('drops confidence on DISAGREE votes', () => {
    const lexical = report('lexical', [f(0, 10, 'lexical', 'medium', 0.6)]);
    const votes: FindingVote[] = [0, 1, 2].map((i) => ({
      voter: `voter${i}`,
      targetIndex: 0,
      targetSource: 'lexical',
      agree: false,
      reasoning: 'no',
    }));
    const disputed = aggregateFindings([], [lexical], votes);
    const quiet = aggregateFindings([], [lexical], []);
    expect(disputed[0].confidence).toBeLessThan(quiet[0].confidence);
  });

  it('takes the max severity in a cluster', () => {
    const out = aggregateFindings(
      [],
      [report('lexical', [f(0, 10, 'lexical', 'medium')]), report('risk', [f(0, 10, 'risk', 'critical', 0.9)])],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('critical');
  });

  it('merges partially overlapping spans into one cluster', () => {
    const out = aggregateFindings(
      [],
      [report('lexical', [f(0, 10, 'lexical')]), report('syntactic', [f(5, 15, 'syntactic')])],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('ensemble');
  });

  it('keeps the canonical span and combines rationales', () => {
    const out = aggregateFindings(
      [f(0, 10, 'rules', 'medium', 0.75)],
      [report('risk', [f(2, 8, 'risk', 'high', 0.9)])],
      [],
    );
    expect(out).toHaveLength(1);
    // Highest-severity finding is canonical: the risk span wins.
    expect(out[0]).toMatchObject({ start: 2, end: 8, severity: 'high' });
    expect(out[0].rationale).toContain('[rules]');
    expect(out[0].rationale).toContain('[risk]');
  });

  it('handles empty input', () => {
    expect(aggregateFindings([], [], [])).toEqual([]);
  });
});
