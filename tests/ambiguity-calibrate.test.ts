/**
 * Tests for the confidence calibrator. Mirrors Pellucid's
 * tests/test_calibration.py: output bounds, the strict-monotonicity
 * contracts, the ensemble-agreement headline, and refitting on real labels.
 */
import { describe, expect, it } from 'vitest';
import { ConfidenceCalibrator, defaultCalibrator } from '../src/ambiguity/calibrate.js';
import type { CalibrationInput } from '../src/ambiguity/types.js';
import { SEVERITIES } from '../src/ambiguity/types.js';

function base(overrides: Partial<CalibrationInput> = {}): CalibrationInput {
  return {
    baseConfidence: 0.6,
    agentCorroboration: 0,
    clusterAgree: 0,
    clusterDisagree: 0,
    ruleCorroborated: false,
    severity: 'medium',
    ...overrides,
  };
}

describe('output bounds', () => {
  it('stays within [0.05, 0.99] across a grid', () => {
    const cal = defaultCalibrator();
    for (const baseConfidence of [0.0, 0.3, 0.6, 0.9, 1.0]) {
      for (const agentCorroboration of [0, 1, 2, 5]) {
        for (const clusterAgree of [0, 1, 5]) {
          for (const clusterDisagree of [0, 1, 5]) {
            for (const ruleCorroborated of [false, true]) {
              for (const severity of SEVERITIES) {
                const p = cal.calibrate(
                  base({ baseConfidence, agentCorroboration, clusterAgree, clusterDisagree, ruleCorroborated, severity }),
                );
                expect(p, `out of range for ${JSON.stringify({ baseConfidence, agentCorroboration, clusterAgree, clusterDisagree, ruleCorroborated, severity })}`).toBeGreaterThanOrEqual(0.05);
                expect(p).toBeLessThanOrEqual(0.99);
              }
            }
          }
        }
      }
    }
  });

  it('saturates at the floor under extreme disagreement', () => {
    const p = defaultCalibrator().calibrate(base({ baseConfidence: 0.1, clusterDisagree: 20, severity: 'low' }));
    expect(p).toBeCloseTo(0.05, 6);
  });

  it('saturates near the ceiling under maximum agreement', () => {
    const p = defaultCalibrator().calibrate(
      base({ baseConfidence: 0.9, agentCorroboration: 4, clusterAgree: 5, ruleCorroborated: true, severity: 'critical' }),
    );
    expect(p).toBeGreaterThanOrEqual(0.95);
  });

  it('never exceeds the ceiling even with huge signals', () => {
    const p = defaultCalibrator().calibrate(
      base({ baseConfidence: 1.0, agentCorroboration: 100, clusterAgree: 100, ruleCorroborated: true, severity: 'critical' }),
    );
    expect(p).toBeLessThanOrEqual(0.99);
  });
});

describe('strict monotonicity', () => {
  const cal = defaultCalibrator();

  it('increases in agent corroboration until ceiling', () => {
    let prev = -1;
    for (let ac = 0; ac < 8; ac++) {
      const p = cal.calibrate(base({ agentCorroboration: ac }));
      if (p < 0.99) expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('increases in agree votes', () => {
    let prev = -1;
    for (let agree = 0; agree < 8; agree++) {
      const p = cal.calibrate(base({ clusterAgree: agree }));
      if (p < 0.99) expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('decreases in disagree votes until floor', () => {
    let prev = Infinity;
    for (let dis = 0; dis < 8; dis++) {
      const p = cal.calibrate(base({ clusterDisagree: dis }));
      if (p > 0.05) expect(p).toBeLessThan(prev);
      prev = p;
    }
  });

  it('increases with rule corroboration', () => {
    expect(cal.calibrate(base({ ruleCorroborated: true }))).toBeGreaterThan(
      cal.calibrate(base({ ruleCorroborated: false })),
    );
  });

  it('increases in severity', () => {
    let prev = -1;
    for (const severity of SEVERITIES) {
      const p = cal.calibrate(base({ severity }));
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });

  it('increases in base confidence', () => {
    let prev = -1;
    for (const baseConfidence of [0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]) {
      const p = cal.calibrate(base({ baseConfidence }));
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });
});

describe('ensemble agreement contract', () => {
  it('more agreement means higher confidence', () => {
    const cal = defaultCalibrator();
    const solo = cal.calibrate(base({ agentCorroboration: 0, clusterAgree: 0 }));
    const pair = cal.calibrate(base({ agentCorroboration: 1, clusterAgree: 1 }));
    const quartet = cal.calibrate(base({ agentCorroboration: 3, clusterAgree: 3 }));
    expect(solo).toBeLessThan(pair);
    expect(pair).toBeLessThan(quartet);
  });

  it('disagreement overcomes corroboration', () => {
    const cal = defaultCalibrator();
    const disputed = cal.calibrate(base({ agentCorroboration: 2, clusterAgree: 0, clusterDisagree: 4 }));
    const quiet = cal.calibrate(base());
    expect(disputed).toBeLessThan(quiet);
  });
});

describe('fit()', () => {
  it('refits on real labels and changes the mapping', () => {
    const samples: Array<readonly [CalibrationInput, number]> = [];
    for (let ac = 0; ac < 4; ac++) {
      const label = ac === 0 ? 0.0 : 1.0;
      samples.push([base({ agentCorroboration: ac }), label]);
      samples.push([base({ agentCorroboration: ac }), label]);
    }
    const cal = new ConfidenceCalibrator();
    cal.fit(samples);
    const pLow = cal.calibrate(base({ agentCorroboration: 0 }));
    const pHigh = cal.calibrate(base({ agentCorroboration: 3 }));
    expect(pLow).toBeLessThan(0.5);
    expect(pHigh).toBeGreaterThan(0.5);
    expect(pLow).toBeLessThan(pHigh);
  });

  it('rejects empty samples', () => {
    expect(() => new ConfidenceCalibrator().fit([])).toThrow();
  });

  it('throws when calibrated before fit', () => {
    expect(() => new ConfidenceCalibrator().calibrate(base())).toThrow();
  });
});
