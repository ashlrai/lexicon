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
    // Anchors and aliases may point outside the edited items.
    expect(checkLexiconEdit(before, `${before}  - canonical: Qwertyon\n    aliases: *missing\n`)).toBeUndefined();
    // A second document.
    expect(checkLexiconEdit(before, `${before}---\nterms: [\n`)).toBeUndefined();
    // A paste bigger than the cap.
    let big = '';
    while (big.length <= EDIT_CHECK_MAX_CHARS) big += '  - canonical: Bigword\n    aliases: [bigword\n';
    expect(checkLexiconEdit(before, before + big)).toBeUndefined();
    // A file without a block list that is too big to read whole.
    const flow = `version: 1\nterms: [${'{ canonical: Flowword },'.repeat(2000)}]\n`;
    expect(checkLexiconEdit(flow, flow.replace('Flowword', 'Flowwordz'))).toBeUndefined();
  });

  // Catches: an edit outside the terms list (the version line, settings) had
  // no verdict at all, so a broken header was reported only from the prompt
  // after the background refresh.
  it('gives a verdict for an edit outside the terms list', () => {
    expect(checkLexiconEdit(before, before.replace('version: 1', 'version: [1'))).toMatch(/^line \d+: /);
    expect(() => parse(before.replace('version: 1', 'version: [1'))).toThrow();
    expect(checkLexiconEdit(before, before.replace('version: 1', 'version: 2'))).toMatch(/^version: /);
    const withSettings = `${before}settings:\n  minConfidence: 0.8\n`;
    expect(checkLexiconEdit(before, withSettings)).toBeUndefined();
    expect(checkLexiconEdit(withSettings, withSettings.replace('0.8', '7'))).toMatch(/^settings\.minConfidence: /);
    // A YAML error after the list is named by its line in the whole file.
    const tail = withSettings.replace('  minConfidence: 0.8\n', '  minConfidence: [0.8\n');
    expect(checkLexiconEdit(withSettings, tail)).toMatch(new RegExp(`^line (${lines.length + 2}|${lines.length + 3}): `));
    expect(checkLexiconEdit(before, `# my words\n${before}`)).toBeUndefined();
    // No block terms list, a small file: read whole.
    expect(checkLexiconEdit('version: 1\n', 'version: 1\nfoo: [\n')).toMatch(/^line \d+: /);
    expect(checkLexiconEdit('terms: []\n', 'terms: [{ canonical: "" }]\n')).toBe('the term #1: canonical: must not be empty');
    expect(checkLexiconEdit('terms: []\n', 'terms: [{ canonical: Abc }, { canonical: abc }]\n')).toMatch(/^the term #2: its canonical is already the canonical of the term #1/);
  });

  // Catches: a term the edit added (or renamed) with a canonical another term
  // of the file already holds passed, since only the edited items were read;
  // lexicon doctor fails a canonical defined twice in one lexicon.
  it('catches a canonical the edit duplicates, inside or outside the edited items', () => {
    const note = 'its canonical is already the canonical of the term at line';
    const added = `${before}  - canonical: Filler7word\n    aliases: [kwerty]\n`;
    expect(checkLexiconEdit(before, added)).toBe(
      `the term at line ${itemLine(200)}: ${note} ${itemLine(7)} (a canonical may be defined once per file: merge the two terms or remove one)`,
    );
    // Compared as the store compares canonicals: trimmed, any case, NFC; quoted or not.
    expect(checkLexiconEdit(before, `${before}  - canonical: "FILLER7WORD"\n`)).toContain(`${note} ${itemLine(7)} `);
    expect(checkLexiconEdit(before, `${before}  - canonical: 'filler150word' # again\n`)).toContain(`${note} ${itemLine(150)} `);
    const cafe = `${before}  - canonical: Caf\u00e9\n`;
    expect(checkLexiconEdit(cafe, `${cafe}  - canonical: Cafe\u0301\n`)).toContain(`${note} ${itemLine(200)} `);
    // A rename onto another term's canonical, the other term before or after it.
    expect(checkLexiconEdit(before, before.replace('Filler100word', 'Filler3word'))).toBe(
      `the term at line ${itemLine(100)}: ${note} ${itemLine(3)} (a canonical may be defined once per file: merge the two terms or remove one)`,
    );
    expect(checkLexiconEdit(before, before.replace('Filler100word', 'Filler190word'))).toContain(`${note} ${itemLine(190)} `);
    // Two new items with one canonical.
    expect(checkLexiconEdit(before, `${before}  - canonical: Newword\n  - canonical: newword\n`)).toContain(`${note} ${itemLine(200)} `);
    // The canonical key written after aliases still counts (named by its own line).
    const late = `${before}  - aliases: [lateword]\n    canonical: Lateterm\n`;
    expect(checkLexiconEdit(late, `${late}  - canonical: LATETERM\n`)).toContain(`${note} ${itemLine(200) + 1} `);
    // Text that only looks like a canonical key (inside a block note) is not a term.
    const noted = `${before}  - canonical: Notedword\n    notes: |\n      canonical: Fresh\n`;
    expect(checkLexiconEdit(noted, `${noted}  - canonical: Fresh\n`)).toBeUndefined();
    // A unique canonical passes, and nothing quotes the file's text.
    expect(checkLexiconEdit(before, `${before}  - canonical: Qwertyon\n`)).toBeUndefined();
    expect(checkLexiconEdit(before, added)).not.toContain('Filler7word');
  });
});
