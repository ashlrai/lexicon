// @vitest-environment jsdom
/**
 * The macos export parsed by a real XML parser (jsdom's DOMParser), which
 * the string checks in exporters.test.ts cannot stand in for.
 */
import { describe, expect, it } from 'vitest';
import { exportLexicon, exportLexiconWithNotes } from '../src/core/exporters/index.js';
import { findUnencodableChar } from '../src/core/schema.js';
import type { Lexicon } from '../src/core/types.js';

describe('macos export is XML a parser accepts', () => {
  // Catches: U+FFFE and U+FFFF pass the schema (they are neither control nor
  // invisible characters) but XML 1.0 forbids them even as character
  // references, so one such alias made the whole plist unreadable to
  // System Settings, every other replacement with it.
  it('macos: a pair XML cannot hold is left out and the plist still parses', () => {
    const lex: Lexicon = {
      version: 1,
      terms: [
        { canonical: 'Ashlr.AI', aliases: ['Ashler', 'bad\uFFFE'] },
        { canonical: 'Bad\uFFFFName', aliases: ['bee'] },
        { canonical: 'Vercel', aliases: ['Versel', 'lone\uD800'] },
      ],
    };
    const out = exportLexicon(lex, 'macos');
    const doc = new DOMParser().parseFromString(out, 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const strings = Array.from(doc.getElementsByTagName('string')).map((n) => n.textContent);
    expect(strings).toEqual(['Ashlr.AI', 'Ashler', 'Vercel', 'Versel']);
  });

  // Catches: the pairs left out for a character XML cannot hold were dropped
  // with no note, so the export read as complete.
  it('macos names the pairs it leaves out for a character XML cannot hold', () => {
    const lex: Lexicon = {
      version: 1,
      terms: [
        { canonical: 'Ashlr.AI', aliases: ['Ashler', 'bad\uFFFE'] },
        { canonical: 'Bad\uFFFFName', aliases: ['bee'] },
      ],
    };
    const { notes } = exportLexiconWithNotes(lex, 'macos');
    const note = notes.find((n) => n.includes('XML cannot hold even as a reference'));
    expect(note).toBeDefined();
    expect(note).toMatch(/^left out 2 pairs /);
    expect(note).toContain('bad\uFFFE -> Ashlr.AI');
    expect(note).toContain('bee -> Bad\uFFFFName');
    expect(exportLexiconWithNotes({ version: 1, terms: [{ canonical: 'Ok', aliases: ['okay'] }] }, 'macos').notes).toEqual([]);
  });

  it('names with quotes, ampersands, angle brackets and non-ASCII parse back exactly', () => {
    const names = ['He said "hi"', "O'Brien", 'A&B <Corp>', 'é Ünï 日本語 😀', ']]>', 'back\\slash'];
    const lex: Lexicon = { version: 1, terms: names.map((n, i) => ({ canonical: n, aliases: [`${n} alias ${i}`] })) };
    const doc = new DOMParser().parseFromString(exportLexicon(lex, 'macos'), 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const strings = Array.from(doc.getElementsByTagName('string')).map((n) => n.textContent);
    expect(strings).toEqual(names.flatMap((n, i) => [n, `${n} alias ${i}`]));
  });

  // Catches: macos.ts kept its own copy of the schema's regex, so a change to
  // what the schema refuses would leave the plist filter behind (or ahead).
  it('macos leaves out exactly the pairs findUnencodableChar flags', () => {
    const samples = ['plain', 'a\uFFFE', '\uFFFF', 'x\uD800', '\uDC00y', '\uD83D\uDE00 ok', '\uDE00\uD83D', 'tail\uDBFF', '\uFFFD fine'];
    const lex: Lexicon = { version: 1, terms: [{ canonical: 'Keep', aliases: samples }] };
    const doc = new DOMParser().parseFromString(exportLexicon(lex, 'macos'), 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const shortcuts = Array.from(doc.getElementsByTagName('string')).map((n) => n.textContent).filter((t) => t !== 'Keep');
    expect(shortcuts).toEqual(samples.filter((s) => findUnencodableChar(s) === undefined));
    expect(shortcuts).toHaveLength(3);
  });
});
