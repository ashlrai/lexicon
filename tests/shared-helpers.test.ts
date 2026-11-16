import { expect, it } from 'vitest';
import { errorMessage } from '../extension/src/shared.js';
import { shellWord } from '../src/mcp/shared.js';
import { parseLexicon } from '../src/core/schema.js';

it.each([
  [new Error('offline'), 'offline'],
  ['refused', 'refused'],
  [null, 'null'],
  [{ code: 1 }, '[object Object]'],
])('formats a thrown value for the extension: %s', (value, expected) => {
  expect(errorMessage(value)).toBe(expected);
});

it.each([
  ['@ashlr/lexicon', '@ashlr/lexicon'],
  ['', "''"],
  ['a $HOME', "'a $HOME'"],
  ["O'Brien", "'O'\\''Brien'"],
])('quotes MCP fallback commands as a POSIX shell word: %s', (value, expected) => {
  expect(shellWord(value)).toBe(expected);
});

it.each([
  ['\uD800', 'D800'],
  ['\uDFFF', 'DFFF'],
])('rejects an unpaired surrogate with a safe diagnostic', (surrogate, codeUnit) => {
  let message = '';
  try {
    parseLexicon({ terms: [{ canonical: `word${surrogate}` }] });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    message = (error as Error).message;
  }
  expect(message).toContain('terms[0].canonical');
  expect(message).toContain(`U+${codeUnit}`);
  expect(message).toContain(`word\\u${codeUnit}`);
  expect(message).not.toContain(surrogate);
});

it('accepts a paired surrogate in a canonical name', () => {
  expect(parseLexicon({ terms: [{ canonical: 'word\uD83D\uDE00' }] }).terms[0].canonical).toBe('word\uD83D\uDE00');
});

it.each([
  [34, `${'a'.repeat(34)}\\uFFFF`],
  [35, `${'a'.repeat(35)}\\uFF…`],
])('escapes the term name before limiting its display to 40 characters (prefix %i)', (prefixLength, displayedName) => {
  const canonical = `${'a'.repeat(prefixLength)}\uFFFF`;
  let message = '';
  try {
    parseLexicon({ terms: [{ canonical }] });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    message = (error as Error).message;
  }
  expect(displayedName).toHaveLength(40);
  expect(message).toContain(`in term "${displayedName}"`);
  expect(message).not.toContain('\uFFFF');
});
