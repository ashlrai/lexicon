# Schema collection limits

The [schema contract](CONTRACT.md#srccoreschemats) defines these inclusive
limits for a parsed lexicon file:

| Collection | Maximum | Scope |
| --- | ---: | --- |
| `terms` | 5000 | Terms in one file |
| `aliases` | 64 | Entries in each term's `aliases` list |
| `never` | 64 | Entries in each term's `never` list |

The two per-term lists have separate limits: one term can have 64 aliases and
64 `never` entries. Each term gets its own limits. The parser strips specified
invisible characters and trims each list entry, then removes empty entries before
counting. Duplicate entries still count. An omitted or null `aliases` list
becomes `[]`; an omitted or null `never` list stays absent, while an explicit
`never: []` remains present.

A collection at its limit is accepted if its contents are otherwise valid; a
5001st term or a 65th nonempty entry in either list is rejected. Each list entry
must also satisfy the word and character rules. These are file-schema limits;
other interfaces can impose additional limits. See the [full schema limit
reference](schema-limit-reference.md) and [boundary examples](contract-limit-examples.md).
