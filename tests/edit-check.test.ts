/**
 * checkLexiconEdit: the cheap check of the list items a hand edit touched,
 * which lets the prompt hook name a broken edit on the first prompt after it
 * instead of the prompt after the background refresh. Pure strings.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { EDIT_CHECK_MAX_CHARS, checkLexiconEdit } from '../src/core/edit-check.js';

const lines = ['version: 1', 'terms:'];
for (let i = 0; i < 200; i += 1) lines.push(`  - canonical: Filler${i}word`, `    aliases: [fillerx${i}y, fillerz${i}q]`);
const before = `${lines.join('\n')}\n`;
/** 1-based line of the item for Filler<i>word. */
const itemLine = (i: number): number => 3 + i * 2;

describe('checkLexiconEdit', () => {
  it('passes edits that parse and validate', () => {
    expect(checkLexiconEdit(before, before)).toBeUndefined();
    expect(checkLexiconEdit(before, `${before}  - canonical: Qwertyon\n    aliases: [kwertyon]\n`)).toBeUndefined();
    expect(checkLexiconEdit(before, before.replace('Filler100word', 'Filler100wordz'))).toBeUndefined();
    expect(checkLexiconEdit(before, before.replace('  - canonical: Filler100word\n    aliases: [fillerx100y, fillerz100q]\n', ''))).toBeUndefined();
    expect(checkLexiconEdit(before, before.replace('  - canonical: Filler100word\n', '  - canonical: Filler100word\n    note: |\n      a note\n      - with a dash line\n'))).toBeUndefined();
  });

  it('names a YAML error by its line in the whole file', () => {
    const tab = before.replace('  - canonical: Filler100word\n', '  - canonical: Filler100word\n\tnote: x\n');
    expect(checkLexiconEdit(before, tab)).toBe(`line ${itemLine(100) + 1}: Tabs are not allowed as indentation`);
    expect(checkLexiconEdit(before, before.replace('Filler7word', '"Filler7word'))).toMatch(/^line \d+: Missing closing "quote/);
    // A deleted `- canonical:` line folds its aliases into the item above: a duplicate key.
    expect(checkLexiconEdit(before, before.replace('  - canonical: Filler50word\n', ''))).toMatch(/^line \d+: Map keys must be unique/);
  });

  it('names a schema problem by the line of its term', () => {
    const out = checkLexiconEdit(before, `${before}  - canonical: ""\n`);
    expect(out).toBe(`the term at line ${itemLine(200)}: canonical: must not be empty`);
  });

  it('agrees with a full parse on what it reports', () => {
    const broken = before.replace('    aliases: [fillerx3y, fillerz3q]', '      aliases: [fillerx3y, fillerz3q]');
    expect(checkLexiconEdit(before, broken)).toBeDefined();
    expect(() => parse(broken)).toThrow();
  });

  it('stays out of what it cannot check cheaply', () => {
    // Outside the terms list.
    expect(checkLexiconEdit(before, before.replace('version: 1', 'version: [1'))).toBeUndefined();
    // Anchors and aliases may point outside the edited items.
    expect(checkLexiconEdit(before, `${before}  - canonical: Qwertyon\n    aliases: *missing\n`)).toBeUndefined();
    // A second document.
    expect(checkLexiconEdit(before, `${before}---\nterms: [\n`)).toBeUndefined();
    // A paste bigger than the cap.
    let big = '';
    while (big.length <= EDIT_CHECK_MAX_CHARS) big += '  - canonical: Bigword\n    aliases: [bigword\n';
    expect(checkLexiconEdit(before, before + big)).toBeUndefined();
    // No terms list at all.
    expect(checkLexiconEdit('version: 1\n', 'version: 1\nfoo: [\n')).toBeUndefined();
  });
});
