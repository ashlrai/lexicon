# Schema error term-name previews

When term validation finds U+FFFE, U+FFFF or an unpaired UTF-16 surrogate in a
term's text, the error names the field path and includes a preview of the
term's canonical name as `in term "…"`. The preview helps identify the term
without counting entries in a long file. It is only a label in the error, not
a change to or repair of the lexicon. The examples below use double-quoted
YAML escapes, which YAML parses into code units; the displayed backslash
escapes in the errors are literal text.

## Which errors carry a preview

The term-level check covers `canonical`, `aliases`, `never`, `phonetic`,
`notes` and `createdAt` when the term reaches that validation. The preview is
always the canonical name, even when a different field failed. The code after
`must not contain` is the first offending code unit in the particular field or
list entry, which may differ from the ones in the canonical name; see the
[first invalid unit guide](schema-first-invalid-unit.md). The settings lists
`protectedWords` and `packs` are checked separately and their errors have no
term preview. Paths use zero-based indexes, and list indexes refer to the
cleaned list.

## Construction

The preview comes from [`showTermName` and `refuseUnencodable`](../src/core/schema.ts):

1. The term schema cleans the canonical first: it strips its specified
   invisible characters and trims surrounding whitespace.
2. **Every** U+FFFE, U+FFFF and unpaired surrogate in the cleaned name becomes
   a literal `\uXXXX` escape with four uppercase hex digits. A valid surrogate
   pair, such as an emoji, is left intact. Each escape occupies six UTF-16
   code units.
3. If the escaped label is at most 40 UTF-16 code units long, it is shown in
   full. Otherwise the preview holds its first 39 code units followed by `…`,
   for a total of 40. When that cut would land on the first half of a valid
   surrogate pair, it backs off one unit instead, so the label never holds
   half a pair.

The cutoff is applied after escaping and counts UTF-16 code units, not bytes,
Unicode code points or graphemes. A supplementary character such as `🚀`
occupies two units. The cut can split an escape, but not a valid surrogate
pair. This is a limit on the error label, not the length limit for a valid
canonical. Ordinary quotes and backslashes are not escaped, so the label is
not a serialized string or a way to recover the original name.

| Cleaned canonical | Label in the error | Reason |
| --- | --- | --- |
| `Acme` followed by U+FFFE and U+D800 | `Acme\uFFFE\uD800` | Both unencodable units are escaped. |
| 34 `A`s followed by U+FFFF | 34 `A`s followed by `\uFFFF` | The escaped label is exactly 40 units. |
| 35 `A`s followed by U+FFFF | 35 `A`s followed by `\uFF…` | The 41-unit label is cut inside the escape. |

## Examples

Each example below is the complete error from
[`parseLexicon`](../src/core/schema.ts), checked by
`tests/schema-error-preview.test.ts`. Other interfaces may add their own
context.

Both unencodable units in the canonical are escaped, and the alias error
carries the same preview:

<!-- preview-example -->
```yaml
terms:
  - canonical: "Acme\uFFFE\uD800"
    aliases: ["bad\uFFFF"]
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE\uD800"
  - terms[0].aliases[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE\uD800"
```

At exactly 40 code units after escaping, the whole label is shown:

<!-- preview-example -->
```yaml
terms:
  - canonical: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFFFF"
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFFFF"
```

One more `A` makes the escaped label 41 code units, so the cut leaves only
`\uFF` of the escape before the ellipsis:

<!-- preview-example -->
```yaml
terms:
  - canonical: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFFFF"
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFF…"
```

Use the field path and original input to locate and replace the offending code
unit; a truncated preview may not contain the complete name or escape. See
[schema-error-examples.md](schema-error-examples.md) for more fields,
[Unicode error previews](schema-unicode-error-examples.md) for focused
surrogate and noncharacter examples, and
[schema-limit-reference.md](schema-limit-reference.md) for validation limits.
