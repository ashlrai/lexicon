import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('DeepWiki configuration', () => {
  it('has bounded notes and a valid page hierarchy', () => {
    const config = JSON.parse(readFileSync('.devin/wiki.json', 'utf8'));
    expect(Array.isArray(config.repo_notes)).toBe(true);
    expect(config.repo_notes.length).toBeGreaterThan(0);
    expect(config.repo_notes.length).toBeLessThanOrEqual(100);
    for (const note of config.repo_notes) {
      expect(typeof note.content).toBe('string');
      expect(note.content.length).toBeGreaterThan(0);
      expect(note.content.length).toBeLessThanOrEqual(10_000);
    }
    expect(Array.isArray(config.pages)).toBe(true);
    expect(config.pages.length).toBeGreaterThan(0);
    expect(config.pages.length).toBeLessThanOrEqual(30);
    const titles = config.pages.map((page: { title: string }) => page.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const page of config.pages) {
      expect(typeof page.title).toBe('string');
      expect(page.title.trim()).not.toBe('');
      expect(typeof page.purpose).toBe('string');
      expect(page.purpose.trim()).not.toBe('');
      const seen = new Set([page.title]);
      let parent = page.parent;
      while (parent !== undefined) {
        expect(titles).toContain(parent);
        expect(seen.has(parent)).toBe(false);
        seen.add(parent);
        parent = config.pages.find((candidate: { title: string }) => candidate.title === parent).parent;
      }
    }
  });
});
