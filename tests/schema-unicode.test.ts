import { describe, expect, it } from 'vitest';
import { escapeUnencodable, parseLexicon } from '../src/core/schema.js';

const LABEL_MAX = 40;

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

describe('schema error labels for invalid term names', () => {
  it('escapes unencodable code units in the term name instead of printing them raw', () => {
    const msg = message({ terms: [{ canonical: 'Acme￿Corp', notes: 'bad￾' }] });
    expect(labelOf(msg)).toBe('Acme\\uFFFFCorp');
    expect(msg).not.toContain('￿');
    expect(msg).not.toContain('￾');
  });

  it('escapes unpaired surrogates in the term name', () => {
    for (const unit of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF']) {
      const label = labelOf(message({ terms: [{ canonical: `pre${unit}post`, notes: 'x￾' }] }));
      expect(label).toBe(`pre\\u${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}post`);
    }
  });

  it('leaves a valid surrogate pair untouched in the label', () => {
    const msg = message({ terms: [{ canonical: 'Rocket🚀Team', notes: 'bad￾' }] });
    expect(labelOf(msg)).toBe('Rocket🚀Team');
  });

  it('bounds the label to 40 code units when escaping inflates the name', () => {
    // 20 escaped units produce 120 characters; the label must still cap at 40.
    const canonical = '￿'.repeat(20);
    const label = labelOf(message({ terms: [{ canonical }] }));
    expect(label).toBe(expectedLabel(canonical));
    expect(label).toHaveLength(LABEL_MAX);
    expect(label.endsWith('…')).toBe(true);
  });

  it('never emits a raw unencodable unit in the label for any unit and offset', () => {
    for (const unit of ['￾', '￿', '\uD800', '\uDBFF', '\uDC00', '\uDFFF']) {
      for (let n = 0; n <= 60; n++) {
        const canonical = 'A'.repeat(n) + unit + 'tail';
        const label = labelOf(message({ terms: [{ canonical }] }));
        expect(label).toBe(expectedLabel(canonical));
        expect(label.length).toBeLessThanOrEqual(LABEL_MAX);
        expect(label).not.toContain(unit);
      }
    }
  });

  it('backs off one unit rather than split a surrogate pair at the truncation boundary', () => {
    // 38 'A' + emoji (2 units) + more: the pair straddles the 39-unit cut, so
    // the label ends one unit early plus the ellipsis and holds no half pair.
    const canonical = 'A'.repeat(38) + '🚀' + 'B'.repeat(10);
    const label = labelOf(message({ terms: [{ canonical, notes: 'bad￾' }] }));
    expect(label).toBe(`${'A'.repeat(38)}…`);
    expect(label).toHaveLength(LABEL_MAX - 1);
    expect(label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(label).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('keeps a surrogate pair that ends exactly at the cut intact', () => {
    // 37 'A' + emoji fills units 37-38 of the 39-unit slice: no backoff needed.
    const canonical = 'A'.repeat(37) + '🚀' + 'B'.repeat(10);
    const label = labelOf(message({ terms: [{ canonical, notes: 'bad￾' }] }));
    expect(label).toBe(`${'A'.repeat(37)}🚀…`);
    expect(label).toHaveLength(LABEL_MAX);
  });

  it('names each term by its own escaped label in a multi-term error', () => {
    const msg = message({ terms: [
      { canonical: 'short', aliases: ['￿'] },
      { canonical: `long￿${'x'.repeat(70)}`, notes: '￾' },
    ] });
    expect(msg).toContain('in term "short"');
    const second = msg.split('\n').find((l) => l.includes('terms[1]') && l.includes(' in term "')) ?? '';
    const start = second.indexOf(' in term "');
    const label = second.slice(start + ' in term "'.length, -1);
    expect(label).toBe(expectedLabel(`long￿${'x'.repeat(70)}`));
    expect(label.length).toBeLessThanOrEqual(LABEL_MAX);
  });
});
