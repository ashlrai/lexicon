import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cleanTranscript } from '../src/voice/transcribe.js';

// docs/transcript-cleaning-scope.md is the one transcript cleaning reference.
// It absorbed voice-cleaning-reference.md, transcript-cleaning-examples.md and
// transcript-tag-examples.md; these tests carry every assertion those pages had.
const docUrl = new URL('../docs/transcript-cleaning-scope.md', import.meta.url);

describe('transcript cleaning scope documentation', () => {
  const doc = readFileSync(docUrl, 'utf8');
  const tableRows = /^\| `([^`]+)` \| `([^`]+)` \|$/gm;

  it.each([
    ['Square brackets', 9],
    ['Asterisks', 11],
    ['Parentheses', 8],
    ['Boundaries', 4],
    ['Other cleaning', 3],
  ])('matches the cleaner for the %s examples', (section, minimum) => {
    const content = doc.split(`## ${section}\n`)[1]?.split('\n## ')[0] ?? '';
    const examples = [...content.matchAll(tableRows)];
    expect(examples.length).toBeGreaterThanOrEqual(minimum);
    for (const [, input, output] of examples) {
      expect(cleanTranscript(input), input).toBe(output === '""' ? '' : output);
    }
  });

  it('keeps every table row in the document in sync with the cleaner', () => {
    const examples = [...doc.matchAll(tableRows)];
    expect(examples.length).toBeGreaterThanOrEqual(18);
    for (const [, input, output] of examples) {
      expect(cleanTranscript(input), input).toBe(output === '""' ? '' : output);
    }
  });

  it('documents interactions between sequential and adjacent matches', () => {
    for (const row of [
      '| `Keep *laughs**coughs* here` | `Keep here` |',
      '| `Keep *one*two* here` | `Keep two* here` |',
      '| `Before *hello [noise] world* after` | `Before after` |',
    ]) {
      expect(doc).toContain(row);
    }
  });

  it('documents that a bracketed tag before punctuation leaves the punctuation attached', () => {
    expect(doc).toContain('| `Hello [noise].` | `Hello.` |');
  });

  it('spells out every noise word the parentheses pass recognizes', () => {
    const parentheses = doc.split('## Parentheses\n')[1]?.split('\n## ')[0] ?? '';
    for (const word of ['applause', 'laughter', 'unintelligible', 'clear throat', 'crosstalk', 'foreign language', 'chuckles', 'pause']) {
      expect(parentheses).toContain(`\`${word}\``);
    }
  });

  describe('JSON example list', () => {
    const block = /```json\n([\s\S]*?)\n```/.exec(doc);
    const examples = JSON.parse(block?.[1] ?? 'null') as Array<{ input: string; cleaned: string }> | null;

    it('includes removed and preserved bracketed and starred text', () => {
      expect(examples).not.toBeNull();
      expect(examples!.length).toBeGreaterThanOrEqual(14);
      expect(examples!.some(({ input }) => /\[[^\]]*\]/.test(input))).toBe(true);
      expect(examples!.some(({ input }) => /\*[^*]+\*/.test(input))).toBe(true);
      expect(examples).toEqual(expect.arrayContaining([
        { input: '[BLANK_AUDIO]', cleaned: '' },
        { input: 'Hello [unfinished thought', cleaned: 'Hello [unfinished thought' },
        { input: 'This is *important* today', cleaned: 'This is today' },
        { input: 'Keep *the door slams loudly* here', cleaned: 'Keep *the door slams loudly* here' },
      ]));
    });

    it('matches cleanTranscript for every published example', () => {
      for (const { input, cleaned } of examples ?? []) {
        expect(cleanTranscript(input), input).toBe(cleaned);
      }
    });
  });

  it('replaces the folded pages', () => {
    for (const page of ['voice-cleaning-reference.md', 'transcript-cleaning-examples.md', 'transcript-tag-examples.md']) {
      expect(existsSync(new URL(`../docs/${page}`, import.meta.url)), page).toBe(false);
    }
  });
});
