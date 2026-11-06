import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');

it('tells agents and search engines where the install contract lives', () => {
  expect(html).toContain('rel="describedby"');
  expect(html).toContain('https://lexicon.ashlr.ai/llms.txt');
  expect(html).toContain('https://lexicon.ashlr.ai/llms-full.txt');
  expect(html).toContain('"@type": "FAQPage"');
  expect(html).not.toContain('\u2014');
});

it('lets a visitor try each matcher from the hero', () => {
  expect(html).toContain('data-sample="tell ashler to ship it"');
  expect(html).toContain('data-sample="deploy kuber netties"');
  expect(html).toContain('data-sample="deploy kubernetees"');
  expect(html).toContain('Star on GitHub');
});
