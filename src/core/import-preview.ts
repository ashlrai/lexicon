import { createHash } from 'node:crypto';
import type { HarvestCandidate } from './types.js';

/** The complete candidate data shown to a user before import. */
export function importCandidatePreview(candidate: HarvestCandidate) {
  return {
    canonical: candidate.canonical,
    category: candidate.category,
    source: candidate.source,
    aliases: [...candidate.suggestedAliases],
    evidence: [...candidate.evidence],
    count: candidate.count,
  };
}

export function importCandidateId(candidate: HarvestCandidate): string {
  return createHash('sha256').update(JSON.stringify(importCandidatePreview(candidate))).digest('hex');
}

/** Bind approval to the sources, destination and every previewed candidate. */
export function importPreviewDigest(sources: readonly string[], candidates: readonly HarvestCandidate[], destination: string): string {
  return createHash('sha256').update(JSON.stringify({
    sources: [...new Set(sources)].sort(), destination,
    candidates: candidates.map(importCandidatePreview),
  })).digest('hex');
}

/** Refuse unknown ids instead of silently importing all or a changed list. */
export function selectImportCandidates(candidates: readonly HarvestCandidate[], approvedIds: readonly string[]): HarvestCandidate[] {
  const byId = new Map(candidates.map((candidate) => [importCandidateId(candidate), candidate]));
  for (const id of approvedIds) {
    if (!byId.has(id)) throw new Error('approved candidate is absent from the preview; preview again before importing');
  }
  return [...new Set(approvedIds)].map((id) => byId.get(id)!);
}
