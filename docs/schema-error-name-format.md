# Schema error name format

When term validation finds U+FFFE, U+FFFF, or an unpaired UTF-16 surrogate
in a term's text, the error identifies the field and includes the term's
canonical name as `in term "…"`. The code after `must not contain` is the
first invalid code unit in that field; the name is the canonical, even if a
different field failed. This applies to `canonical`, `aliases`, `never`,
`phonetic`, `notes`, and `createdAt` when term-level validation runs. Settings
list errors do not include a term name.

The format comes from [`showTermName` and `refuseUnencodable`](../src/core/schema.ts):

1. The term schema strips its specified invisible characters and trims the
   canonical before the term-level check.
2. In the displayed name, each U+FFFE, U+FFFF, or unpaired surrogate becomes
   a literal `\uXXXX`, using four uppercase hexadecimal digits. A valid
   surrogate pair remains intact at this stage. Each escape is six UTF-16
   code units.
3. If the escaped name exceeds 40 UTF-16 code units, the first 39 units are
   retained and `…` is appended. A name of exactly 40 units is not shortened.

The cutoff is applied after escaping and counts code units, not bytes, Unicode
code points, or graphemes. It can cut through an escape or a valid surrogate
pair. Ordinary quotes and backslashes are not escaped, so this label is not a
serialized string or a way to recover the original name. Use the field path
and original input to locate and fix the invalid value.

## Example

The YAML escape below produces U+FFFF in the canonical name. There are 35
`A` characters before it; the six-unit display escape makes the name 41
units long. The cutoff leaves only `\uFF` of the escape before the ellipsis.

<!-- name-format-example -->
```yaml
terms:
  - canonical: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFFFF"
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFF…"
```

This is the complete error from [`parseLexicon`](../src/core/schema.ts),
which is verified by the documentation test. Other interfaces may add their
own context. See the [preview reference](schema-error-preview-reference.md)
for more boundary cases and the [first invalid unit guide](schema-first-invalid-unit.md)
for how the reported code is chosen.
