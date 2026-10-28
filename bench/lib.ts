/**
 * Benchmark library: corpus/lexicon loading and metric computation.
 * Pure apart from file reads; bench/run.ts is the CLI, bench/bench.test.ts the
 * regression guard. Both import from here so the numbers cannot drift apart.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { buildIndex, findReplacements } from '../src/core/matcher.js';
import { normalize } from '../src/core/normalize.js';
import { parseLexicon } from '../src/core/schema.js';
import type { Lexicon, MatchReason, NormalizeOptions, Replacement } from '../src/core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS = join(HERE, 'corpus.jsonl');
export const DEFAULT_LEXICON = join(HERE, 'lexicon.yaml');

export type BenchCategory = 'brand' | 'person' | 'product' | 'acronym' | 'identifier' | 'prose';
export const CATEGORIES: readonly BenchCategory[] = ['brand', 'product', 'acronym', 'person', 'identifier', 'prose'];

export interface BenchCase {
  id: string;
  category: BenchCategory;
  /** What STT produced. */
  heard: string;
  /** What the user meant. */
  expected: string;
  /** Canonicals that must appear in `expected`. Empty for negatives. */
  terms: string[];
  /** Free text. A note starting with "expected-hard" marks a case we expect to fail. */
  note?: string;
  /**
   * Language family on non-English-name cases (issue #8): 'german', 'spanish',
   * 'polish', 'japanese', 'arabic', 'nordic'. Untagged cases are the original
   * baseline corpus; the report scores the tagged subset separately.
   */
  lang?: string;
}

export interface BenchOptions {
  minConfidence?: number;
  phonetic?: boolean;
  fuzzy?: boolean;
  /** Restrict to one category. */
  filter?: BenchCategory;
  /** Measure latency (adds a few hundred ms). Default true. */
  timing?: boolean;
}

export interface CaseResult {
  id: string;
  category: BenchCategory;
  heard: string;
  expected: string;
  output: string;
  pass: boolean;
  negative: boolean;
  hard: boolean;
  /** Canonicals the case expects; lets subset metrics be derived from results alone. */
  terms: string[];
  /** Language family tag, carried over from the case. */
  lang?: string;
  replacements: Replacement[];
  /** Term slots (canonical) that were not recovered. */
  missed: string[];
  /** Replacements whose canonical is not in `terms`. */
  spurious: Replacement[];
}

export interface Ratio {
  hit: number;
  total: number;
  /** hit / total, 0 when total is 0. */
  rate: number;
}

export interface ReasonStats {
  replacements: number;
  /** canonical is one of the case's expected terms */
  correct: number;
  /** canonical is not one of the case's expected terms (every replacement in a negative) */
  wrong: number;
  meanConfidence: number;
}

export interface BenchReport {
  config: { minConfidence: number; phonetic: boolean; fuzzy: boolean; filter?: BenchCategory };
  counts: { cases: number; positives: number; negatives: number; hard: number; termSlots: number };
  sentence: {
    all: Ratio;
    positives: Ratio;
    negatives: Ratio;
    positivesExcludingHard: Ratio;
    negativesExcludingHard: Ratio;
    byCategory: Record<string, Ratio>;
  };
  terms: {
    /** Fraction of term slots already correct in `heard` (what raw STT got right). */
    rawRecall: Ratio;
    recall: Ratio;
    precision: Ratio;
    f1: number;
    tp: number;
    fp: number;
    fn: number;
    byCategory: Record<string, { recall: Ratio; rawRecall: Ratio }>;
  };
  /** Negatives with at least one replacement. */
  falsePositiveRate: Ratio;
  falsePositiveRateExcludingHard: Ratio;
  byReason: Record<MatchReason, ReasonStats>;
  /**
   * Metrics over the lang-tagged (non-English) subset and the untagged
   * baseline, per the issue #8 fixture. Present only when the corpus carries
   * at least one lang-tagged case.
   */
  lang?: {
    /** Cases without a lang tag: the original corpus. */
    baseline: SubsetReport;
    /** Cases with any lang tag. */
    nonEnglish: SubsetReport;
    byLang: Record<string, SubsetReport>;
  };
  latency?: { normalizeUs: number; findReplacementsUs: number; rounds: number };
  results: CaseResult[];
}

/** The same headline metrics as the full report, recomputed over a slice of the results. */
export interface SubsetReport {
  cases: number;
  positives: number;
  negatives: number;
  hard: number;
  termSlots: number;
  /** Exact-match sentence accuracy over all cases in the slice. */
  sentence: Ratio;
  /** Exact-match sentence accuracy over positive cases. */
  positiveSentence: Ratio;
  /** Exact-match sentence accuracy over positive cases that are not expected-hard. */
  positiveSentenceExcludingHard: Ratio;
  /** Negatives with at least one replacement. */
  falsePositiveRate: Ratio;
  /** Negatives that are not expected-hard with at least one replacement. */
  falsePositiveRateExcludingHard: Ratio;
  /** Fraction of term slots already correct in `heard`. */
  rawRecall: Ratio;
  recall: Ratio;
  precision: Ratio;
  f1: number;
}

// ---------------------------------------------------------------------------

export function loadLexicon(path: string = DEFAULT_LEXICON): Lexicon {
  return parseLexicon(parseYaml(readFileSync(path, 'utf8')));
}

export function loadCorpus(path: string = DEFAULT_CORPUS): BenchCase[] {
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`corpus line ${i + 1}: invalid JSON (${(err as Error).message})`);
    }
    return assertCase(parsed, i + 1);
  });
}

function assertCase(raw: unknown, line: number): BenchCase {
  if (typeof raw !== 'object' || raw === null) throw new Error(`corpus line ${line}: not an object`);
  const c = raw as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof c[k] !== 'string') throw new Error(`corpus line ${line}: "${k}" must be a string`);
    return c[k] as string;
  };
  const id = str('id');
  const category = str('category') as BenchCategory;
  if (!CATEGORIES.includes(category)) throw new Error(`corpus line ${line} (${id}): unknown category "${category}"`);
  const heard = str('heard');
  const expected = str('expected');
  if (!Array.isArray(c.terms) || !c.terms.every((t) => typeof t === 'string')) {
    throw new Error(`corpus line ${line} (${id}): "terms" must be a string array`);
  }
  const terms = c.terms as string[];
  for (const t of terms) {
    if (!expected.includes(t)) throw new Error(`corpus line ${line} (${id}): expected text does not contain term "${t}"`);
  }
  const out: BenchCase = { id, category, heard, expected, terms };
  if (c.note !== undefined) {
    if (typeof c.note !== 'string') throw new Error(`corpus line ${line} (${id}): "note" must be a string`);
    out.note = c.note;
  }
  if (c.lang !== undefined) {
    if (typeof c.lang !== 'string') throw new Error(`corpus line ${line} (${id}): "lang" must be a string`);
    out.lang = c.lang;
  }
  return out;
}

export function isHard(c: BenchCase): boolean {
  return (c.note ?? '').startsWith('expected-hard');
}

export function isNegative(c: BenchCase): boolean {
  return c.terms.length === 0;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function ratio(hit: number, total: number): Ratio {
  return { hit, total, rate: total === 0 ? 0 : hit / total };
}

// ---------------------------------------------------------------------------

export function runBench(cases: BenchCase[], lexicon: Lexicon, opts: BenchOptions = {}): BenchReport {
  const index = buildIndex(lexicon);
  const normOpts: NormalizeOptions = {};
  if (opts.minConfidence !== undefined) normOpts.minConfidence = opts.minConfidence;
  if (opts.phonetic !== undefined) normOpts.phonetic = opts.phonetic;
  if (opts.fuzzy !== undefined) normOpts.fuzzy = opts.fuzzy;
  const config = {
    minConfidence: opts.minConfidence ?? index.minConfidence,
    phonetic: opts.phonetic ?? index.phonetic,
    fuzzy: opts.fuzzy ?? index.fuzzy,
    ...(opts.filter ? { filter: opts.filter } : {}),
  };

  const selected = opts.filter ? cases.filter((c) => c.category === opts.filter) : cases;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let rawHit = 0;
  let termSlots = 0;
  const byReason: Record<MatchReason, { n: number; correct: number; wrong: number; conf: number }> = {
    alias: { n: 0, correct: 0, wrong: 0, conf: 0 },
    phonetic: { n: 0, correct: 0, wrong: 0, conf: 0 },
    fuzzy: { n: 0, correct: 0, wrong: 0, conf: 0 },
  };
  const catSentence = new Map<string, { hit: number; total: number }>();
  const catTerms = new Map<string, { hit: number; raw: number; total: number }>();
  const bump = <T extends Record<string, number>>(map: Map<string, T>, key: string, init: () => T): T => {
    let v = map.get(key);
    if (!v) {
      v = init();
      map.set(key, v);
    }
    return v;
  };

  const results: CaseResult[] = [];
  for (const c of selected) {
    const negative = isNegative(c);
    const hard = isHard(c);
    const r = normalize(c.heard, lexicon, normOpts);
    const pass = r.output === c.expected;
    const termSet = new Set(c.terms);

    const missed: string[] = [];
    const cs = bump(catSentence, c.category, () => ({ hit: 0, total: 0 }));
    cs.total++;
    if (pass) cs.hit++;

    for (const canonical of termSet) {
      termSlots++;
      const want = Math.max(1, countOccurrences(c.expected, canonical));
      const ct = bump(catTerms, c.category, () => ({ hit: 0, raw: 0, total: 0 }));
      ct.total++;
      if (countOccurrences(c.heard, canonical) >= want) {
        rawHit++;
        ct.raw++;
      }
      if (countOccurrences(r.output, canonical) >= want) {
        tp++;
        ct.hit++;
      } else {
        fn++;
        missed.push(canonical);
      }
    }

    const spurious: Replacement[] = [];
    for (const rep of r.replacements) {
      const stats = byReason[rep.reason];
      stats.n++;
      stats.conf += rep.confidence;
      if (termSet.has(rep.canonical)) {
        stats.correct++;
      } else {
        stats.wrong++;
        spurious.push(rep);
        fp++;
      }
    }

    results.push({
      id: c.id,
      category: c.category,
      heard: c.heard,
      expected: c.expected,
      output: r.output,
      pass,
      negative,
      hard,
      terms: c.terms,
      ...(c.lang !== undefined ? { lang: c.lang } : {}),
      replacements: r.replacements,
      missed,
      spurious,
    });
  }

  const positives = results.filter((r) => !r.negative);
  const negatives = results.filter((r) => r.negative);
  const posEasy = positives.filter((r) => !r.hard);
  const negEasy = negatives.filter((r) => !r.hard);
  const flagged = (list: CaseResult[]): Ratio => ratio(list.filter((r) => r.replacements.length > 0).length, list.length);

  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  const f1 = precision.rate + recall.rate === 0 ? 0 : (2 * precision.rate * recall.rate) / (precision.rate + recall.rate);

  const byCategorySentence: Record<string, Ratio> = {};
  for (const cat of CATEGORIES) {
    const v = catSentence.get(cat);
    if (v) byCategorySentence[cat] = ratio(v.hit, v.total);
  }
  const byCategoryTerms: Record<string, { recall: Ratio; rawRecall: Ratio }> = {};
  for (const cat of CATEGORIES) {
    const v = catTerms.get(cat);
    if (v) byCategoryTerms[cat] = { recall: ratio(v.hit, v.total), rawRecall: ratio(v.raw, v.total) };
  }

  const reasonOut = {} as Record<MatchReason, ReasonStats>;
  for (const reason of ['alias', 'phonetic', 'fuzzy'] as const) {
    const s = byReason[reason];
    reasonOut[reason] = {
      replacements: s.n,
      correct: s.correct,
      wrong: s.wrong,
      meanConfidence: s.n === 0 ? 0 : s.conf / s.n,
    };
  }

  const report: BenchReport = {
    config,
    counts: {
      cases: results.length,
      positives: positives.length,
      negatives: negatives.length,
      hard: results.filter((r) => r.hard).length,
      termSlots,
    },
    sentence: {
      all: passed(results),
      positives: passed(positives),
      negatives: passed(negatives),
      positivesExcludingHard: passed(posEasy),
      negativesExcludingHard: passed(negEasy),
      byCategory: byCategorySentence,
    },
    terms: {
      rawRecall: ratio(rawHit, termSlots),
      recall,
      precision,
      f1,
      tp,
      fp,
      fn,
      byCategory: byCategoryTerms,
    },
    falsePositiveRate: flagged(negatives),
    falsePositiveRateExcludingHard: flagged(negEasy),
    byReason: reasonOut,
    results,
  };

  const tagged = results.filter((r) => r.lang !== undefined);
  if (tagged.length > 0) {
    const byLang: Record<string, SubsetReport> = {};
    for (const lang of [...new Set(tagged.map((r) => r.lang as string))].sort()) {
      byLang[lang] = subsetReport(tagged.filter((r) => r.lang === lang));
    }
    report.lang = {
      baseline: subsetReport(results.filter((r) => r.lang === undefined)),
      nonEnglish: subsetReport(tagged),
      byLang,
    };
  }

  if (opts.timing !== false) report.latency = measureLatency(selected, lexicon, normOpts);
  return report;
}

/**
 * Recompute the headline metrics over a slice of results, so a tagged subset
 * (the non-English names) can sit next to the baseline it was added to.
 * tp/fp/fn and raw recall are derived per case from `terms`, `missed` and
 * `spurious`, the same accounting runBench uses on the full corpus.
 */
export function subsetReport(list: CaseResult[]): SubsetReport {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let rawHit = 0;
  let termSlots = 0;
  for (const r of list) {
    fp += r.spurious.length;
    fn += r.missed.length;
    for (const canonical of new Set(r.terms)) {
      termSlots++;
      const want = Math.max(1, countOccurrences(r.expected, canonical));
      if (countOccurrences(r.heard, canonical) >= want) rawHit++;
      if (countOccurrences(r.output, canonical) >= want) tp++;
    }
  }
  const positives = list.filter((r) => !r.negative);
  const negatives = list.filter((r) => r.negative);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    cases: list.length,
    positives: positives.length,
    negatives: negatives.length,
    hard: list.filter((r) => r.hard).length,
    termSlots,
    sentence: passed(list),
    positiveSentence: passed(positives),
    positiveSentenceExcludingHard: passed(positives.filter((r) => !r.hard)),
    falsePositiveRate: ratio(negatives.filter((r) => r.replacements.length > 0).length, negatives.length),
    falsePositiveRateExcludingHard: ratio(negatives.filter((r) => !r.hard && r.replacements.length > 0).length, negatives.filter((r) => !r.hard).length),
    rawRecall: ratio(rawHit, termSlots),
    recall,
    precision,
    f1: precision.rate + recall.rate === 0 ? 0 : (2 * precision.rate * recall.rate) / (precision.rate + recall.rate),
  };
}

const passed = (list: CaseResult[]): Ratio => ratio(list.filter((r) => r.pass).length, list.length);

/** Warm mean latency per case, in microseconds. normalize() includes buildIndex(). */
function measureLatency(cases: BenchCase[], lexicon: Lexicon, opts: NormalizeOptions): NonNullable<BenchReport['latency']> {
  const rounds = 5;
  const index = buildIndex(lexicon);
  for (const c of cases) {
    normalize(c.heard, lexicon, opts);
    findReplacements(c.heard, index, opts);
  }
  let normTotal = 0;
  let findTotal = 0;
  for (let r = 0; r < rounds; r++) {
    for (const c of cases) {
      const t0 = performance.now();
      normalize(c.heard, lexicon, opts);
      const t1 = performance.now();
      findReplacements(c.heard, index, opts);
      const t2 = performance.now();
      normTotal += t1 - t0;
      findTotal += t2 - t1;
    }
  }
  const n = rounds * Math.max(1, cases.length);
  return { normalizeUs: (normTotal / n) * 1000, findReplacementsUs: (findTotal / n) * 1000, rounds };
}

export const SWEEP_STEPS: readonly number[] = [0.7, 0.75, 0.8, 0.82, 0.85, 0.9, 0.95];

export interface SweepRow {
  minConfidence: number;
  positiveAccuracy: number;
  positiveAccuracyExcludingHard: number;
  termRecall: number;
  termPrecision: number;
  f1: number;
  falsePositiveRate: number;
  falsePositiveRateExcludingHard: number;
  /** Term recall/precision restricted to the lang-tagged subset, when the corpus has one. */
  nonEnglishRecall?: number;
  nonEnglishPrecision?: number;
}

export function sweep(cases: BenchCase[], lexicon: Lexicon, base: Omit<BenchOptions, 'minConfidence' | 'timing'> = {}): SweepRow[] {
  return SWEEP_STEPS.map((minConfidence) => {
    const r = runBench(cases, lexicon, { ...base, minConfidence, timing: false });
    return {
      minConfidence,
      positiveAccuracy: r.sentence.positives.rate,
      positiveAccuracyExcludingHard: r.sentence.positivesExcludingHard.rate,
      termRecall: r.terms.recall.rate,
      termPrecision: r.terms.precision.rate,
      f1: r.terms.f1,
      falsePositiveRate: r.falsePositiveRate.rate,
      falsePositiveRateExcludingHard: r.falsePositiveRateExcludingHard.rate,
      ...(r.lang
        ? { nonEnglishRecall: r.lang.nonEnglish.recall.rate, nonEnglishPrecision: r.lang.nonEnglish.precision.rate }
        : {}),
    };
  });
}
