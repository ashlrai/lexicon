import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { UNENCODABLE_NOTE, escapeUnencodable, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFE (${UNENCODABLE_NOTE})`;

// The code points around U+FFFE are all encodable; only U+FFFE itself (and
// U+FFFF) is refused, so a neighbour must never be mistaken for it.
describe('U+FFFE boundaries', () => {
  it.each([
    ['U+FFFD replacement character', '�'],
    ['U+FEFF byte order mark', '﻿'],
    ['U+FFFC object replacement', '￼'],
    ['U+FFEF', '￯'],
    ['U+10FFFE (astral noncharacter, a valid surrogate pair)', '\u{10FFFE}'],
  ])('does not report %s', (_name, ch) => {
    expect(findUnencodableChar(`a${ch}b`)).toBeUndefined();
    expect(escapeUnencodable(`a${ch}b`)).toBe(`a${ch}b`);
  });

  it('reports U+FFFE first when it sits beside U+FFFF, in either order', () => {
    expect(findUnencodableChar('￾￿')).toBe('U+FFFE');
    expect(findUnencodableChar('￿￾')).toBe('U+FFFF');
  });

  it('reports U+FFFE as the only character, at the start and at the end', () => {
    expect(findUnencodableChar('￾')).toBe('U+FFFE');
    expect(findUnencodableChar('￾abc')).toBe('U+FFFE');
    expect(findUnencodableChar('abc￾')).toBe('U+FFFE');
  });

  it('escapes every U+FFFE and leaves the rest alone', () => {
    expect(escapeUnencodable('￾a￾')).toBe('\\uFFFEa\\uFFFE');
  });

  it('refuses U+FFFE that arrives through a YAML double-quoted escape', () => {
    const raw = parseYaml('terms:\n  - canonical: "Ash\\uFFFElr"\n');
    expect(() => parseLexicon(raw)).toThrow(`${reason} in term "Ash\\uFFFElr"`);
  });

  it('refuses U+FFFE that arrives as a raw character in YAML text', () => {
    const raw = parseYaml('terms:\n  - canonical: Ashlr.AI\n    aliases: [ok, "x￾y"]\n');
    expect(() => parseLexicon(raw)).toThrow(`terms[0].aliases[1]: ${reason} in term "Ashlr.AI"`);
  });

  it('still accepts a term whose text holds only the neighbouring code points', () => {
    const lex = parseLexicon({ terms: [{ canonical: 'Ashlr�', aliases: ['a￼'] }] });
    expect(lex.terms[0]?.canonical).toBe('Ashlr�');
  });
});
