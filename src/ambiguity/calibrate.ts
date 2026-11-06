/**
 * Confidence calibration for the aggregator, ported from Pellucid
 * (apps/api/app/agents/calibration.py). Pure functions, no IO.
 *
 * Replaces the hand-tuned additive heuristic with a split-conformal-style
 * calibrator: raw ensemble signals are reduced to a strictly monotone scalar
 * score, then mapped through a pool-adjacent-violators (PAV) isotonic
 * regression fit on a synthetic prior. The synthetic prior is a grid of
 * plausible signal combinations labeled by a logistic of the raw score - it
 * behaves like the old heuristic in spirit but produces a strictly monotone,
 * saturating curve in [0.05, 0.99] without cliff edges.
 *
 * When a real labeled corpus exists it is a one-call swap: build a
 * ConfidenceCalibrator, .fit() it on (CalibrationInput, label) pairs, and
 * substitute it for defaultCalibrator(). No external deps - the PAV is a
 * textbook O(n) implementation over plain arrays.
 */
import type { CalibrationInput, Severity } from './types.js';
import { SEVERITIES } from './types.js';

/** Output bounds: epistemic floor and ceiling for emitted confidences. */
const PROB_FLOOR = 0.05;
const PROB_CEIL = 0.99;

/**
 * Fixed coefficients for the monotone scalar combination, tuned so the
 * synthetic-prior fit produces a curve comparable to the previous additive
 * heuristic in the common 0-3 corroborators / 0-3 votes regime with smooth
 * saturation. The signs are load-bearing: the monotonicity tests fail if any
 * of them is flipped.
 */
const W_BASE = 2.0;
const W_AGENT_CORROB = 0.9;
const W_AGREE = 0.7;
const W_DISAGREE = -0.9;
const W_RULE = 0.5;
const W_SEVERITY = 0.25;
const BIAS = -1.5;

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Combine signals into one scalar, strictly monotone in each signal in the
 * spec'd direction. Deliberately not sigmoid-squashed: the isotonic stage
 * handles the squash, and a linear input gives it a smoother distribution.
 */
function rawScore(inp: CalibrationInput): number {
  return (
    W_BASE * inp.baseConfidence +
    W_AGENT_CORROB * inp.agentCorroboration +
    W_AGREE * inp.clusterAgree +
    W_DISAGREE * inp.clusterDisagree +
    W_RULE * (inp.ruleCorroborated ? 1 : 0) +
    W_SEVERITY * SEVERITY_RANK[inp.severity] +
    BIAS
  );
}

/**
 * Pool-adjacent-violators isotonic regression. Given scores sorted ascending
 * and paired labels, returns per-sample fitted values that are
 * non-decreasing and minimize squared error under the monotone constraint.
 */
function pav(labels: number[]): number[] {
  // Stack of (sum, weight, endIndexInclusive) blocks.
  const sums: number[] = [];
  const weights: number[] = [];
  const ends: number[] = [];

  for (let i = 0; i < labels.length; i++) {
    sums.push(labels[i]);
    weights.push(1);
    ends.push(i);
    // Merge backwards while the previous block's mean exceeds the new one's.
    while (sums.length >= 2 && sums[sums.length - 2] / weights[weights.length - 2] >= sums[sums.length - 1] / weights[weights.length - 1]) {
      const s = sums.pop() as number;
      const w = weights.pop() as number;
      const e = ends.pop() as number;
      sums[sums.length - 1] += s;
      weights[weights.length - 1] += w;
      ends[ends.length - 1] = e;
    }
  }

  const fitted = new Array<number>(labels.length);
  let start = 0;
  for (let b = 0; b < sums.length; b++) {
    const mean = sums[b] / weights[b];
    for (let k = start; k <= ends[b]; k++) fitted[k] = mean;
    start = ends[b] + 1;
  }
  return fitted;
}

/**
 * The synthetic prior grid: every plausible signal combination labeled by a
 * logistic of its raw score. Monotone in each signal in the required
 * direction, so the PAV fit stays non-decreasing in the raw score.
 */
function syntheticPriorSamples(): Array<[CalibrationInput, number]> {
  const samples: Array<[CalibrationInput, number]> = [];
  for (const base of [0.3, 0.5, 0.6, 0.75, 0.9]) {
    for (let corrob = 0; corrob <= 4; corrob++) {
      for (let agree = 0; agree <= 3; agree++) {
        for (let disagree = 0; disagree <= 3; disagree++) {
          for (const rule of [false, true]) {
            for (const severity of SEVERITIES) {
              const inp: CalibrationInput = {
                baseConfidence: base,
                agentCorroboration: corrob,
                clusterAgree: agree,
                clusterDisagree: disagree,
                ruleCorroborated: rule,
                severity,
              };
              const z = rawScore(inp);
              samples.push([inp, 1 / (1 + Math.exp(-z))]);
            }
          }
        }
      }
    }
  }
  return samples;
}

/**
 * Maps raw ensemble signals to a calibrated probability in [0.05, 0.99].
 * Strictly monotone in every signal even where the isotonic fit has
 * plateaus, thanks to a tiny EPSILON * rawScore tiebreaker added after the
 * isotonic lookup.
 */
export class ConfidenceCalibrator {
  /**
   * Strict-monotone tiebreaker. Small enough never to move a probability by
   * more than a few thousandths, large enough to strictly order PAV plateau
   * values by their underlying raw score.
   */
  private static readonly EPSILON = 1e-3;

  private fitScores: number[] = [];
  private fitProbs: number[] = [];
  private fitted = false;

  /**
   * Fit the isotonic mapping on (input, label) pairs. label is a probability
   * in [0,1] or a 0/1 indicator; PAV handles both. Pass real labels once a
   * calibration corpus exists.
   */
  fit(samples: ReadonlyArray<readonly [CalibrationInput, number]>): void {
    if (samples.length === 0) {
      throw new Error('Cannot fit calibrator on zero samples.');
    }
    const pairs = samples
      .map(([inp, label]) => ({ score: rawScore(inp), label }))
      .sort((a, b) => a.score - b.score);
    this.fitScores = pairs.map((p) => p.score);
    this.fitProbs = pav(pairs.map((p) => p.label));
    this.fitted = true;
  }

  /** Map signals to a calibrated probability in [0.05, 0.99]. */
  calibrate(rawSignals: CalibrationInput): number {
    if (!this.fitted) {
      throw new Error('ConfidenceCalibrator.calibrate called before fit(). Use defaultCalibrator() or call fit() first.');
    }
    const z = rawScore(rawSignals);

    // Right-search: rightmost training score <= z gives the step-function
    // value; below all scores, use the leftmost fitted value.
    let lo = 0;
    let hi = this.fitScores.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.fitScores[mid] <= z) lo = mid + 1;
      else hi = mid;
    }
    const base = lo === 0 ? this.fitProbs[0] : this.fitProbs[lo - 1];
    const nudged = base + ConfidenceCalibrator.EPSILON * z;
    return Math.min(PROB_CEIL, Math.max(PROB_FLOOR, nudged));
  }
}

let defaultInstance: ConfidenceCalibrator | undefined;

/**
 * The shared calibrator, lazily fit on the synthetic prior grid (~3200
 * points, instant) on first use so importing this module stays cheap.
 */
export function defaultCalibrator(): ConfidenceCalibrator {
  defaultInstance ??= (() => {
    const cal = new ConfidenceCalibrator();
    cal.fit(syntheticPriorSamples());
    return cal;
  })();
  return defaultInstance;
}
