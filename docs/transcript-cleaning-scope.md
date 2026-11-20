# Transcript cleaning

`lexicon voice` cleans the transcript whisper.cpp returns before the lexicon
corrects any spelling. The function is `cleanTranscript` in
[src/voice/transcribe.ts](../src/voice/transcribe.ts); it runs inside
`transcribeFile`, and its result is the `raw` field of `TranscribeResult` (and
of voice JSON and history), before `normalize()` produces `output`. Its
contract is the `src/voice/transcribe.ts` entry in [CONTRACT.md](CONTRACT.md),
and [VOICE.md](VOICE.md) describes the pipeline it sits inside. Cleaning is
based on the shape of text, not on whether the speaker intended it as an
annotation, so literal dictated text that matches a rule is lost and an
annotation that does not match is kept.

This page is the single reference: the rules, then example tables for each
rule. Every table and the JSON list at the end are run through
`cleanTranscript` by the tests, so they cannot drift from the code. `""` in a
table means the empty string, not two quotation marks.

## Rules

Each pass replaces a matching span with a space. The passes run in this order,
and the sequence repeats until the text stops changing:

1. **Square brackets.** Every `[...]` span from `[` through the next `]`,
   whatever it contains.
2. **Parentheses.** A `(...)` span of one to three ASCII-letter words that
   looks like a noise tag (see [Parentheses](#parentheses) for the word list).
3. **Asterisks.** A single-asterisk `*...*` span of one to three ASCII-letter
   words, whatever they say.
4. **Whitespace.** All whitespace, including newlines and tabs, collapses to
   single spaces, and both ends are trimmed. If nothing remains, the result is
   the empty string.

## Square brackets

Every complete `[...]` span is replaced with a space, regardless of its
contents. This includes ordinary dictated text as well as sound tags. Adjacent
spans are removed independently, and a tag touching words does not join those
words. A tag directly followed by `.`, `,`, `;`, `:`, `!` or `?` is removed
together with any whitespace before it, so the punctuation stays attached to
the preceding word. A span ends at the first `]`, so brackets are not nested.
An unmatched opening bracket is left in the transcript, and so is a closing
bracket with no opening one.

| Input | Cleaned |
| --- | --- |
| `[BLANK_AUDIO]` | `""` |
| `Please [background noise] continue.` | `Please continue.` |
| `Please[door closes]send the report.` | `Please send the report.` |
| `Hello[MUSIC][inaudible]world` | `Hello world` |
| `[noise][inaudible] Continue.` | `Continue.` |
| `Keep [this important phrase] please` | `Keep please` |
| `Keep [] here` | `Keep here` |
| `Hello [noise].` | `Hello.` |
| `Wait [MUSIC], then go` | `Wait, then go` |
| `A [outer [inner] tail] B` | `A tail] B` |
| `Hello [unfinished thought` | `Hello [unfinished thought` |
| `Keep unfinished] here` | `Keep unfinished] here` |

## Asterisks

A complete `*...*` span is replaced with a space when it contains one to three
plain words. Here a word consists only of ASCII letters; words may be separated
by any whitespace, but whitespace cannot sit next to either asterisk. The words
need not describe a sound: `*important*` is removed too. Four or more words,
digits, punctuation, and unmatched asterisks do not match this short-tag shape,
and neither do non-ASCII letters. This is pattern matching, not Markdown
emphasis: `**bold**` loses its inner `*bold*` span and leaves the two outer
asterisks behind.

| Input | Cleaned |
| --- | --- |
| `Please *laughs* continue.` | `Please continue.` |
| `Please*door slams*continue.` | `Please continue.` |
| `Before *door slams loudly* after` | `Before after` |
| `Please *door  slams* continue.` | `Please continue.` |
| `This is *important* today` | `This is today` |
| `*cough*` | `""` |
| `Keep **bold** here` | `Keep * * here` |
| `Keep **the door slams loudly** here` | `Keep **the door slams loudly** here` |
| `Keep *the door slams loudly* here` | `Keep *the door slams loudly* here` |
| `Keep *room 2* here` | `Keep *room 2* here` |
| `Keep *well-known* here` | `Keep *well-known* here` |
| `Keep *hello!* and *café* here` | `Keep *hello!* and *café* here` |
| `Keep * cough * here` | `Keep * cough * here` |
| `Keep ** here` | `Keep ** here` |
| `Keep *unfinished here` | `Keep *unfinished here` |
| `Keep unfinished* here` | `Keep unfinished* here` |

## Parentheses

A `(...)` span is replaced with a space only when it holds one to three
ASCII-letter words that look like a noise annotation: either the whole span
matches the noise-word list, or its last word does (`(soft music)`,
`(loud applause)`). The check is case-insensitive. The list is `NOISE_WORDS`
in [src/voice/transcribe.ts](../src/voice/transcribe.ts): `applause`, `laugh`,
`laughs`, `laughter`, `laughing`, `music`, `silence`, `noise`, `inaudible`,
`unintelligible`, `cough`, `coughs`, `coughing`, `sigh`, `sighs`, `clapping`,
`static`, `breathing`, `beep`, `beeps`, `beeping`, `clear throat`,
`clears throat`, `crosstalk`, `speaking in ...`, `foreign language`, `typing`,
`chuckle`, `chuckles` and `pause`. An ordinary parenthetical at the same
shape, like `(the new build)`, is kept, and so is any span whose contents do
not fit the one-to-three-plain-words shape: punctuation, digits, non-ASCII
letters, extra words or spaces just inside the parentheses.

| Input | Cleaned |
| --- | --- |
| `(soft music) hello (applause)` | `hello` |
| `Hello (speaking in French) there` | `Hello there` |
| `Keep (CLEARS THROAT) here` | `Keep here` |
| `Hello (clear throat) there.` | `Hello there.` |
| `Keep (loud applause) here` | `Keep here` |
| `Send (the new build) tonight` | `Send (the new build) tonight` |
| `Keep (quite the loud applause) here` | `Keep (quite the loud applause) here` |
| `Keep (speaking in a foreign language) here` | `Keep (speaking in a foreign language) here` |
| `Keep (music!) here` | `Keep (music!) here` |
| `Keep ( music ) here` | `Keep ( music ) here` |

## Boundaries

The passes run in a fixed order: brackets, parentheses, asterisks, then
whitespace, and the whole sequence repeats until the text stops changing, so
a span removed by a later pass can also complete an earlier one (`(soft
*noise* music)` loses `*noise*` first, after which `(soft music)` qualifies
as a noise tag). A span removed by an earlier pass can complete a later one
(`*hello [noise] world*` cleans to a space), and a span that fails its own
shape check keeps its delimiters even when a later pass removes what was
inside (`(*laughs*)` leaves `( )`). Adjacent asterisk spans are matched left
to right, so an unmatched asterisk can remain after a matching span is
removed.

Cleaning belongs to the voice pipeline only. `normalize()` does none of it,
so neither do the surfaces built on it: `lexicon normalize`, the MCP
`normalize_transcript` tool, the Claude Code hooks, `lexicon serve` and the
clipboard daemon. Typed or pasted text holding real brackets or emphasis is
never cleaned. And cleaning only strips annotation shapes; it never corrects
spelling. That second step is `normalize()` in `src/core`. Review the
transcript when literal bracketed or starred text matters, since cleaning can
remove dictated words.

| Input | Cleaned |
| --- | --- |
| `Keep (*laughs*) here` | `Keep ( ) here` |
| `Before *hello [noise] world* after` | `Before after` |
| `Keep *laughs**coughs* here` | `Keep here` |
| `Keep *one*two* here` | `Keep two* here` |

## Other cleaning

After tag removal, all whitespace is collapsed to single spaces and leading
and trailing whitespace is trimmed. A transcript containing only removed tags
can therefore become empty.

| Input | Cleaned |
| --- | --- |
| `  Hello   [MUSIC]  there  ` | `Hello there` |
| `Please send the report. [MUSIC]` | `Please send the report.` |
| `[MUSIC][static]` | `""` |

## Examples as JSON

The same behavior as a machine-readable list. Each `input` and `cleaned` value
is a JSON string, so `\n` is a newline, `\t` a tab and `""` an empty result.

```json
[
  { "input": "[BLANK_AUDIO]", "cleaned": "" },
  { "input": "[MUSIC] Hello [inaudible] there", "cleaned": "Hello there" },
  { "input": "Hello[noise][applause]world", "cleaned": "Hello world" },
  { "input": "Keep [these words] and [] go", "cleaned": "Keep and go" },
  { "input": "Hello [unfinished thought", "cleaned": "Hello [unfinished thought" },
  { "input": "Keep unfinished] here", "cleaned": "Keep unfinished] here" },
  { "input": "before [outer [inner] after] end", "cleaned": "before after] end" },
  { "input": "Wait *laughs* please", "cleaned": "Wait please" },
  { "input": "A *door slams* B *door slams loudly* C", "cleaned": "A B C" },
  { "input": "This is *important* today", "cleaned": "This is today" },
  { "input": "Keep *the door slams loudly* here", "cleaned": "Keep *the door slams loudly* here" },
  { "input": "Keep *well-done* and *v2* and *café*", "cleaned": "Keep *well-done* and *v2* and *café*" },
  { "input": "(applause) hello (soft music) there", "cleaned": "hello there" },
  { "input": "Deploy (the new build) tonight", "cleaned": "Deploy (the new build) tonight" },
  { "input": "  Hello\n[MUSIC]\t world  ", "cleaned": "Hello world" }
]
```

## Source references

- [`cleanTranscript`](../src/voice/transcribe.ts): the ordered replace passes.
  `NOISE_WORDS` and `isNoiseTag`, in the same file, decide which
  parenthesized spans count as noise annotations.
- [CONTRACT.md](CONTRACT.md): the `src/voice/transcribe.ts` entry is the module
  contract for `cleanTranscript` and the rest of the voice pipeline.
- [tests/transcribe.test.ts](../tests/transcribe.test.ts),
  [tests/clean-transcript-contract.test.ts](../tests/clean-transcript-contract.test.ts),
  [tests/voice.test.ts](../tests/voice.test.ts) and
  [src/voice/transcribe-asterisk-boundaries.test.ts](../src/voice/transcribe-asterisk-boundaries.test.ts):
  the pinned cleaning cases.
- [tests/transcript-cleaning-scope.test.ts](../tests/transcript-cleaning-scope.test.ts):
  runs every example table and the JSON list in this document through
  `cleanTranscript`.

Back to [the docs index](README.md).
