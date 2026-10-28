import { describe, expect, it } from 'vitest';
import { guardYamlImport } from '../src/core/importers/yaml-guard.js';
import { importLexicon } from '../src/core/importers/index.js';

describe('YAML import complexity guard', () => {
  it('rejects excessive flow nesting before building a syntax tree', () => {
    expect(() => guardYamlImport('['.repeat(129))).toThrow(/nesting depth/);
    expect(() => guardYamlImport('{ a: '.repeat(129))).toThrow(/nesting depth/);
    expect(() => guardYamlImport('['.repeat(128) + ']'.repeat(128))).not.toThrow();
  });

  it('ignores brackets in quoted strings, comments and block scalars', () => {
    for (const value of [JSON.stringify('['.repeat(1000)), "'" + '{'.repeat(1000) + "'", '# ' + '['.repeat(1000), 'value: |\n  ' + '['.repeat(1000)]) {
      expect(() => guardYamlImport(value)).not.toThrow();
    }
  });

  it('rejects adjacent quoted scalars but allows escapes and separators', () => {
    expect(() => guardYamlImport('""""')).toThrow(/adjacent quoted scalars/);
    for (const value of ['["a", "b"]', "['a''b', 'c']", '"a\\"b"', '"a": "b"']) {
      expect(() => guardYamlImport(value)).not.toThrow();
    }
  });

  it('keeps a normal nested espanso import working', () => {
    expect(importLexicon('matches:\n  - triggers: [":ashler", ":ashlar"]\n    replace: Ashlr.AI\n', 'espanso').terms)
      .toEqual([{ canonical: 'Ashlr.AI', aliases: ['ashler', 'ashlar'], source: 'import' }]);
  });
});
