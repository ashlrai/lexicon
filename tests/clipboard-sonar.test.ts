import { describe, expect, it } from 'vitest';
import { looksBinary } from '../src/daemon/clipboard.js';

describe('clipboard binary detection', () => {
  it.each(['', 'plain text', 'café 漢字 😀', 'line\nnext\tcolumn', '\u0001'])('accepts text: %j', (text) => {
    expect(looksBinary(text)).toBe(false);
  });

  it.each(['\u0000', '\uFFFD', '\u0000text', 'text\uFFFD', 'a\u0000b\uFFFDc'])('detects binary marker: %j', (text) => {
    expect(looksBinary(text)).toBe(true);
  });
});
