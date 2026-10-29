/** Compare the built-in demo with a proposed Hetzner addition, without writing a lexicon. */
import assert from 'node:assert/strict';
import { DEMO_LEXICON } from '../src/core/demo.js';
import { normalize } from '../src/core/normalize.js';
import type { Lexicon } from '../src/core/types.js';

const withHetzner: Lexicon = {
  ...DEMO_LEXICON,
  terms: [
    ...DEMO_LEXICON.terms,
    { canonical: 'Hetzner', aliases: ['head sner', 'hetsner'], phonetic: 'HETS-ner', category: 'brand' },
  ],
};

const cases = [
  { input: 'deploy on head sner', before: 'deploy on head sner', after: 'deploy on Hetzner' },
  { input: 'deploy on hetsner', before: 'deploy on hetsner', after: 'deploy on Hetzner' },
  { input: 'the head singer is ready', before: 'the head singer is ready', after: 'the head singer is ready' },
];

for (const { input, before, after } of cases) {
  const baseline = normalize(input, DEMO_LEXICON);
  const expanded = normalize(input, withHetzner);
  assert.equal(baseline.output, before, `baseline: ${input}`);
  assert.equal(expanded.output, after, `with Hetzner: ${input}`);
  console.log(`PASS: ${input} | before: ${baseline.output} | after: ${expanded.output}`);
}
