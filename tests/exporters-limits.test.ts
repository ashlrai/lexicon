/**
 * Exports that must fit a target's own limits (a prompt window, a list size,
 * a phrase length) or its parser (spreadsheet formulas, YAML scalars,
 * duplicate triggers), and the notes that name what was left out.
 */
import { describe, expect, it } from 'vitest';
import { exportLexicon, exportLexiconWithNotes } from '../src/core/exporters/index.js';
import { WHISPER_PROMPT_TOKEN_BUDGET, estimateWhisperTokens } from '../src/core/exporters/whisperPrompt.js';
import type { Lexicon, Term } from '../src/core/types.js';

function lex(terms: Term[]): Lexicon {
  return { version: 1, terms };
}

describe('whisper-prompt and openai: the prompt window Whisper reads', () => {
  // Catches: the cap was 100 names whatever their length. Whisper keeps only
  // the last 224 tokens of a prompt and the names are written most important
  // first, so a long line lost exactly the names that mattered most.
  it('keeps the most important names within the token window and names the rest', () => {
    const terms: Term[] = Array.from({ length: 100 }, (_, i) => ({
      canonical: `Supercalifragilistic Name${String(i).padStart(3, '0')}`,
      aliases: [],
      hits: 1000 - i,
    }));
    for (const format of ['whisper-prompt', 'openai'] as const) {
      const { text, notes } = exportLexiconWithNotes(lex(terms), format);
      const names = text.split(', ');
      expect(names[0]).toBe('Supercalifragilistic Name000');
      expect(names.length).toBeLessThan(100);
      expect(estimateWhisperTokens(text)).toBeLessThanOrEqual(WHISPER_PROMPT_TOKEN_BUDGET);
      // Only the least important were dropped, in order.
      expect(names).toEqual(terms.slice(0, names.length).map((t) => t.canonical));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(`left out ${100 - names.length} names`);
      expect(notes[0]).toContain(`"Supercalifragilistic Name${String(names.length).padStart(3, '0')}"`);
    }
  });

  it('a short lexicon is written whole, with no note', () => {
    const { text, notes } = exportLexiconWithNotes(lex([{ canonical: 'Ashlr.AI', aliases: [] }, { canonical: 'kubectl', aliases: [] }]), 'whisper-prompt');
    expect(text).toBe('Ashlr.AI, kubectl');
    expect(notes).toEqual([]);
  });

  it('estimates high for names outside ASCII', () => {
    // One token per UTF-8 byte is the most byte-level BPE can take.
    expect(estimateWhisperTokens('東京')).toBe(6);
    expect(estimateWhisperTokens('Ashlr.AI')).toBeGreaterThanOrEqual(4);
    expect(exportLexicon(lex(Array.from({ length: 100 }, (_, i) => ({ canonical: `東京${i}`, aliases: [] }))), 'whisper-prompt').split(', ').length).toBeLessThan(40);
  });
});
