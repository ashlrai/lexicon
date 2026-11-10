import { describe, expect, it } from 'vitest';
import { escapeUnencodable, parseLexicon } from '../src/core/schema.js';

const LABEL_MAX = 40;
const NOTE = '(U+FFFE, U+FFFF and unpaired surrogates fit no file format)';

function message(raw: unknown): string {
  try {
    parseLexicon(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected invalid input to be rejected');
}

/** The text between the quotes after ` in term ` on the first issue that names a term. */
function labelOf(msg: string): string {
  const line = msg.split('\n').find((l) => l.includes(' in term "')) ?? '';
  const start = line.indexOf(' in term "');
  expect(start).toBeGreaterThan(-1);
  expect(line.endsWith('"')).toBe(true);
  return line.slice(start + ' in term "'.length, -1);
}

/** The documented label: escape, then 40 code units, or 39 plus an ellipsis. */
function expectedLabel(canonical: string): string {
  const shown = escapeUnencodable(canonical);
  return shown.length > LABEL_MAX ? `${shown.slice(0, LABEL_MAX - 1)}…` : shown;
}

describe('schema error labels for long invalid strings', () => {
  it.each([41, 100, 5_000, 200_000])('bounds the label of a %i-unit canonical to 40 code units', (n) => {
    const canonical = 'A'.repeat(n);
    const msg = message({ terms: [{ canonical, aliases: ['bad￿'] }] });
    const label = labelOf(msg);
    expect(label).toBe(`${'A'.repeat(39)}…`);
    expect(label).toHaveLength(LABEL_MAX);
    expect(msg).not.toContain('A'.repeat(40));
  });

  it('keeps the whole error small however long the offending strings are', () => {
    const big = 'x'.repeat(100_000);
    const msg = message({ terms: [{ canonical: big, aliases: [`${big}\uD800`], notes: `${big}￾` }] });
    expect(msg.length).toBeLessThan(1500);
  });

  it('escapes the offending unit even when it sits far beyond the cut', () => {
    const msg = message({ terms: [{ canonical: 'B'.repeat(10_000), aliases: ['C'.repeat(10_000) + '￾'] }] });
    expect(msg).toContain('terms[0].aliases[0]: must not contain U+FFFE');
    expect(labelOf(msg)).toBe(`${'B'.repeat(39)}…`);
  });

  it('applies the documented cut at every prefix length around the boundary', () => {
    for (let n = 30; n <= 50; n++) {
      const canonical = 'A'.repeat(n) + '￿';
      expect(labelOf(message({ terms: [{ canonical }] }))).toBe(expectedLabel(canonical));
    }
  });

  it('never exceeds 40 code units and never prints a raw unencodable unit, for every escape offset', () => {
    for (const unit of ['￾', '￿', '\uD800', '\uDBFF', '\uDC00', '\uDFFF']) {
      for (let n = 0; n <= 60; n++) {
        const canonical = 'A'.repeat(n) + unit + 'tail';
        const label = labelOf(message({ terms: [{ canonical }] }));
        expect(label).toBe(expectedLabel(canonical));
        expect(label.length).toBeLessThanOrEqual(LABEL_MAX);
        // An escape may be cut short, but no raw noncharacter or lone surrogate unit of the input survives.
        expect(label).not.toContain(unit);
      }
    }
  });

  it('escapes every unit of a long run of unencodable units and cuts after 6 escapes plus 3 characters', () => {
    const canonical = '￿'.repeat(500);
    const label = labelOf(message({ terms: [{ canonical }] }));
    expect(label).toBe(expectedLabel(canonical));
    expect(label).toHaveLength(LABEL_MAX);
    expect(label.startsWith('\\uFFFF\\uFFFF')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
  });

  it('escapes a lone surrogate in a long label but leaves a valid pair readable', () => {
    const canonical = `${'A'.repeat(10)}\uD800${'\u{1F600}'.repeat(5)}\uDC00${'Z'.repeat(100)}`;
    const label = labelOf(message({ terms: [{ canonical }] }));
    expect(label).toBe(`${'A'.repeat(10)}\\uD800${'\u{1F600}'.repeat(5)}\\uDC00${'Z'.repeat(40 - 1 - 10 - 6 - 10 - 6)}…`);
    expect(label).toHaveLength(LABEL_MAX);
  });

  it('backs off one unit at the boundary rather than split a valid pair', () => {
    const canonical = 'A'.repeat(38) + '\u{1F600}' + 'B'.repeat(10) + '￿';
    const label = labelOf(message({ terms: [{ canonical }] }));
    expect(label).toBe(`${'A'.repeat(38)}…`);
    expect(label).toHaveLength(LABEL_MAX - 1);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(label).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('labels every invalid field of a long term with the same bounded name', () => {
    const canonical = 'L'.repeat(70);
    const msg = message({ terms: [{ canonical, aliases: ['a￿'], never: ['b\uD800'], notes: 'c￾' }] });
    const lines = msg.split('\n').slice(1).filter((l) => l.includes(' in term "'));
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toContain(NOTE);
      expect(line.endsWith(` in term "${'L'.repeat(39)}…"`)).toBe(true);
    }
  });

  it('names a long canonical that itself holds the invalid unit', () => {
    const msg = message({ terms: [{ canonical: `${'Q'.repeat(60)}￿` }] });
    expect(msg).toContain('terms[0].canonical: must not contain U+FFFF');
    expect(labelOf(msg)).toBe(`${'Q'.repeat(39)}…`);
  });

  it('cleans invisible characters and padding before measuring a long label', () => {
    const canonical = `  ​${'W'.repeat(39)}​${'X'.repeat(5)}  `;
    const msg = message({ terms: [{ canonical, notes: 'n￿' }] });
    expect(labelOf(msg)).toBe(`${'W'.repeat(39)}…`);
  });
});
