# Which invalid code unit is reported first?

`findUnencodableChar` in [schema.ts](../src/core/schema.ts) scans a string
from left to right in UTF-16 code unit order. It returns the first U+FFFE,
U+FFFF or unpaired surrogate as an uppercase `U+XXXX` value, or `undefined`
when none is present. The choice is positional, not a priority by code value
or type. An adjacent high surrogate followed by a low surrogate is a valid
pair and neither half is reported; an unpaired high or low surrogate is
reported by its own code unit.

The schema applies this check separately to each term's `canonical`, `aliases`,
`never`, `phonetic`, `notes` and `createdAt`, and to each entry of settings
`protectedWords` and `packs`. Each affected field or list entry can produce
its own issue, with only its first invalid unit named. Before validation,
specified invisible characters are stripped and surrounding whitespace is
trimmed; empty list entries are removed, so list paths use the cleaned indexes.
Other validation failures can also be present, and `parseLexicon` lists at most
20 issues before counting the remainder.

## Example

The following double-quoted YAML escapes become code units when parsed. In the
first alias, the rocket is a valid pair; U+FFFF occurs before U+FFFE. In the
second alias the unpaired high surrogate comes first. The settings entry has
an unpaired low surrogate after a valid pair. The initial empty alias is removed,
so the two alias errors use indexes 0 and 1.

<!-- first-unit-example -->
```yaml
terms:
  - canonical: Rocket
    aliases: ["  ", "\uD83D\uDE80\uFFFF\uFFFE", "\uD800x\uFFFE"]
settings:
  protectedWords: ["\uD83D\uDE80\uDC00\uFFFF"]
```

```text
Invalid lexicon:
  - terms[0].aliases[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"
  - terms[0].aliases[1]: must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Rocket"
  - settings.protectedWords[0]: must not contain U+DC00 (U+FFFE, U+FFFF and unpaired surrogates fit no file format)
```

Replace or remove the reported unit in the original entry and validate again:
the next invalid unit in that entry can then be reported. The term name is a
display preview, described in [schema-error-preview.md](schema-error-preview.md).
Run `npx vitest run tests/schema-first-invalid-unit.test.ts` from the repository
root to verify this example against the parser.
