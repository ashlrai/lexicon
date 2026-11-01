# Schema error term-name previews

When `parseLexicon` rejects an unencodable code unit in a term, its error
includes the field path and a preview of the term's canonical name. The
preview helps identify the term without counting entries in a long file. It is
only a label in the error, not a change to the lexicon. The examples below use
double-quoted YAML escapes, which YAML parses into code units; the displayed
backslash escapes in the errors are literal text.

## Escaping

The schema rejects U+FFFE, U+FFFF and unpaired UTF-16 surrogates in term
text. In the preview, **every** such code unit in the canonical name becomes
an uppercase, six-character `\uXXXX` escape. A valid surrogate pair, such as
an emoji, is left intact. The code after `must not contain` identifies the
first offending code unit in the particular field, which may differ from the
ones in the canonical name.

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

## Length limit

The canonical is cleaned first: the schema strips its specified invisible
characters and trims surrounding whitespace. It then escapes unencodable code
units for the preview. If that result is at most 40 UTF-16 code units long, it
is shown in full. Otherwise the preview contains its first 39 UTF-16 code
units followed by `…`, for a total of 40. This is a limit on the error label,
not the length limit for a valid canonical. An escape consumes six code units
and a supplementary character consumes two, so this cut can split either an
escape or a surrogate pair.

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

One more `A` makes the escaped label 41 code units, so the cut falls inside
the escape:

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
unit; a truncated preview may not contain its complete name or escape. The
paths use zero-based indexes, and list indexes refer to the cleaned list.
Settings errors identify a path but do not include a term preview. See
[schema-error-examples.md](schema-error-examples.md) for more fields and
[schema-limit-reference.md](schema-limit-reference.md) for validation limits.
The [preview reference](schema-error-preview-reference.md) details the
construction and its UTF-16 boundary behavior.
