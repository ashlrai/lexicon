import { describe, expect, it } from 'vitest';
import { suggestAliases } from '../src/core/suggest.js';

describe('suggestAliases', () => {
  it('suggests the headline Ashlr.AI misspellings', () => {
    const out = suggestAliases('Ashlr.AI');
    expect(out).toEqual(expect.arrayContaining(['Ashler', 'Ashlar', 'Ashlr AI']));
    expect(out).toContain('Ashlr');
  });

  it('splits camelCase', () => {
    expect(suggestAliases('OpenClaw')).toContain('Open Claw');
    expect(suggestAliases('PostgreSQL')).toContain('Postgre SQL');
  });

  it('handles acronyms: pronounced and spelled forms', () => {
    const out = suggestAliases('SaaS');
    expect(out).toContain('sass');
    expect(out).toContain('S a a S');
    expect(out[0]).not.toBe('Saa S');
  });

  it('applies common phoneme confusions', () => {
    expect(suggestAliases('Kubernetes')).toContain('Cubernetes');
    expect(suggestAliases('Pydantic')).toEqual(expect.arrayContaining(['Pidantic', 'Pydantik']));
    expect(suggestAliases('Phanto')).toContain('Fanto');
    expect(suggestAliases('Hassler')).toContain('Hasler');
  });

  it('is deterministic, capped at 8, unique, and never returns the canonical or empties', () => {
    for (const c of ['Ashlr.AI', 'OpenClaw', 'SaaS', 'Kubernetes', 'Pydantic', 'Hetzner', 'Anthropic', 'Cloudflare-Workers', 'x']) {
      const a = suggestAliases(c);
      const b = suggestAliases(c);
      expect(a).toEqual(b);
      expect(a.length).toBeLessThanOrEqual(8);
      expect(new Set(a.map((s) => s.toLowerCase())).size).toBe(a.length);
      expect(a.map((s) => s.toLowerCase())).not.toContain(c.toLowerCase());
      for (const s of a) expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it('returns an empty list for blank input', () => {
    expect(suggestAliases('')).toEqual([]);
    expect(suggestAliases('   ')).toEqual([]);
  });
});
