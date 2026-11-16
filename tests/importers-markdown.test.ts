import { describe, expect, it } from 'vitest';
import { importLexicon } from '../src/core/importers/index.js';

describe('markdown importer', () => {
  it('imports empty input without terms or errors', () => {
    const result = importLexicon('', 'markdown');

    expect(result.format).toBe('markdown');
    expect(result.terms).toEqual([]);
    expect(result.skipped).toEqual([]);
  });
});
