/**
 * Exports that must fit a target's own limits (a prompt window, a list size,
 * a phrase length) or its parser (spreadsheet formulas, YAML scalars,
 * duplicate triggers), and the notes that name what was left out.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

  // Catches: names past the default 100-name cap were left out without a
  // word: the window note counted only the first 100, so 150 short names
  // that fit 74 said "left out 26 names" when 76 were.
  it('names past the default 100-name cap are counted in a note too', () => {
    const terms: Term[] = Array.from({ length: 150 }, (_, i) => ({ canonical: `Q${String(i).padStart(3, '0')}`, aliases: [], hits: 1000 - i }));
    const { text, notes } = exportLexiconWithNotes(lex(terms), 'whisper-prompt');
    const kept = text.split(', ').length;
    const counted = notes.map((n) => Number(/^left out (\d+) name/.exec(n)?.[1] ?? 0)).reduce((a, b) => a + b, 0);
    expect(kept + counted).toBe(150);
    // The names the line holds, for `lexicon export --json`'s `terms`.
    expect(exportLexiconWithNotes(lex(terms), 'whisper-prompt').names).toBe(kept);
    expect(exportLexiconWithNotes(lex(terms), 'openai').names).toBe(kept);
    expect(notes.some((n) => n.startsWith('left out 50 names past the 100 a prompt holds by default') && n.includes('"Q100"'))).toBe(true);
    // An explicit --limit is what was asked for: no note for it.
    expect(exportLexiconWithNotes(lex(terms.slice(0, 5)), 'whisper-prompt', { limit: 2 }).notes).toEqual([]);
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

describe('google and azure: phrase-set limits', () => {
  const many = (n: number): Term[] => Array.from({ length: n }, (_, i) => ({ canonical: `Name${String(i).padStart(4, '0')}`, aliases: [], hits: n - i }));

  // Catches: every canonical was written, so a large lexicon or one long name
  // exported a request the API refuses whole.
  it('google: drops a phrase over 100 characters and caps the list at 1000', () => {
    const long = 'x'.repeat(101);
    const { text, notes } = exportLexiconWithNotes(lex([...many(1001), { canonical: long, aliases: [], hits: 5000 }]), 'google');
    const phrases = (JSON.parse(text) as { adaptation: { phraseSets: { phrases: { value: string }[] }[] } }).adaptation.phraseSets[0].phrases;
    expect(phrases).toHaveLength(1000);
    expect(phrases[0].value).toBe('Name0000');
    expect(phrases.some((p) => p.value === long)).toBe(false);
    expect(notes[0]).toBe(`left out 1 phrase over Google's 100 characters per phrase: "${long}"`);
    expect(notes[1]).toContain('left out 1 phrase past the 1000 kept');
    expect(notes[1]).toContain('"Name1000"');
    // 100 characters (code points) is still fine.
    const ok = exportLexiconWithNotes(lex([{ canonical: 'é'.repeat(100), aliases: [] }]), 'google');
    expect(ok.notes).toEqual([]);
  });

  it('azure: caps phraseList at 500, the most used kept', () => {
    const { text, notes } = exportLexiconWithNotes(lex(many(502)), 'azure');
    const { phraseList } = JSON.parse(text) as { phraseList: string[] };
    expect(phraseList).toHaveLength(500);
    expect(phraseList[499]).toBe('Name0499');
    expect(notes).toEqual([`left out 2 phrases past the 500 kept (the most used; the phrase list size Azure documents): "Name0500" and "Name0501"`]);
    expect(exportLexiconWithNotes(lex(many(3)), 'azure').notes).toEqual([]);
  });
});

describe('assemblyai: words per phrase', () => {
  // Catches: a canonical over the per-phrase word limit was sent, and the
  // 1,000-entry cap dropped names with no word of which.
  it('leaves out a phrase over 6 words and names it', () => {
    const seven = 'one two three four five six seven';
    const { text, notes } = exportLexiconWithNotes(lex([{ canonical: seven, aliases: [] }, { canonical: 'one two three four five six', aliases: [] }]), 'assemblyai');
    expect((JSON.parse(text) as { word_boost: string[] }).word_boost).toEqual(['one two three four five six']);
    expect(notes).toEqual([`left out 1 phrase over AssemblyAI's 6 words per phrase: "${seven}"`]);
  });

  it('names what the 1,000-entry cap left out', () => {
    const terms = Array.from({ length: 1001 }, (_, i) => ({ canonical: `N${String(i).padStart(4, '0')}`, aliases: [], hits: 2000 - i }));
    const { notes } = exportLexiconWithNotes(lex(terms), 'assemblyai');
    expect(notes).toEqual([`left out 1 phrase past AssemblyAI's 1000 word_boost entries (the most used kept): "N1000"`]);
  });
});

describe('deepgram: keyterm for Nova-3, deduped keywords', () => {
  // Catches: only `keywords` was written, which Nova-3 does not take, and two
  // canonicals that read alike once the colon is a space were both sent.
  it('writes keyterm as written and keywords once per spelling', () => {
    const { text, notes } = exportLexiconWithNotes(
      lex([
        { canonical: 'Win 2', aliases: [], category: 'brand', hits: 5 },
        { canonical: 'Win:2', aliases: [], hits: 1 },
      ]),
      'deepgram',
    );
    expect(JSON.parse(text)).toEqual({ keyterm: ['Win 2', 'Win:2'], keywords: ['Win 2:2'] });
    expect(notes).toEqual(['left out 1 name from keywords that read as one already listed once its colon is a space: "Win:2"']);
  });

  // Catches: keyterm collapsed whitespace but kept every entry, so canonicals
  // that differ only in whitespace were sent as the same keyterm twice and
  // each took a place under the 100 cap.
  it('writes a keyterm once when canonicals differ only in whitespace, and caps the distinct ones', () => {
    const { text, notes } = exportLexiconWithNotes(
      lex([
        { canonical: 'Ashlr AI', aliases: [], hits: 9 },
        { canonical: 'Ashlr  AI', aliases: [], hits: 5 },
        { canonical: 'Ashlr\u00a0AI', aliases: [], hits: 1 },
      ]),
      'deepgram',
    );
    expect((JSON.parse(text) as { keyterm: string[] }).keyterm).toEqual(['Ashlr AI']);
    expect(notes).toContain('left out 2 names from keyterm that read as one already listed once whitespace is collapsed: "Ashlr  AI" and "Ashlr\u00a0AI"');
    const many = [{ canonical: 'K 000', aliases: [], hits: 1000 }, { canonical: 'K  000', aliases: [], hits: 999 }, ...Array.from({ length: 100 }, (_, i) => ({ canonical: `K${String(i + 1).padStart(3, '0')}`, aliases: [], hits: 500 - i }))];
    const capped = (JSON.parse(exportLexiconWithNotes(lex(many), 'deepgram').text) as { keyterm: string[] }).keyterm;
    expect(new Set(capped).size).toBe(100);
    expect(capped).toContain('K099');
  });

  it('caps keyterm at 100, the most used kept', () => {
    const terms = Array.from({ length: 101 }, (_, i) => ({ canonical: `K${String(i).padStart(3, '0')}`, aliases: [], hits: 500 - i }));
    const { text, notes } = exportLexiconWithNotes(lex(terms), 'deepgram');
    const out = JSON.parse(text) as { keyterm: string[]; keywords: string[] };
    expect(out.keyterm).toHaveLength(100);
    expect(out.keywords).toHaveLength(101);
    expect(notes).toEqual(['left out 1 name from keyterm past the 100 kept (the most used; a conservative cap for Nova-3 keyterms): "K100"']);
  });
});

describe('csv and wispr: spreadsheet formulas', () => {
  const risky = lex([
    { canonical: '=HYPERLINK("http://x","y")', aliases: ['hyperlink'] },
    { canonical: 'Ashlr.AI', aliases: ['+cmd', 'Ashler', '@sum', '-x'], category: 'brand', phonetic: '=1+1' },
  ]);

  // Catches: a name starting with = + - @ was written as is, so opening the
  // CSV in a spreadsheet ran it as a formula.
  it('csv writes formula cells as text with a leading quote, and counts them', () => {
    const { text, notes } = exportLexiconWithNotes(risky, 'csv');
    const rows = text.trimEnd().split('\n');
    expect(rows[1]).toBe(`"'=HYPERLINK(""http://x"",""y"")",hyperlink,,`);
    expect(rows[2]).toBe(`Ashlr.AI,"'+cmd",brand,"'=1+1"`);
    expect(rows).toContain(`Ashlr.AI,Ashler,brand,"'=1+1"`);
    for (const row of rows.slice(1)) for (const cell of row.split(',')) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    expect(text.startsWith('﻿')).toBe(false);
    expect(text.includes('\r\n')).toBe(false);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("wrote 5 values a spreadsheet would run as a formula with a leading '");
  });

  it('wispr leaves out pairs a spreadsheet would run, and keeps the rest as written', () => {
    const { text, notes, rows } = exportLexiconWithNotes(risky, 'wispr');
    expect(text).toBe('word,replacement\nAshler,Ashlr.AI\n');
    // `lexicon export --json` reports the rows written, not the aliases.
    expect(rows).toBe(1);
    expect(notes).toEqual([
      'left out 4 pairs a spreadsheet would run as a formula (a cell starting with = + - @, after any spaces, or with a tab or a carriage return): "hyperlink -> =HYPERLINK(\\"http://x\\",\\"y\\")", "+cmd -> Ashlr.AI", "@sum -> Ashlr.AI" and "-x -> Ashlr.AI"',
    ]);
  });

  // Catches: only the first character was checked, so ` =HYPERLINK(...)`
  // (a spreadsheet trims the space on import, then runs the rest) was written
  // as is.
  it('a formula after leading spaces or a tab is guarded too', () => {
    const spaced = lex([{ canonical: '  =HYPERLINK("http://x")', aliases: ['hyper'], phonetic: ' \t+1' }, { canonical: 'Ashlr.AI', aliases: ['Ashler'] }]);
    const csv = exportLexiconWithNotes(spaced, 'csv');
    expect(csv.text.split('\n')[1]).toBe(`"'  =HYPERLINK(""http://x"")",hyper,,"' \t+1"`);
    expect(csv.notes[0]).toContain('wrote 2 values');
    const wispr = exportLexiconWithNotes(spaced, 'wispr');
    expect(wispr.text).toBe('word,replacement\nAshler,Ashlr.AI\n');
    expect(wispr.notes).toHaveLength(1);
    // A space inside a name is not a formula.
    expect(exportLexiconWithNotes(lex([{ canonical: 'A = B', aliases: ['a b'] }]), 'csv').notes).toEqual([]);
  });

  it('a lexicon with no such cells has no note', () => {
    expect(exportLexiconWithNotes(lex([{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }]), 'csv').notes).toEqual([]);
  });
});

describe('espanso and macos: ambiguous scalars and shared triggers', () => {
  // Catches: a plain scalar such as `yes`, `on`, `~` or `0o7` was written
  // unquoted, so a YAML 1.1 reader (or 1.2, for `0o7`) read a boolean, null
  // or number instead of the trigger or name.
  it('espanso double-quotes every string, so any YAML version reads it as text', () => {
    const ambiguous = ['yes', 'No', 'on', 'OFF', 'y', 'null', '~', '0o7', '1_000', '1:20', '.inf', '2001-12-14', 'true'];
    const text = exportLexicon(lex(ambiguous.map((a, i) => ({ canonical: ambiguous[(i + 1) % ambiguous.length], aliases: [a] }))), 'espanso');
    for (const a of ambiguous) expect(text).toContain(`trigger: ${JSON.stringify(a)}`);
    expect(text).toMatch(/word: true\n/);
    expect(text).not.toMatch(/(trigger|replace): [^"]/);
    const parsed = parseYaml(text, { version: '1.1' }) as { matches: { trigger: unknown; replace: unknown }[] };
    expect(parsed.matches.map((m) => m.trigger)).toEqual(ambiguous);
    expect(parsed.matches.every((m) => typeof m.replace === 'string')).toBe(true);
  });

  const shared = lex([
    { canonical: 'Zeta Corp', aliases: ['zeta', 'zed'] },
    { canonical: 'Zeta', aliases: ['zeta', 'Zed'], category: 'brand' },
  ]);

  // Catches: two terms sharing an alias wrote one trigger (or shortcut)
  // twice, which the tool expands to either.
  it('espanso writes a shared trigger once, for the term ranked first, whatever the file order', () => {
    for (const l of [shared, { ...shared, terms: [...shared.terms].reverse() }]) {
      const { text, notes, rows } = exportLexiconWithNotes(l, 'espanso');
      const matches = (parseYaml(text) as { matches: { trigger: string; replace: string }[] }).matches;
      expect(matches.filter((m) => m.trigger === 'zeta')).toEqual([expect.objectContaining({ replace: 'Zeta' })]);
      // Triggers are matched as written: `zed` and `Zed` are two.
      expect(matches.map((m) => m.trigger).sort()).toEqual(['Zed', 'zed', 'zeta']);
      expect(rows).toBe(3);
      expect(notes).toEqual(['left out 1 trigger another term already uses (the more used term keeps it): "zeta -> Zeta Corp"']);
    }
  });

  it('macos writes a shared shortcut once, compared ignoring case', () => {
    const { text, notes, rows } = exportLexiconWithNotes(shared, 'macos');
    expect((text.match(/<dict>/g) ?? []).length).toBe(2);
    expect(rows).toBe(2);
    expect(text).toContain('<string>Zeta</string>\n\t\t<key>shortcut</key>\n\t\t<string>zeta</string>');
    expect(text).toContain('<string>Zeta</string>\n\t\t<key>shortcut</key>\n\t\t<string>Zed</string>');
    expect(notes).toEqual(['left out 2 shortcuts another term already uses (the more used term keeps it): "zeta -> Zeta Corp" and "zed -> Zeta Corp"']);
  });

  // Catches: wispr and superwhisper wrote a shared alias once per term, so
  // the app replaced the word with either canonical.
  it('wispr and superwhisper write a shared alias once, for the term ranked first, whatever the file order', () => {
    for (const l of [shared, { ...shared, terms: [...shared.terms].reverse() }]) {
      const wispr = exportLexiconWithNotes(l, 'wispr');
      const rows = wispr.text.trimEnd().split('\n').slice(1);
      expect(rows.filter((r) => r.startsWith('zeta,'))).toEqual(['zeta,Zeta']);
      expect(rows.map((r) => r.split(',')[0]).sort()).toEqual(['Zed', 'zed', 'zeta']);
      expect(wispr.rows).toBe(3);
      expect(wispr.notes).toEqual(['left out 1 word another term already uses (the more used term keeps it): "zeta -> Zeta Corp"']);

      const sw = exportLexiconWithNotes(l, 'superwhisper');
      const entries = JSON.parse(sw.text) as { original: string; replacement: string }[];
      expect(entries.filter((e) => e.original === 'zeta')).toEqual([{ original: 'zeta', replacement: 'Zeta' }]);
      expect(sw.rows).toBe(3);
      expect(sw.notes).toEqual(['left out 1 replacement another term already uses (the more used term keeps it): "zeta -> Zeta Corp"']);
    }
  });

  it('wispr: a pair left out as a formula does not take a shared word from the term that can keep it', () => {
    const l = lex([
      { canonical: '=Zeta', aliases: ['zeta'], category: 'brand', hits: 9 },
      { canonical: 'Zeta Corp', aliases: ['zeta'] },
    ]);
    const { text, notes } = exportLexiconWithNotes(l, 'wispr');
    expect(text).toBe('word,replacement\nzeta,Zeta Corp\n');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('"zeta -> =Zeta"');
  });
});

describe('macos: control characters', () => {
  // Catches: a C0 control character from a lexicon built in memory was
  // written into the plist, which XML 1.0 cannot hold, so the whole file
  // failed to load.
  it('removes C0 controls but tab, LF and CR, and skips a pair left empty', () => {
    const { text, notes, rows } = exportLexiconWithNotes(
      lex([
        { canonical: 'Ashlr\u0007.AI', aliases: ['Ash\u0000ler'] },
        { canonical: 'Bell', aliases: ['\u001b'] },
        { canonical: 'Tab\tName', aliases: ['tabby'] },
      ]),
      'macos',
    );
    expect(text).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    expect(text).toContain('<string>Ashlr.AI</string>');
    expect(text).toContain('<string>Ashler</string>');
    expect(text).toContain('<string>Tab\tName</string>');
    expect(text).not.toContain('Bell');
    expect(rows).toBe(2);
    expect(notes).toEqual(['removed control characters XML cannot hold from 2 entries (a pair left with an empty shortcut or phrase is not written)']);
  });
});

describe('claude-md within a character budget', () => {
  // Catches: when header and footer alone passed maxChars the text was cut
  // at a fixed code unit, which could fall between the halves of a
  // surrogate pair and leave an unpaired surrogate (not valid UTF-8).
  it('never splits a surrogate pair when it cuts', async () => {
    const { exportClaudeMdWithin } = await import('../src/core/exporters/index.js');
    const l = lex([{ canonical: '😀 Smile', aliases: ['smile'] }]);
    const more = (): string => `${'😀'.repeat(150)} more`;
    for (let max = 0; max < 600; max++) {
      const { text } = exportClaudeMdWithin(l, max, more);
      expect(text.length, String(max)).toBeLessThanOrEqual(max);
      expect(text, String(max)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});

describe('json: the lexicon file, not the merged view', () => {
  // Catches: `scope` and `hits`, which loadLexicon adds to the merged view
  // and no lexicon file holds, were written into the export, so a backup
  // changed after every corrected prompt and an import carried this
  // machine's counts.
  it('leaves scope and hits out and keeps every file field', () => {
    const merged = lex([{ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand', notes: 'n', phonetic: 'p', scope: 'project', hits: 42 }]);
    const out = JSON.parse(exportLexicon(merged, 'json')) as Lexicon;
    expect(out).toEqual(lex([{ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand', notes: 'n', phonetic: 'p' }]));
    expect(exportLexicon({ ...merged, terms: [{ ...merged.terms[0], hits: 43 }] }, 'json')).toBe(exportLexicon(merged, 'json'));
  });
});
