# Lexicon schema limit reference

These are inclusive limits for a single parsed lexicon file. The public
contract is the [schema contract](CONTRACT.md#srccoreschemats); the
implementation is [schema.ts](../src/core/schema.ts), which imports and
re-exports `LIMITS` from [caps.ts](../src/core/caps.ts). They describe
file-schema validation (`LexiconSchema`, `TermSchema` and `parseLexicon`), not
every separate limit imposed by the CLI, MCP tools, importers, or exporters.
File size and other operational limits are described in the contract.

| Limit | Maximum | Schema fields and unit |
| --- | ---: | --- |
| `word` | 80 | Unicode code points per `canonical`, each `aliases`, `never` or `context` entry, and each `settings.protectedWords` or `settings.packs` entry |
| `text` | 200 | Unicode code points per `phonetic` or `notes` field |
| `aliases` | 64 | Entries per term's `aliases`, `never` or `context` list, and per `settings.packs` list; each list has its own cap |
| `terms` | 5000 | Terms per lexicon file |
| `protectedWords` | 1000 | Entries in `settings.protectedWords` per lexicon file |
| `createdAt` | 64 | Unicode code points in a term's `createdAt`; this is a separate literal in the schema, not a `LIMITS` member |

## Counting rules

String lengths are checked after the schema strips its specified invisible
characters and trims whitespace. A canonical must remain nonempty. A
supplementary Unicode character such as an emoji counts as one code point, not
two UTF-16 code units; combining marks count separately, so a visible
character made of several code points counts as more than one.

For word lists the schema also removes empty entries before counting; it does
not deduplicate entries, so repeated nonempty entries each count. The text and
list limits are independent: for example, each alias must fit the word limit
and its list must fit the aliases limit. A term can hold 64 aliases and 64
`never` entries at the same time.

The terms limit applies per file. It is separate from the merged view of a
global file and a trusted project file: each file gets its own 5000 terms.

The schema also rejects control characters and unencodable characters; see the
contract for details.

## Contract and source comparison

The numerical `LIMITS` values stated in the contract agree with the source.
The contract's `LIMITS` summary names only canonical and alias for `word`, and
only aliases and `never` for `aliases`. The schema additionally applies `word`
to `never`, `context`, `settings.protectedWords`, and `settings.packs` entries,
and applies `aliases` to the `context` and `settings.packs` lists. The schema's
separate 64-code-point
`createdAt` limit is also absent from that summary. These are omissions in the
contract's summary, not conflicting numerical values. The contract's abbreviated
`LexiconSettings` shape also omits `packs`, which the schema accepts.

## Examples at and beyond the limits

These examples use `parseLexicon` from `@ashlr/lexicon`; a rejected input
throws an `Invalid lexicon` error. Each example uses otherwise valid content.

| Limit | At the boundary | One over the boundary |
| --- | --- | --- |
| `word` | 80 code points in a canonical or each alias | 81 is rejected |
| `text` | 200 code points in each notes or phonetic field | 201 is rejected |
| `aliases` | 64 entries in each term's aliases or never list | 65 in either list is rejected |
| `terms` | 5000 terms in one file | 5001 is rejected |

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
assert.equal(parseLexicon({ terms: [{ canonical: `  ${word}​  ` }] }).terms[0].canonical, word);

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

See [term-capacity-reference.md](term-capacity-reference.md) for counts versus
lengths, [schema-collection-limits.md](schema-collection-limits.md) and
[schema-alias-count-boundary.md](schema-alias-count-boundary.md) for the list
caps and their errors, and [schema-text-limits.md](schema-text-limits.md) for
`notes` and `phonetic`.
