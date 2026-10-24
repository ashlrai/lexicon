import { describe, expect, it } from 'vitest';
import { editJsonText, parseJsonc } from '../src/util/jsonc.js';

describe('parseJsonc', () => {
  it('reads JSON, comments and trailing commas, as JSON.parse reads JSON', () => {
    expect(parseJsonc('{"a": [1, 2.5e3, true, null, "x\\"y"]}')).toEqual({ a: [1, 2500, true, null, 'x"y'] });
    expect(parseJsonc('// lead\n{ /* in */ "a": 1, // tail\n "b": [1, 2,], }')).toEqual({ a: 1, b: [1, 2] });
    expect(parseJsonc('{"a": 1, "a": 2}')).toEqual({ a: 2 });
    expect(Object.keys(parseJsonc('{"__proto__": {"x": 1}}') as object)).toEqual(['__proto__']);
  });

  it('names the line and column of what it cannot read', () => {
    expect(() => parseJsonc('{\n  "a": }')).toThrow(/line 2 column 8/);
    expect(() => parseJsonc('{ "a": 1 } x')).toThrow(/after the end/);
    expect(() => parseJsonc('/* open')).toThrow(/unterminated comment/);
    expect(() => parseJsonc('﻿{}')).toThrow();
    expect(() => parseJsonc('')).toThrow(/end of input/);
  });
});

describe('editJsonText', () => {
  it('replaces only a changed value, in place', () => {
    const text = '{\n  "keep": [1, 2],  // mine\n  "x": { "command": "old" }\n}\n';
    expect(editJsonText(text, { keep: [1, 2], x: { command: 'new' } })).toBe('{\n  "keep": [1, 2],  // mine\n  "x": { "command": "new" }\n}\n');
  });

  it('adds a key after a same-line comment and keeps a missing trailing newline', () => {
    expect(editJsonText('{\n  "a": 1 // one\n}', { a: 1, b: 2 })).toBe('{\n  "a": 1, // one\n  "b": 2\n}');
    expect(editJsonText('{ "a": 1 }', { a: 1, b: [2] })).toBe('{ "a": 1, "b": [2] }');
    expect(editJsonText('{ "a": [1] }', { a: [1, 2] })).toBe('{ "a": [1, 2] }');
  });

  it('writes an object whole when a key was removed or moved, and falls back to plain JSON for empty text', () => {
    expect(editJsonText('{ "a": 1, "b": 2 }', { b: 2 })).toBe('{\n  "b": 2\n}');
    expect(editJsonText('', { a: 1 })).toBe('{\n  "a": 1\n}\n');
    expect(editJsonText('{ not json', { a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('is the identity when nothing changed', () => {
    const text = '{\n\t// c\n\t"a": [ 1 ,2 ],\n}';
    expect(editJsonText(text, { a: [1, 2] })).toBe(text);
  });
});
