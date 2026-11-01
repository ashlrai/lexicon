# Schema collection limits

The [schema contract](CONTRACT.md#srccoreschemats) documents two inclusive
collection limits. They apply when validating a single lexicon object, such as
the contents of a lexicon file, through `LexiconSchema` or `parseLexicon`.

| Limit | Maximum | Validation definition |
| --- | ---: | --- |
| `LIMITS.aliases` | 64 | Per term's `aliases` list: `buildTerm` calls `WordList`, which uses `CleanWordList` and its array `.max(maxItems)` in [schema.ts](../src/core/schema.ts). |
| `LIMITS.terms` | 5000 | Per lexicon's `terms` array: `buildLexicon` applies `z.array(term).max(LIMITS.terms)` in [schema.ts](../src/core/schema.ts). |

The values are defined in [caps.ts](../src/core/caps.ts) and re-exported by
`schema.ts`. `TermSchema` exposes the same term validation independently of
`LexiconSchema`. The 64-entry cap is also used independently for each term's
`never` list and for `settings.packs` through `OptionalWordList`. The separate
`settings.protectedWords` cap is 1000; see the [full limit reference](schema-limit-reference.md).

For aliases, `CleanWordList` strips specified invisible characters, trims each
entry, and removes entries that are empty after cleaning before counting. It
does not deduplicate: repeated nonempty entries each count. Each remaining alias
must also pass the independent `LIMITS.word` length and character checks. An
absent or null `aliases` field becomes an empty array; a null list entry is an
error.

The terms limit counts array entries, including repeated terms. An absent or
null `terms` field becomes an empty array; a null entry is an error. These are
per-object schema limits, not a combined cap on a global and a project file
after they are merged. Other interfaces may impose additional limits.

At the boundary, 64 cleaned aliases and 5000 valid terms pass. One more yields
an error at the collection path, for example:

```text
terms[0].aliases: at most 64 aliases per term
terms: at most 5000 terms
```

`parseLexicon` prefixes these with `Invalid lexicon:` and formats each issue on
its own line. See [schema error examples](schema-error-examples.md) for more
about validation errors.
