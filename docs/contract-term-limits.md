# Contract term limits

The [schema contract](CONTRACT.md#srccoreschemats) documents these inclusive
`LIMITS` for a parsed lexicon file:

| Limit | Maximum | Fields and unit |
| --- | ---: | --- |
| `word` | 80 | Unicode code points in each term's `canonical` and each `aliases` entry |
| `text` | 200 | Unicode code points in each term's `notes` and `phonetic` field |
| `aliases` | 64 | Entries in each term's `aliases` list and `never` list, counted separately |
| `terms` | 5000 | Entries in the file's `terms` list |
| `protectedWords` | 1000 | Entries in `settings.protectedWords` |

These limits are inclusive. String lengths are measured after the schema
strips specified invisible characters and trims whitespace. Code points are
counted individually, so a supplementary character counts once and combining
marks count separately. A canonical must remain nonempty. Empty word-list
entries are removed before counting, while duplicates still count. Each alias
must fit the word limit as well as its list fitting the aliases limit. The
schema also rejects control characters and unencodable characters in cleaned
values; see the contract for details.

The contract's summary names the fields above, but the schema also applies the
word limit to each `never`, `settings.protectedWords`, and `settings.packs`
entry, and the aliases limit to the `settings.packs` list. A term's `createdAt`
has a separate 64-code-point limit. See the [schema limit reference](schema-limit-reference.md)
for the full field mapping and [contract limit examples](contract-limit-examples.md)
for executable boundary examples. Other interfaces can impose additional limits.
