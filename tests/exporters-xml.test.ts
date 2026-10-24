// @vitest-environment jsdom
/**
 * The macos export parsed by a real XML parser (jsdom's DOMParser), which
 * the string checks in exporters.test.ts cannot stand in for.
 */
import { describe, expect, it } from 'vitest';
import { exportLexicon } from '../src/core/exporters/index.js';
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

  it('names with quotes, ampersands, angle brackets and non-ASCII parse back exactly', () => {
    const names = ['He said "hi"', "O'Brien", 'A&B <Corp>', 'é Ünï 日本語 😀', ']]>', 'back\\slash'];
    const lex: Lexicon = { version: 1, terms: names.map((n, i) => ({ canonical: n, aliases: [`${n} alias ${i}`] })) };
    const doc = new DOMParser().parseFromString(exportLexicon(lex, 'macos'), 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const strings = Array.from(doc.getElementsByTagName('string')).map((n) => n.textContent);
    expect(strings).toEqual(names.flatMap((n, i) => [n, `${n} alias ${i}`]));
  });
});
