import { describe, expect, it } from 'vitest';
import { editJsonText, parseJsonc } from '../src/util/jsonc.js';

describe('parseJsonc', () => {
  it('reads JSON, comments and trailing commas, as JSON.parse reads JSON', () => {
    expect(parseJsonc('{"a": [1, 2.5e3, true, null, "x\\"y"]}')).toEqual({ a: [1, 2500, true, null, 'x"y'] });
    expect(parseJsonc('// lead\n{ /* in */ "a": 1, // tail\n "b": [1, 2,], }')).toEqual({ a: 1, b: [1, 2] });
    expect(parseJsonc('{"a": 1, "a": 2}')).toEqual({ a: 2 });
    expect(Object.keys(parseJsonc('{"__proto__": {"x": 1}}') as object)).toEqual(['__proto__']);
  });

  it('preserves comment-like text inside a quoted string while ignoring comments', () => {
    const text = String.raw`{
      // A real line comment
      "value": "https://example.test/a/*literal*/ and \"// still text\"", /* a real block comment */
      "after": true // another real comment
    }`;
    expect(parseJsonc(text)).toEqual({
      value: 'https://example.test/a/*literal*/ and "// still text"',
      after: true,
    });
  });

  it('distinguishes escaped quotes beside comment markers from real comments', () => {
    const text = String.raw`{
      "line": "before\"//inside\"after",// "ignored /*
      "block": "before\"/*inside*/\"after",/* "ignored // */
      "slashes": "backslash\\\"//still inside", // real comment
      "endsInSlash": "backslash\\"/* real comment */,
      "next": "intact"
    }`;
    expect(parseJsonc(text)).toEqual({
      line: 'before"//inside"after',
      block: 'before"/*inside*/"after',
      slashes: 'backslash\\"//still inside',
      endsInSlash: 'backslash\\',
      next: 'intact',
    });
  });

  it('reads a value followed by a line comment at end of file', () => {
    expect(parseJsonc('{"a": 1} // final comment')).toEqual({ a: 1 });
  });

  it('reads properties separated by a multiline block comment', () => {
    const text = `{
      "first": "original value",
      /* A comment between properties
         spanning multiple lines. */
      "second": 42
    }`;
    expect(parseJsonc(text)).toEqual({ first: 'original value', second: 42 });
  });

  it('skips comments between nested array elements and keeps their order', () => {
    const text = `{
  "m": [
    // first row
    [1, /* one */ 2, // two
     3],
    /* between rows */
    [ // open
      [4, /* deep */ 5],
      // before last
      [6] // after last
    ],
    [], // empty row
    [7, /* trailing */ ], // trailing comma
  ]
}`;
    expect(parseJsonc(text)).toEqual({ m: [[1, 2, 3], [[4, 5], [6]], [], [7]] });
    expect(parseJsonc('[[1]/* a */,/* b */[2]//c\n,[3]]')).toEqual([[1], [2], [3]]);
  });

  it('names the line and column of what it cannot read', () => {
    expect(() => parseJsonc('{\n  "a": }')).toThrow(/line 2 column 8/);
    expect(() => parseJsonc('{ "a": 1 } x')).toThrow(/after the end/);
    expect(() => parseJsonc('/* open')).toThrow(/unterminated comment/);
    expect(() => parseJsonc('﻿{}')).toThrow();
    expect(() => parseJsonc('')).toThrow(/end of input/);
  });

  it('rejects missing values in nested arrays at the offending comma', () => {
    const text = `{
  "rows": [
    [1, 2],
    [3, /* missing value */
     , 4]
  ]
}`;
    expect(() => parseJsonc(text)).toThrow('unexpected "," at line 5 column 6');
    expect(() => parseJsonc('[[, 1]]')).toThrow('unexpected "," at line 1 column 3');
    expect(() => parseJsonc('[[1,, 2]]')).toThrow('unexpected "," at line 1 column 5');
  });

  it('rejects unterminated block comments within and after a value', () => {
    expect(() => parseJsonc('{ "a": 1, /* unfinished')).toThrow(/unterminated comment/);
    expect(() => parseJsonc('{ "a": 1 } /* unfinished *')).toThrow(/unterminated comment/);
  });

  it('reports unterminated strings and their location', () => {
    expect(() => parseJsonc('"unfinished')).toThrow('unterminated string at line 1 column 12');
    expect(() => parseJsonc('{"key')).toThrow('unterminated string at line 1 column 6');
    expect(() => parseJsonc(String.raw`"a\"`)).toThrow('unterminated string at line 1 column 5');
    expect(() => parseJsonc('{\n  "a": "open\n}')).toThrow('unterminated string at line 2 column 13');
  });
});

describe('editJsonText', () => {
  it('replaces only a changed value, in place', () => {
    const text = '{\n  "keep": [1, 2],  // mine\n  "x": { "command": "old" }\n}\n';
    expect(editJsonText(text, { keep: [1, 2], x: { command: 'new' } })).toBe('{\n  "keep": [1, 2],  // mine\n  "x": { "command": "new" }\n}\n');
  });

  it('edits a nested value in a CRLF document without changing its line endings', () => {
    const text = '{\r\n  // client settings\r\n  "server": {\r\n    "command": "old",\r\n    "enabled": true\r\n  }\r\n}\r\n';
    const next = { server: { command: 'new', enabled: true } };
    const out = editJsonText(text, next);

    expect(parseJsonc(out)).toEqual(next);
    expect(out).toBe(text.replace('"old"', '"new"'));
    expect(out).not.toMatch(/(?<!\r)\n|\r(?!\n)/);
  });

  it('adds a key after a same-line comment and keeps a missing trailing newline', () => {
    expect(editJsonText('{\n  "a": 1 // one\n}', { a: 1, b: 2 })).toBe('{\n  "a": 1, // one\n  "b": 2\n}');
    expect(editJsonText('{ "a": 1 }', { a: 1, b: [2] })).toBe('{ "a": 1, "b": [2] }');
    expect(editJsonText('{ "a": [1] }', { a: [1, 2] })).toBe('{ "a": [1, 2] }');
  });

  it('writes an object whole when a key was moved, and falls back to plain JSON for empty text', () => {
    expect(editJsonText('{ "a": 1, "b": 2 }', { b: 2, a: 1 })).toBe('{\n  "b": 2,\n  "a": 1\n}');
    expect(editJsonText('', { a: 1 })).toBe('{\n  "a": 1\n}\n');
    expect(editJsonText('{ not json', { a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('is the identity when nothing changed', () => {
    const text = '{\n\t// c\n\t"a": [ 1 ,2 ],\n}';
    expect(editJsonText(text, { a: [1, 2] })).toBe(text);
  });

  it('returns an unchanged nested object with its comments byte for byte', () => {
    const text = '{\r\n  "server": {\r\n    // Keep the command comment.\r\n    "options": { /* nested comment */\r\n      "enabled": true, // Keep the trailing comment.\r\n      "args": ["one", /* argument comment */ "two"],\r\n    },\r\n  }\r\n}\r\n';
    const value = { server: { options: { enabled: true, args: ['one', 'two'] } } };

    expect(editJsonText(text, value)).toBe(text);
  });

  it.each(['\n', '\r\n'])('preserves comments, spacing and the trailing newline on an unchanged edit (%j)', (newline) => {
    const text = [
      '/* leading comment */',
      '{',
      '\t"server" : { "args": [ "one" , "two" ] }, // keep spacing',
      '\t"enabled": true, /* keep trailing comma */',
      '}',
      '',
    ].join(newline);
    expect(editJsonText(text, { server: { args: ['one', 'two'] }, enabled: true })).toBe(text);
  });

  // Catches: removing a key wrote its whole object again through
  // JSON.stringify, so `lexicon uninstall` dropped every comment and the
  // formatting of the user's other servers along with the lexicon entry.
  describe('removing keys and elements in place', () => {
    const file = [
      '{',
      '    // my servers',
      '    "mcpServers": {',
      '        "other": { "command": "x", "args": ["a", "b"] }, // keep me',
      '        "lexicon": {',
      '            "command": "node",',
      '            "args": ["/x/plugin/mcp-server.mjs"]',
      '        }',
      '    },',
      '    "after": true',
      '}',
      '',
    ].join('\n');

    it('deletes the last member and the comma before it, keeping the comment after that comma', () => {
      const out = editJsonText(file, { mcpServers: { other: { command: 'x', args: ['a', 'b'] } }, after: true });
      expect(out).toBe(file.replace(/\n {8}"lexicon": \{[\s\S]*?\n {8}\}/, '').replace('"b"] }, // keep me', '"b"] } // keep me'));
      expect(out).toContain('// my servers');
    });

    it('deletes a first or middle member with its line and comma', () => {
      const text = '{\n  "a": 1, // a\n  "b": 2,\n  // c is next\n  "c": 3\n}';
      expect(editJsonText(text, { b: 2, c: 3 })).toBe('{\n  "b": 2,\n  // c is next\n  "c": 3\n}');
      expect(editJsonText(text, { a: 1, c: 3 })).toBe('{\n  "a": 1, // a\n  // c is next\n  "c": 3\n}');
      expect(editJsonText(text, { a: 1 })).toBe('{\n  "a": 1 // a\n}');
    });

    it('removes the only member while preserving surrounding content', () => {
      const text = '/* before */\n{\n  "servers": { "lexicon": { "command": "node" } }, // keep\n  "enabled": true\n}\n// after\n';
      const out = editJsonText(text, { servers: {}, enabled: true });

      expect(parseJsonc(out)).toEqual({ servers: {}, enabled: true });
      expect(out).toBe(text.replace('{ "lexicon": { "command": "node" } }', '{}'));
    });

    it('handles one-line containers, trailing commas, arrays and removing everything', () => {
      expect(editJsonText('{ "a": 1, "b": 2 }', { b: 2 })).toBe('{ "b": 2 }');
      expect(editJsonText('{ "a": 1, "b": 2 }', { a: 1 })).toBe('{ "a": 1 }');
      expect(editJsonText('{\n  "a": 1,\n  "b": 2,\n}', { a: 1 })).toBe('{\n  "a": 1,\n}');
      expect(editJsonText('[1, 2, 3]', [1, 3])).toBe('[1, 3]');
      expect(editJsonText('{ "x": [\n  { "k": 1 },\n  { "k": 2 }\n] }', { x: [{ k: 2 }] })).toBe('{ "x": [\n  { "k": 2 }\n] }');
      expect(editJsonText('{ "s": { "lexicon": {} }, "t": 1 }', { s: {}, t: 1 })).toBe('{ "s": {}, "t": 1 }');
      expect(editJsonText('{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n', { b: 2 })).toBe('{\r\n  "b": 2\r\n}\r\n');
    });
  });
});
