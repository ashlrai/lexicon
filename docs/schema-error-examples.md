# Schema error examples

These examples show the message thrown by `parseLexicon` after YAML is parsed.
Each input is invalid. The `\u` sequences in the double-quoted YAML strings
represent code units, not literal backslash text. The paths use zero-based
indexes. Other surfaces may add their own context around the message.

## Invalid code units in terms

<!-- schema-example -->
```yaml
terms:
  - canonical: "Acme\uFFFE"
    aliases: ["bad\uFFFF", "x\uD800"]
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE"
  - terms[0].aliases[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE"
  - terms[0].aliases[1]: must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE"
```

The code after `must not contain` identifies the first U+FFFE, U+FFFF or
unpaired surrogate in that field or list entry. Each affected entry can get
its own error. A valid surrogate pair, such as an emoji, is accepted. The
term name in the message escapes each invalid code unit as uppercase `\uXXXX`;
the escape is a display representation, not a repair to the input. Remove or
replace the offending code unit in the original field and validate again.

This check covers `canonical`, `aliases`, `never`, `phonetic`, `notes` and
`createdAt`. Invisible characters are stripped and outer whitespace trimmed
before these checks; empty list entries are removed, so a list index refers to
the cleaned list.

## Invalid code units in settings

<!-- schema-example -->
```yaml
settings:
  protectedWords: ["bad\uFFFF"]
  packs: ["bad\uD800"]
```

```text
Invalid lexicon:
  - settings.protectedWords[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format)
  - settings.packs[0]: must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format)
```

These settings errors have a field path but no term name. An unpaired low
surrogate is also reported by its own code unit, for example `U+DC00` below.

## Shortened term names

<!-- schema-example -->
```yaml
terms:
  - canonical: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
    notes: "bad\uDC00"
```

```text
Invalid lexicon:
  - terms[0].notes: must not contain U+DC00 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA…"
```

The 41-character canonical is valid; only its label in the error is shortened.
The schema first escapes invalid code units in the cleaned canonical, then, if
the resulting label exceeds 40 UTF-16 code units, keeps the first 39 and adds
`…`. This is a display limit, separate from the canonical's length limit.
Because the cut is by code unit, it can even split an escape or a surrogate
pair; use the field path and the original input to find the full name.

<!-- schema-example -->
```yaml
terms:
  - canonical: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFFFF"
    aliases: ["bad\uFFFE"]
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\u…"
  - terms[0].aliases[0]: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\u…"
```

Here the `\uFFFF` in the canonical becomes a six-unit display escape, and
the preview cuts that escape after `\u`. The error still identifies U+FFFF in
the canonical and U+FFFE in the alias independently.

`parseLexicon` lists at most 20 issues, then reports how many remain. Fix the
listed fields and validate again to see any further issues.
