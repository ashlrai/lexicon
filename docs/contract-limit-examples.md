# Contract limit examples

These examples illustrate the inclusive `LIMITS` in the
[schema contract](CONTRACT.md#srccoreschemats) for one parsed lexicon file.
They use `parseLexicon` from `@ashlr/lexicon`; a rejected input throws an
`Invalid lexicon` error. Other surfaces can impose additional limits. See the
[schema limit reference](schema-limit-reference.md) for all affected fields.

| Limit | At the boundary | One over the boundary |
| --- | --- | --- |
| `word` | 80 code points in a canonical or each alias | 81 is rejected |
| `text` | 200 code points in each notes or phonetic field | 201 is rejected |
| `aliases` | 64 entries in each term's aliases or never list | 65 in either list is rejected |
| `terms` | 5000 terms in one file | 5001 is rejected |

Lengths are counted in Unicode code points after invisible characters are
stripped and leading and trailing whitespace is trimmed. For example, an emoji
counts as one code point even though it occupies two JavaScript UTF-16 code
units. Combining marks count separately. Blank word-list entries are removed
before the list is counted, but duplicate entries are not removed by the
parser. Each list and each field has its own limit. The examples use valid
content otherwise: control characters, line breaks and unencodable characters
are subject to separate checks described in the contract.

Run this JavaScript with Node.js in a project with `@ashlr/lexicon` installed:

```js
import assert from 'node:assert/strict';
import { parseLexicon } from '@ashlr/lexicon';

// word: each canonical, alias and never word has an 80-code-point cap.
const word = '🙂'.repeat(80);
assert.equal(parseLexicon({ terms: [{ canonical: word, aliases: [word] }] }).terms[0].canonical, word);
assert.throws(() => parseLexicon({ terms: [{ canonical: `${word}🙂` }] }), /canonical: must be at most 80 characters/);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [`${word}🙂`] }] }), /aliases\[0\]: must be at most 80 characters/);
// Padding and the zero-width space are removed before measuring.
assert.equal(parseLexicon({ terms: [{ canonical: `  ${word}\u200b  ` }] }).terms[0].canonical, word);

// text: notes and phonetic each have a 200-code-point cap.
const text = 'n'.repeat(200);
const term = parseLexicon({ terms: [{ canonical: 'X', notes: text, phonetic: text }] }).terms[0];
assert.equal(term.notes, text);
assert.equal(term.phonetic, text);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${text}n` }] }), /notes: must be at most 200 characters/);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: `${text}n` }] }), /phonetic: must be at most 200 characters/);

// aliases: aliases and never each have their own 64-entry cap per term.
const aliases = Array.from({ length: 64 }, (_, i) => `alias${i}`);
const never = Array.from({ length: 64 }, (_, i) => `never${i}`);
const lists = parseLexicon({ terms: [{ canonical: 'X', aliases: [...aliases, ' '], never }] }).terms[0];
assert.equal(lists.aliases.length, 64); // The blank is removed before counting.
assert.equal(lists.never.length, 64);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', aliases: [...aliases, 'extra'] }] }), /aliases: at most 64 aliases per term/);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', never: [...never, 'extra'] }] }), /never: at most 64 never words per term/);

// terms: the cap applies to the file, not to each individual term.
const terms = Array.from({ length: 5000 }, (_, i) => ({ canonical: `Term${i}` }));
assert.equal(parseLexicon({ terms }).terms.length, 5000);
assert.throws(() => parseLexicon({ terms: [...terms, { canonical: 'Overflow' }] }), /terms: at most 5000 terms/);
```
