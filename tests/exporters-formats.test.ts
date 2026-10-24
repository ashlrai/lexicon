/**
 * Per-format rules of the exports: NFC spellings and API size limits.
 * Exported spellings are in NFC: the form typed and transcribed text uses,
 * and the one the store compares under. A decomposed accent in the file
 * (`Cafe` plus U+0301) must not reach a trigger or a boost list as is.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { exportLexicon } from '../src/core/exporters/index.js';
import type { Lexicon } from '../src/core/types.js';

const NFD = 'Café Olé';
const NFC = NFD.normalize('NFC');

const lexicon: Lexicon = {
  version: 1,
  terms: [
    // One alias in both forms, as a hand-edited file can hold it.
    { canonical: NFD, aliases: ['kafay olay', 'café olé', 'café olé'], category: 'brand' },
    // The same name again in the other form (a second term).
    { canonical: NFC, aliases: [], category: 'brand' },
  ],
};

describe('exports in NFC', () => {
  // Catches: aliasPairs and the boost lists wrote the file's form, so a
  // decomposed trigger never fired on precomposed text, one alias in two
  // forms wrote two rows, and one name in two forms was boosted twice.
  it('writes triggers and replacements in NFC, one row per spelling', () => {
    const superwhisper = JSON.parse(exportLexicon(lexicon, 'superwhisper')) as { original: string; replacement: string }[];
    expect(superwhisper).toEqual([
      { original: 'kafay olay', replacement: NFC },
      { original: 'café olé', replacement: NFC },
    ]);
    const csv = exportLexicon(lexicon, 'wispr');
    expect(csv).toBe(`word,replacement\nkafay olay,${NFC}\ncafé olé,${NFC}\n`);
    const espanso = parseYaml(exportLexicon(lexicon, 'espanso')) as { matches: { trigger: string; replace: string }[] };
    expect(espanso.matches.map((m) => m.trigger)).toEqual(['kafay olay', 'café olé']);
    expect(espanso.matches.every((m) => m.replace === NFC)).toBe(true);
    const plist = exportLexicon(lexicon, 'macos');
    expect(plist.normalize('NFC')).toBe(plist);
    expect(plist.match(/<key>shortcut<\/key>/g)).toHaveLength(2);
    expect(exportLexicon(lexicon, 'csv').normalize('NFC')).toBe(exportLexicon(lexicon, 'csv'));
  });

  it('lists each name once, in NFC, for an engine boost or prompt', () => {
    expect(JSON.parse(exportLexicon(lexicon, 'assemblyai'))).toEqual({ word_boost: [NFC], boost_param: 'high' });
    expect(JSON.parse(exportLexicon(lexicon, 'azure'))).toEqual({ phraseList: [NFC] });
    expect(JSON.parse(exportLexicon(lexicon, 'google'))).toEqual({ adaptation: { phraseSets: [{ phrases: [{ value: NFC, boost: 20 }] }] } });
    expect(JSON.parse(exportLexicon(lexicon, 'deepgram'))).toEqual({ keywords: [`${NFC}:2`] });
    expect(exportLexicon(lexicon, 'whisper-prompt')).toBe(NFC);
    expect(exportLexicon(lexicon, 'openai')).toBe(NFC);
  });

  // The raw formats keep the file's own text: json is a backup, text and
  // markdown are read back, and claude-md is what the agent sees.
  it('leaves the raw lexicon JSON exactly as stored', () => {
    expect(JSON.parse(exportLexicon(lexicon, 'json'))).toEqual(lexicon);
  });
});

describe('format size limits', () => {
  // Catches: word_boost listed every canonical, though AssemblyAI takes at
  // most 1,000 entries and refuses a longer list, so a large lexicon
  // exported a request the API rejects.
  it('keeps the AssemblyAI word_boost list within the API limit, most important first', async () => {
    const { ASSEMBLYAI_WORD_BOOST_MAX } = await import('../src/core/exporters/assemblyai.js');
    expect(ASSEMBLYAI_WORD_BOOST_MAX).toBe(1000);
    const terms = Array.from({ length: 1500 }, (_, i) => ({ canonical: `Term${String(i).padStart(4, '0')}`, aliases: [], hits: i === 1400 ? 50 : 0 }));
    const out = JSON.parse(exportLexicon({ version: 1, terms }, 'assemblyai')) as { word_boost: string[] };
    expect(out.word_boost).toHaveLength(1000);
    expect(out.word_boost[0]).toBe('Term1400');
    expect(out.word_boost[1]).toBe('Term0000');
    expect(new Set(out.word_boost).size).toBe(1000);
  });
});
