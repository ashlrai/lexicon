import { describe, expect, it } from 'vitest';
import { diffSummary, normalize } from '../src/core/normalize.js';
import type { Lexicon } from '../src/core/types.js';

const LEX: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashler AI'] },
    { canonical: 'Kubernetes', aliases: [] },
    { canonical: 'SaaS', aliases: [] },
  ],
};

describe('normalize', () => {
  it('rewrites aliases and reports changed', () => {
    const r = normalize('Ashler builds SaaS on Ashler AI.', LEX);
    expect(r.output).toBe('Ashlr.AI builds SaaS on Ashlr.AI.');
    expect(r.changed).toBe(true);
    expect(r.input).toBe('Ashler builds SaaS on Ashler AI.');
    expect(r.replacements).toHaveLength(2);
  });

  it('returns the input untouched when nothing matches', () => {
    const r = normalize('Nothing to see here.', LEX);
    expect(r.output).toBe(r.input);
    expect(r.changed).toBe(false);
    expect(r.replacements).toEqual([]);
  });

  it('preserves whitespace, punctuation and possessives around matches', () => {
    const r = normalize("  Ashler's\tteam,  ashlar!\n(Cooper Nettie's)  ", LEX);
    expect(r.output).toBe("  Ashlr.AI's\tteam,  Ashlr.AI!\n(Kubernetes)  ");
  });

  it('keeps the possessive and the following word on multi-token matches', () => {
    const lex: Lexicon = {
      version: 1,
      terms: [
        { canonical: 'Ashlr.AI', aliases: ['Ashler AI'] },
        { canonical: 'Kwame Mensah', aliases: [] },
        { canonical: 'normalizeTranscript', aliases: [] },
      ],
    };
    expect(normalize("ashler ai's dashboard is down", lex).output).toBe("Ashlr.AI's dashboard is down");
    expect(normalize("kwamay mensa's pr is waiting", lex).output).toBe("Kwame Mensah's pr is waiting");
    expect(normalize('refactor normalise transcript to take options', lex).output).toBe('refactor normalizeTranscript to take options');
  });

  it('leaves text that already reads as a canonical alone, even next to a sound-alike term', () => {
    const lex: Lexicon = {
      version: 1,
      terms: [
        { canonical: 'Tadeusz Wróblewski', aliases: [] },
        { canonical: 'TTS', aliases: ['tee tee ess'] },
        { canonical: 'Wispr Flow', aliases: ['whisper flow'] },
        { canonical: 'Whisper', aliases: [] },
      ],
    };
    for (const text of ['remind Tadeusz Wróblewski about the offsite', "Wispr Flow's dashboard shows zero traffic"]) {
      const r = normalize(text, lex);
      expect(r.output).toBe(text);
      expect(r.changed).toBe(false);
      expect(r.replacements).toEqual([]);
    }
    expect(normalize('ping tadeusz wroblewski', lex).output).toBe('ping Tadeusz Wróblewski');
  });

  it('dryRun returns candidates without applying them', () => {
    const r = normalize('Ashler builds things', LEX, { dryRun: true });
    expect(r.output).toBe(r.input);
    expect(r.changed).toBe(false);
    expect(r.replacements).toHaveLength(1);
    expect(r.replacements[0]).toMatchObject({ original: 'Ashler', replacement: 'Ashlr.AI' });
  });

  it('honours minConfidence and pass toggles from options', () => {
    expect(normalize("Cooper Nettie's", LEX, { phonetic: false }).changed).toBe(false);
    expect(normalize('Ashlet', LEX, { fuzzy: false }).changed).toBe(false);
    expect(normalize('Ashlet', LEX, { minConfidence: 0.95 }).changed).toBe(false);
    expect(normalize('Ashlet', LEX, { minConfidence: 0.8 }).output).toBe('Ashlr.AI');
  });

  it('honours settings on the lexicon', () => {
    const strict: Lexicon = { ...LEX, settings: { phonetic: false, fuzzy: false } };
    expect(normalize("Cooper Nettie's and Ashlet", strict).changed).toBe(false);
    expect(normalize('Ashler', strict).output).toBe('Ashlr.AI');
  });

  it('is idempotent', () => {
    const inputs = [
      "Ashler's plan for Cooper Nettie's and Ashler AI; sass for all. Ashlr.AI ok.",
      'ashlr ai and AshlrAI and Ashlr-AI',
      'Deploy `Ashler` to https://ashler.io now Ashler.',
    ];
    for (const text of inputs) {
      const once = normalize(text, LEX).output;
      const twice = normalize(once, LEX).output;
      expect(twice).toBe(once);
      expect(normalize(once, LEX).changed).toBe(false);
    }
  });

  it('keeps replacement offsets relative to the original input', () => {
    const text = 'Ashler and Ashler';
    const r = normalize(text, LEX);
    for (const rep of r.replacements) expect(text.slice(rep.start, rep.end)).toBe(rep.original);
  });
});

describe('diffSummary', () => {
  it('formats one line per replacement', () => {
    const r = normalize("Ashler AI met Cooper Nettie's", LEX);
    const lines = diffSummary(r).split('\n');
    expect(lines[0]).toBe('"Ashler AI" -> "Ashlr.AI" (alias, 1.00)');
    expect(lines[1]).toMatch(/^"Cooper Nettie's" -> "Kubernetes" \(phonetic, 0\.\d{2}\)$/);
  });

  it('says No changes. when empty', () => {
    expect(diffSummary(normalize('plain text', LEX))).toBe('No changes.');
  });
});
