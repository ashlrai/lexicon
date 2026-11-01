# Unicode error previews

`parseLexicon` rejects U+FFFE, U+FFFF and unpaired UTF-16 surrogates in
term text. These examples show its complete errors after the YAML is parsed.
In each input, a double-quoted YAML `\uXXXX` escape produces a code unit;
backslash escapes in the error preview are literal display text. Other
interfaces may add context around the error.

## Unpaired surrogate

<!-- unicode-example -->
```yaml
terms:
  - canonical: "Acme\uD800"
    aliases: ["Acme tools"]
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+D800 (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uD800"
```

The high surrogate U+D800 has no following low surrogate. The error names the
invalid code unit and shows it as the uppercase escape `\uD800` in the term
label. A valid surrogate pair is accepted.

## Noncharacter

<!-- unicode-example -->
```yaml
terms:
  - canonical: "Acme\uFFFE"
    notes: "bad\uFFFF"
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFE (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE"
  - terms[0].notes: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "Acme\uFFFE"
```

The code after `must not contain` is the first invalid code unit in that
field. Both errors use the cleaned canonical name as the label, even when a
different field is invalid. This check specifically rejects U+FFFE and U+FFFF;
it is not a blanket rejection of every Unicode noncharacter.

## Preview limit

The schema strips its specified invisible characters and trims the canonical
before constructing the label. It escapes every rejected code unit in the
cleaned name as six literal characters (`\uXXXX`), then limits the label to
40 UTF-16 code units. If it is longer, the first 39 units are followed by
`…`. This limit includes the ellipsis and applies only to the error label.

Here, 35 `A` characters plus the six-character escape make 41 units. The
cut falls inside the escape:

<!-- unicode-example -->
```yaml
terms:
  - canonical: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFFFF"
```

```text
Invalid lexicon:
  - terms[0].canonical: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format) in term "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\uFF…"
```

The cut can also split a valid surrogate pair: the limit counts UTF-16 code
units, not code points. Use the zero-based field path and the original input
to find and replace the invalid unit; the preview is a label, not a repair or
a serialized copy of the name. List indexes refer to the cleaned list.
See the [preview reference](schema-error-preview-reference.md) for details and
[schema error examples](schema-error-examples.md) for settings errors.
