# Voice transcript cleaning reference

`lexicon voice` cleans the transcript returned by whisper.cpp before applying
lexicon corrections. Its `raw` result is already cleaned; `output` is the
subsequent normalized result. This cleaning is specific to the voice transcription
pipeline, not a general rule applied by `normalize()` or other input surfaces.
See [VOICE.md](VOICE.md) and the [module contract](CONTRACT.md).

## Rules

Cleaning applies these rules in order:

1. Replace each square-bracketed span, from `[` through the next `]`, with a
   space, regardless of its contents. This also removes dictated text inside
   brackets. An unmatched opening bracket is left in the transcript. Brackets
   are not parsed as nested structures.
2. Replace a parenthesized span with a space only when it contains one to three
   ASCII-letter words separated by whitespace and looks like a noise tag. The
   check is case-insensitive. It recognizes `applause`, `laugh`, `laughs`,
   `laughter`, `laughing`, `music`, `silence`, `noise`, `inaudible`,
   `unintelligible`, `cough`, `coughs`, `coughing`, `sigh`, `sighs`,
   `clapping`, `static`, `breathing`, `beep`, `beeps`, `beeping`,
   `clear throat`, `clears throat`, `crosstalk`, `speaking in ...`,
   `foreign language`, `typing`, `chuckle`, `chuckles`, and `pause`. A span
   also qualifies if its last word alone is a recognized tag, such as
   `(soft music)`. Punctuation, digits, non-ASCII letters, extra words, or
   spaces immediately inside the parentheses prevent the span from matching.
3. Replace any single-asterisk-delimited span of one to three ASCII-letter
   words separated by whitespace with a space. The words need not describe a
   sound: `*important*` is removed too. Punctuation, digits, non-ASCII letters,
   extra words, or spaces immediately inside the asterisks prevent that span
   from matching. This is pattern matching, not Markdown parsing; for example,
   `**bold**` leaves `* *` after the inner match is removed.
4. Collapse all remaining whitespace, including newlines and tabs, to single
   spaces and trim both ends. Replacing a tag with a space keeps adjacent words
   separated. If nothing remains, the result is an empty string.

The word limits apply to each match. The matcher does not recognize nested tags
or interpret punctuation as part of a word. Literal content that matches a rule
can therefore be lost, while an annotation that does not match is preserved.

## Examples

Each output below is the cleaned transcript, before lexicon corrections. `""`
denotes the empty string.

| Whisper transcript | Cleaned transcript |
|---|---|
| `Please[door closes]send the report.` | `Please send the report.` |
| `[MUSIC][inaudible] Ready.` | `Ready.` |
| `Keep [the new title] here.` | `Keep here.` |
| `Keep [unfinished thought` | `Keep [unfinished thought` |
| `[BLANK_AUDIO]` | `""` |
| `(APPLAUSE) Hello (soft music) there.` | `Hello there.` |
| `Hello (speaking in French) there.` | `Hello there.` |
| `Hello (clear throat) there.` | `Hello there.` |
| `Deploy (the new build) tonight.` | `Deploy (the new build) tonight.` |
| `Keep (music!) and (soft background music playing).` | `Keep (music!) and (soft background music playing).` |
| `Keep ( music ) here.` | `Keep ( music ) here.` |
| `Ready *cough* now.` | `Ready now.` |
| `Ready*door slams loudly*now.` | `Ready now.` |
| `This is *important* today.` | `This is today.` |
| `Keep *these four spoken words* intact.` | `Keep *these four spoken words* intact.` |
| `Keep *hello!* and *café* here.` | `Keep *hello!* and *café* here.` |
| `Keep * hello * here.` | `Keep * hello * here.` |
| `Keep **bold** here.` | `Keep * * here.` |

Back to [the docs index](README.md).
