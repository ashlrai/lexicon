# Transcript cleaning examples

In `lexicon voice`, whisper.cpp's transcript is cleaned before lexicon
corrections are applied. The examples show the cleaned `raw` result, not the
later normalized `output`. Other input surfaces calling `normalize()` do not
perform this cleaning. See the [full cleaning reference](voice-cleaning-reference.md)
and [module contract](CONTRACT.md) for details.

## Square brackets

Every span from `[` to the next `]` is replaced with a space, even when it
contains ordinary dictated words. An unmatched opening bracket is preserved.
Brackets are not parsed as nested structures.

| Input | Cleaned output |
|---|---|
| `[BLANK_AUDIO]` | `""` |
| `Hello [MUSIC] there.` | `Hello there.` |
| `Send[door closes]the report.` | `Send the report.` |
| `[noise][inaudible] Continue.` | `Continue.` |
| `Keep [the title] here.` | `Keep here.` |
| `Keep [unfinished` | `Keep [unfinished` |
| `A [outer [inner] tail] B` | `A tail] B` |

## Asterisks

A span delimited by single asterisks is replaced with a space when it contains
one to three ASCII-letter words separated by whitespace. The words do not have
to describe a sound. Four words, punctuation, digits, non-ASCII letters, or
spaces just inside the delimiters prevent a match. This is pattern matching,
not Markdown parsing.

| Input | Cleaned output |
|---|---|
| `Please *laughs* continue.` | `Please continue.` |
| `Please *door slams* continue.` | `Please continue.` |
| `Please*door slams loudly*continue.` | `Please continue.` |
| `This is *important* today.` | `This is today.` |
| `*cough*` | `""` |
| `Keep *these four spoken words* here.` | `Keep *these four spoken words* here.` |
| `Keep *hello!* and *café* here.` | `Keep *hello!* and *café* here.` |
| `Keep * hello * here.` | `Keep * hello * here.` |
| `Keep **bold** here.` | `Keep * * here.` |

The cleaner also removes recognized parenthesized noise annotations, then
collapses whitespace and trims the result. For example, `(soft music) Hello`
becomes `Hello`; `(the new build)` stays. See the
[full reference](voice-cleaning-reference.md) for those rules and examples.

Back to [the docs index](README.md).
