# Schema error preview reference

When term-level validation finds an unencodable code unit, the issue names
the field and includes `in term "…"`, using the canonical name as a label.
This reference describes that label in `src/core/schema.ts`; it does not
change or repair the input. See [schema error examples](schema-error-examples.md)
for complete messages.

## Construction

1. The canonical is first normalized by the term schema: specified invisible
   characters are stripped and surrounding whitespace is trimmed.
2. Every U+FFFE, U+FFFF, and unpaired UTF-16 surrogate in that cleaned name
   is replaced in the label by a literal `\uXXXX`, with four uppercase hex
   digits. A valid surrogate pair is preserved. Each escape occupies six
   UTF-16 code units.
3. If the escaped label exceeds 40 UTF-16 code units, it is cut and `…` is
   appended. The cut keeps at most 39 code units before the ellipsis, and
   when the cut would land between the halves of a valid surrogate pair the
   whole pair is left out instead. Otherwise it is shown in full. The
   ellipsis is included in the 40-unit limit.

The cutoff counts UTF-16 code units, not Unicode code points, graphemes or
bytes. A supplementary character such as `🚀` occupies two units. A cut can
split an escape, but never a valid surrogate pair: a pair at the boundary is
dropped whole, so the label never holds an unpaired surrogate the input did
not have. The label is not a serialization format: ordinary
quotes and backslashes in the canonical are not escaped by this operation.
Use the field path and original input to identify and fix the offending value.

| Cleaned canonical | Label in the error | Reason |
| --- | --- | --- |
| `Acme` followed by U+FFFE and U+D800 | `Acme\uFFFE\uD800` | Both unencodable units are escaped. |
| 34 `A`s followed by U+FFFF | 34 `A`s followed by `\uFFFF` | The escaped label is exactly 40 units. |
| 35 `A`s followed by U+FFFF | 35 `A`s followed by `\uFF…` | The 41-unit label is cut inside the escape. |

The code after `must not contain` reports the first unencodable unit in the
particular field or list entry, which can differ from the canonical label.
This term-level check covers `canonical`, `aliases`, `never`, `phonetic`,
`notes`, and `createdAt` when the term reaches that validation. The settings
lists `protectedWords` and `packs` are checked separately and their errors
have no term label. Paths use zero-based indexes into cleaned lists. The
preview limit is separate from field validation limits; see the
[schema limit reference](schema-limit-reference.md) and the
[preview guide](schema-error-preview.md).
