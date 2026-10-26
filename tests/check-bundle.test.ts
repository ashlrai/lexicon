import { describe, expect, it } from 'vitest';
import { capDiff } from '../scripts/check-bundle.mjs';

describe('bundle diff reporting', () => {
  it('keeps diffs up to 400 lines intact', () => {
    const diff = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(capDiff(diff)).toBe(diff);
  });

  it('caps longer diffs at 400 lines and names the full patch artifact', () => {
    const diff = Array.from({ length: 405 }, (_, i) => `line ${i + 1}`).join('\n');
    const result = capDiff(diff);
    expect(result.split('\n').slice(0, 400)).toEqual(Array.from({ length: 400 }, (_, i) => `line ${i + 1}`));
    expect(result).toContain('truncated after 400 lines');
    expect(result).toContain('artifacts/bundle-diff.patch');
    expect(result).not.toContain('line 401');
  });
});
