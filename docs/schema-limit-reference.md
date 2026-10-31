# Lexicon schema limit reference

These are inclusive limits for a single parsed lexicon file. The public
contract is [CONTRACT.md](CONTRACT.md#srccoreschemats); the implementation is
[schema.ts](../src/core/schema.ts), which imports and re-exports `LIMITS` from
[caps.ts](../src/core/caps.ts). They describe file-schema validation, not every
separate limit imposed by the CLI, MCP tools, importers, or exporters.

| Limit | Maximum | Schema fields and unit |
| --- | ---: | --- |
| `word` | 80 | Unicode code points per `canonical`, each `aliases` or `never` entry, and each `settings.protectedWords` or `settings.packs` entry |
| `text` | 200 | Unicode code points per `phonetic` or `notes` field |
| `aliases` | 64 | Entries per term's `aliases` list, per term's `never` list, and per `settings.packs` list; each list has its own cap |
| `terms` | 5000 | Terms per lexicon file |
| `protectedWords` | 1000 | Entries in `settings.protectedWords` per lexicon file |
| `createdAt` | 64 | Unicode code points in a term's `createdAt`; this is a separate literal in the schema, not a `LIMITS` member |

String lengths are checked after the schema strips its specified invisible
characters and trims whitespace. A canonical must remain nonempty. For word
lists the schema also removes empty entries before counting; it does not
deduplicate entries. The text and list limits are independent: for example,
each alias must fit the word limit and its list must fit the aliases limit.
The schema also rejects control characters and unencodable characters; see the
contract for details. A supplementary Unicode character counts as one code point,
not two UTF-16 code units.

## Contract and source comparison

The numerical `LIMITS` values stated in the contract agree with the source.
The contract's `LIMITS` summary names only canonical and alias for `word`, and
only aliases and `never` for `aliases`. The schema additionally applies `word`
to `never`, `settings.protectedWords`, and `settings.packs` entries, and applies
`aliases` to the `settings.packs` list. The schema's separate 64-code-point
`createdAt` limit is also absent from that summary. These are omissions in the
contract's summary, not conflicting numerical values. The contract's abbreviated
`LexiconSettings` shape also omits `packs`, which the schema accepts.
