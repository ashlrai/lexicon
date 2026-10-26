import { expect, it } from 'vitest';
import { errorMessage } from '../extension/src/shared.js';
import { shellWord } from '../src/mcp/shared.js';

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
