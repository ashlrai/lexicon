# Notes and phonetic text limits

The [schema contract](CONTRACT.md#srccoreschemats) defines `LIMITS.text` as
200 for a term's `notes` and `phonetic` fields. Each optional field has its own
inclusive limit: 200 Unicode code points are accepted, while 201 are rejected.
The limit applies to each field of each term, not to their combined length.

The schema strips its specified invisible characters and trims leading and
trailing whitespace before measuring. A supplementary character such as an
emoji counts as one code point; combining marks count separately. Control
characters and line breaks remaining after cleaning are rejected, as are
U+FFFE, U+FFFF and unpaired surrogates. See the contract for the full character
rules. An empty YAML `notes:` or `phonetic:` value is treated as absent.

For example, with `@ashlr/lexicon` installed:

```js
import assert from 'node:assert/strict';
import { parseLexicon } from '@ashlr/lexicon';

const text = '🙂'.repeat(200);
const term = parseLexicon({ terms: [{ canonical: 'X', notes: `  ${text}\u200b  `, phonetic: text }] }).terms[0];
assert.equal(term.notes, text); // Padding and the zero-width space are removed.
assert.equal(term.phonetic, text);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', notes: `${text}🙂` }] }), /notes: must be at most 200 characters/);
assert.throws(() => parseLexicon({ terms: [{ canonical: 'X', phonetic: `${text}🙂` }] }), /phonetic: must be at most 200 characters/);
```

These are file-schema limits; other interfaces may impose additional limits.
See the [schema limit reference](schema-limit-reference.md) for the other fields.
