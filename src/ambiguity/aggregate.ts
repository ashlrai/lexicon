/**
 * Aggregator - merges per-detector findings, dedupes overlaps, computes
 * calibrated ensemble confidence. Ported from Pellucid
 * (apps/api/app/agents/aggregator.py). Pure functions, no IO.
 *
 * Algorithm:
 *   1. Start with every rule-layer finding (high precision baseline).
 *   2. Collect every detector finding; group findings by overlapping span.
 *   3. Per cluster, pick the highest-severity finding as canonical and merge.
 *   4. Calibrate confidence from the cluster's signals: additional sources,
 *      AGREE/DISAGREE votes, rule-layer corroboration, max severity.
 */
import { defaultCalibrator } from './calibrate.js';
import type { AmbiguityFinding, DetectorReport, FindingVote, Severity } from './types.js';
import { SOURCE_ENSEMBLE, SOURCE_RULES } from './types.js';

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function overlaps(a: AmbiguityFinding, b: AmbiguityFinding): boolean {
  return !(a.end <= b.start || b.end <= a.start);
}

/**
 * Produce the final de-duplicated finding list with calibrated ensemble
 * confidence, sorted by span.
 *
 * @param ruleFindings findings from the deterministic rule layer
 * @param reports      one DetectorReport per detector (findings + reasoning)
 * @param votes        AGREE/DISAGREE votes detectors cast on each other
 * @param calibrator   optional ConfidenceCalibrator override (defaults to the
 *                     synthetic-prior defaultCalibrator())
 */
export function aggregateFindings(
  ruleFindings: readonly AmbiguityFinding[],
  reports: readonly DetectorReport[],
  votes: readonly FindingVote[],
  calibrator = defaultCalibrator(),
): AmbiguityFinding[] {
  const all: Array<readonly [AmbiguityFinding, string]> = [
    ...ruleFindings.map((f) => [f, SOURCE_RULES] as const),
    ...reports.flatMap((r) => r.findings.map((f) => [f, r.source] as const)),
  ];

  // Greedy clustering by overlap, in span order.
  const clusters: Array<Array<readonly [AmbiguityFinding, string]>> = [];
  const sorted = [...all].sort((a, b) => a[0].start - b[0].start || a[0].end - b[0].end);
  for (const entry of sorted) {
    const cluster = clusters.find((c) => c.some(([f]) => overlaps(entry[0], f)));
    if (cluster) cluster.push(entry);
    else clusters.push([entry]);
  }

  // Map each (source, index-within-report) pair to its cluster so votes can
  // resolve to a span. Identity match first; two structurally identical
  // findings from one source resolve by position.
  const reportsBySource = new Map<string, DetectorReport>();
  for (const r of reports) reportsBySource.set(r.source, r);
  const voteTargetToCluster = new Map<string, number>();
  for (const [clusterIndex, cluster] of clusters.entries()) {
    for (const [f, source] of cluster) {
      const report = reportsBySource.get(source);
      if (!report) continue;
      const origIndex = report.findings.indexOf(f);
      if (origIndex >= 0) voteTargetToCluster.set(`${source}${origIndex}`, clusterIndex);
    }
  }

  const clusterAgree = new Array<number>(clusters.length).fill(0);
  const clusterDisagree = new Array<number>(clusters.length).fill(0);
  for (const vote of votes) {
    const clusterIndex = voteTargetToCluster.get(`${vote.targetSource}${vote.targetIndex}`);
    if (clusterIndex === undefined) continue;
    if (vote.agree) clusterAgree[clusterIndex] += 1;
    else clusterDisagree[clusterIndex] += 1;
  }

  const final: AmbiguityFinding[] = [];
  for (const [clusterIndex, cluster] of clusters.entries()) {
    const canonical = cluster.reduce((best, cur) =>
      SEVERITY_RANK[cur[0].severity] > SEVERITY_RANK[best[0].severity] ||
      (SEVERITY_RANK[cur[0].severity] === SEVERITY_RANK[best[0].severity] && cur[0].confidence > best[0].confidence)
        ? cur
        : best,
    )[0];
    const agentSources = new Set(cluster.map(([, s]) => s).filter((s) => s !== SOURCE_RULES));
    const ruleCorroborated = cluster.some(([, s]) => s === SOURCE_RULES);
    const maxSeverity = cluster.reduce<Severity>(
      (max, [f]) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[max] ? f.severity : max),
      'low',
    );

    final.push({
      start: canonical.start,
      end: canonical.end,
      text: canonical.text,
      type: canonical.type,
      severity: maxSeverity,
      rationale: combinedRationale(cluster),
      confidence: calibrator.calibrate({
        baseConfidence: canonical.confidence,
        agentCorroboration: Math.max(0, agentSources.size - 1),
        clusterAgree: clusterAgree[clusterIndex],
        clusterDisagree: clusterDisagree[clusterIndex],
        ruleCorroborated: ruleCorroborated && agentSources.size > 0,
        severity: maxSeverity,
      }),
      source: cluster.length === 1 ? canonical.source : SOURCE_ENSEMBLE,
      suggestion: canonical.suggestion,
    });
  }
  return final.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** One rationale for a merged cluster: "[source] reason" per source, deduped. */
function combinedRationale(cluster: ReadonlyArray<readonly [AmbiguityFinding, string]>): string {
  if (cluster.length === 1) return cluster[0][0].rationale;
  const seen = new Map<string, string>();
  for (const [f, source] of cluster) seen.set(source, f.rationale);
  return [...seen].flatMap(([source, rationale]) => (rationale ? [`[${source}] ${rationale}`] : [])).join(' | ');
}
