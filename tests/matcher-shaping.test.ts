import { expect, it } from 'vitest';
import { buildIndex, separatorOffsets } from '../src/core/matcher/build.js';
import { alphaOnly, collapse, foldLower, squash } from '../src/core/matcher/text.js';
import { tokenize } from '../src/core/matcher/tokenize.js';

it('precomputes the same folded alias forms for Unicode and repeated aliases', () => {
  const index = buildIndex({ version: 1, terms: [{
    canonical: 'Straße.AI',
    aliases: ['Straße.AI', '  BjørN\t Þór  ', 'œuvre 𐐀.2', 'ΟΣ.ΑWidget', 'j w t', 'j w t'],
    never: [' Þór '],
  }] });
  for (const entry of index.aliasEntries) {
    expect(entry.norm).toBe(squash(entry.alias));
    expect(entry.normLower).toBe(foldLower(entry.norm));
    expect(entry.collapsed).toBe(collapse(entry.norm));
    expect(entry.separators).toEqual(separatorOffsets(entry.norm));
  }
  for (const entry of index.phoneticEntries) expect(entry.alpha).toBe(alphaOnly(entry.alias));
  expect(index.exact.get('strasse.ai')?.map((entry) => entry.explicit)).toEqual([false, true]);
  expect(index.exact.get('j w t')).toHaveLength(1);
  expect(index.never[0].has('thor')).toBe(true);
});

it('keeps token offsets, possessives, gaps and protected spans when constructing tokens once', () => {
  const text = "Bjørn's  Þór’s, WIDGET... `Straße`\n𐐀-2";
  const tokens = tokenize(text, true);
  expect(tokens.map((t) => [t.text, t.base, t.textLower, t.baseLower, t.skipped, t.joinsNext])).toEqual([
    ["Bjørn's", 'Bjørn', "bjorn's", 'bjorn', false, true],
    ['Þór’s', 'Þór', 'thor’s', 'thor', false, false],
    ['WIDGET', 'WIDGET', 'widget', 'widget', false, false],
    ['Straße', 'Straße', 'strasse', 'strasse', true, false],
    ['𐐀-2', '𐐀-2', '𐐨-2', '𐐨-2', false, false],
  ]);
  for (const token of tokens) {
    expect(text.slice(token.start, token.end)).toBe(token.text);
    expect(text.slice(token.start, token.baseEnd)).toBe(token.base);
  }
  expect(tokenize(text, false).every((token) => !token.skipped)).toBe(true);
  expect(tokenize('', true)).toEqual([]);
});
