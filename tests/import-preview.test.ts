/**
 * The guided import shows a user the exact candidates before anything is
 * written, and binds their approval to a digest of that preview. These pin
 * src/core/import-preview.ts: what a preview shows, how ids and the digest
 * react to change, and that an approval naming an unknown candidate is refused
 * instead of silently importing a different list.
 */
import { describe, expect, it } from 'vitest';
import {
  importCandidateId,
  importCandidatePreview,
  importPreviewDigest,
  selectImportCandidates,
} from '../src/core/import-preview.js';
import type { HarvestCandidate } from '../src/core/types.js';

function candidate(overrides: Partial<HarvestCandidate> = {}): HarvestCandidate {
  return {
    canonical: 'Ashlr.AI',
    category: 'product',
    source: 'harvest:git',
    evidence: ['git log'],
    count: 3,
    suggestedAliases: ['Ashler'],
    ...overrides,
  };
}

describe('importCandidatePreview', () => {
  it('shows every previewed field, with aliases taken from suggestedAliases', () => {
    const c = candidate({ evidence: ['a.md', 'b.md'], count: 7, suggestedAliases: ['Ashler', 'Ashlar'] });
    expect(importCandidatePreview(c)).toEqual({
      canonical: 'Ashlr.AI',
      category: 'product',
      source: 'harvest:git',
      aliases: ['Ashler', 'Ashlar'],
      evidence: ['a.md', 'b.md'],
      count: 7,
    });
  });

  it('returns copies of the alias and evidence arrays, so editing a preview never edits the candidate', () => {
    const c = candidate();
    const preview = importCandidatePreview(c);
    preview.aliases.push('Ashlur');
    preview.evidence.push('extra');
    expect(c.suggestedAliases).toEqual(['Ashler']);
    expect(c.evidence).toEqual(['git log']);
  });

  it('keeps empty alias and evidence lists empty rather than dropping them', () => {
    const preview = importCandidatePreview(candidate({ evidence: [], suggestedAliases: [] }));
    expect(preview.aliases).toEqual([]);
    expect(preview.evidence).toEqual([]);
  });
});

describe('importCandidateId', () => {
  it('is a 64-character lowercase sha256 hex digest and is stable for the same candidate', () => {
    const id = importCandidateId(candidate());
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(importCandidateId(candidate())).toBe(id);
  });

  it('changes when any previewed field changes, so a changed candidate cannot reuse an old approval', () => {
    const base = importCandidateId(candidate());
    expect(importCandidateId(candidate({ canonical: 'Ashlr' }))).not.toBe(base);
    expect(importCandidateId(candidate({ category: 'person' }))).not.toBe(base);
    expect(importCandidateId(candidate({ source: 'import:contacts' }))).not.toBe(base);
    expect(importCandidateId(candidate({ count: 4 }))).not.toBe(base);
    expect(importCandidateId(candidate({ evidence: ['other'] }))).not.toBe(base);
    expect(importCandidateId(candidate({ suggestedAliases: [] }))).not.toBe(base);
  });
});

describe('importPreviewDigest', () => {
  const list = [candidate(), candidate({ canonical: 'Vercel', category: 'brand', source: 'harvest:package' })];

  it('does not depend on the order or repetition of the source list', () => {
    const one = importPreviewDigest(['/repo', '/notes'], list, 'global');
    expect(importPreviewDigest(['/notes', '/repo'], list, 'global')).toBe(one);
    expect(importPreviewDigest(['/notes', '/repo', '/repo'], list, 'global')).toBe(one);
  });

  it('changes when the destination, a source or a previewed candidate changes', () => {
    const base = importPreviewDigest(['/repo'], list, 'global');
    expect(importPreviewDigest(['/repo'], list, 'project')).not.toBe(base);
    expect(importPreviewDigest(['/other'], list, 'global')).not.toBe(base);
    expect(importPreviewDigest(['/repo'], [list[0]], 'global')).not.toBe(base);
  });

  it('handles an empty preview, which still has a digest bound to its sources and destination', () => {
    const empty = importPreviewDigest([], [], 'global');
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
    expect(importPreviewDigest([], [], 'project')).not.toBe(empty);
  });
});

describe('selectImportCandidates', () => {
  const first = candidate();
  const second = candidate({ canonical: 'Vercel', category: 'brand', source: 'harvest:package' });
  const candidates = [first, second];

  it('returns the approved candidates in approval order', () => {
    const ids = [importCandidateId(second), importCandidateId(first)];
    expect(selectImportCandidates(candidates, ids)).toEqual([second, first]);
  });

  it('returns each approved candidate once when an id is repeated, and an empty list approves nothing', () => {
    const id = importCandidateId(first);
    expect(selectImportCandidates(candidates, [id, id])).toEqual([first]);
    expect(selectImportCandidates(candidates, [])).toEqual([]);
  });

  it('refuses the whole approval when any id is not in the preview, instead of importing a partial or different list', () => {
    const ids = [importCandidateId(first), 'f'.repeat(64)];
    expect(() => selectImportCandidates(candidates, ids)).toThrow(
      'approved candidate is absent from the preview; preview again before importing',
    );
  });
});
