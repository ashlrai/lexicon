# Transcript cleaning scope

`cleanTranscript` prepares whisper.cpp output for the voice pipeline before
lexicon normalization. It lives in
[src/voice/transcribe.ts](../src/voice/transcribe.ts) and runs inside
`transcribeFile`; its result is the `raw` field of `TranscribeResult`, before
`normalize()` produces `output`. Its contract is the `src/voice/transcribe.ts`
entry in [CONTRACT.md](CONTRACT.md). Cleaning is based on the shape of text,
not on whether the speaker intended it as an annotation.

## Square brackets

Every complete `[...]` span is replaced with a space, regardless of its
contents. This includes ordinary dictated text as well as sound tags. Adjacent
spans are removed independently, and a tag touching words does not join those
words. A span ends at the first `]`, so brackets are not nested. An unmatched
opening bracket is left in the transcript, and so is a closing bracket with no
opening one.

| Input | Cleaned |
| --- | --- |
| `[BLANK_AUDIO]` | `""` |
| `Please [background noise] continue.` | `Please continue.` |
| `Hello[MUSIC][inaudible]world` | `Hello world` |
| `Keep [this important phrase] please` | `Keep please` |
| `Keep [] here` | `Keep here` |
| `A [outer [inner] tail] B` | `A tail] B` |
| `Hello [unfinished thought` | `Hello [unfinished thought` |
| `Keep unfinished] here` | `Keep unfinished] here` |

## Asterisks

A complete `*...*` span is replaced with a space when it contains one to three
plain words. Here a word consists only of ASCII letters; words may be separated
by whitespace, but whitespace cannot sit next to either asterisk. The words
need not describe a sound: `*important*` is removed too. Four or more words,
digits, punctuation, and unmatched asterisks do not match this short-tag shape.
This is pattern matching, not Markdown emphasis: `**bold**` loses its inner
`*bold*` span and leaves the two outer asterisks behind.

| Input | Cleaned |
| --- | --- |
| `Please *laughs* continue.` | `Please continue.` |
| `Please*door slams*continue.` | `Please continue.` |
| `Before *door slams loudly* after` | `Before after` |
| `This is *important* today` | `This is today` |
| `Keep **bold** here` | `Keep * * here` |
| `Keep *the door slams loudly* here` | `Keep *the door slams loudly* here` |
| `Keep *room 2* here` | `Keep *room 2* here` |
| `Keep *well-known* here` | `Keep *well-known* here` |
| `Keep * cough * here` | `Keep * cough * here` |
| `Keep ** here` | `Keep ** here` |
| `Keep *unfinished here` | `Keep *unfinished here` |
| `Keep unfinished* here` | `Keep unfinished* here` |

## Parentheses

A `(...)` span is replaced with a space only when it holds one to three
ASCII-letter words that look like a noise annotation: either the whole span
matches the noise-word list, or its last word does (`(soft music)`,
`(loud applause)`). The check is case-insensitive and covers tags like
`applause`, `laughs`, `music`, `clears throat`, `speaking in ...` and
`foreign language`; the full list is `NOISE_WORDS` in
[src/voice/transcribe.ts](../src/voice/transcribe.ts) and is spelled out in
[voice-cleaning-reference.md](voice-cleaning-reference.md). An ordinary
parenthetical at the same shape, like `(the new build)`, is kept, and so is
any span whose contents do not fit the one-to-three-plain-words shape.

| Input | Cleaned |
| --- | --- |
| `(soft music) hello (applause)` | `hello` |
| `Hello (speaking in French) there` | `Hello there` |
| `Keep (CLEARS THROAT) here` | `Keep here` |
| `Keep (loud applause) here` | `Keep here` |
| `Send (the new build) tonight` | `Send (the new build) tonight` |
| `Keep (quite the loud applause) here` | `Keep (quite the loud applause) here` |
| `Keep (speaking in a foreign language) here` | `Keep (speaking in a foreign language) here` |
| `Keep (music!) here` | `Keep (music!) here` |

## Boundaries

The passes run in a fixed order: brackets, parentheses, asterisks, then
whitespace. A span removed by an earlier pass can complete a later one
(`*hello [noise] world*` cleans to a space), and a span that fails its own
shape check keeps its delimiters even when a later pass removes what was
inside (`(*laughs*)` leaves `( )`).

Cleaning belongs to the voice pipeline only. `normalize()` does none of it,
so neither do the surfaces built on it: `lexicon normalize`, the MCP
`normalize_transcript` tool, the Claude Code hooks, `lexicon serve` and the
clipboard daemon. Typed or pasted text holding real brackets or emphasis is
never cleaned. And cleaning only strips annotation shapes; it never corrects
spelling. That second step is `normalize()` in `src/core`.

| Input | Cleaned |
| --- | --- |
| `Keep (*laughs*) here` | `Keep ( ) here` |
| `Before *hello [noise] world* after` | `Before after` |
| `Keep *laughs**coughs* here` | `Keep here` |
| `Keep *one*two* here` | `Keep two* here` |

## Other cleaning

After tag removal, all whitespace is collapsed to single spaces and leading
and trailing whitespace is trimmed. A transcript containing only removed tags
can therefore become empty, shown as `""` in these tables.

| Input | Cleaned |
| --- | --- |
| `  Hello   [MUSIC]  there  ` | `Hello there` |
| `Please send the report. [MUSIC]` | `Please send the report.` |
| `[MUSIC][static]` | `""` |

## Source references

- [`cleanTranscript`](../src/voice/transcribe.ts): the four ordered replace
  passes. `NOISE_WORDS` and `isNoiseTag`, in the same file, decide which
  parenthesized spans count as noise annotations.
- [CONTRACT.md](CONTRACT.md): the `src/voice/transcribe.ts` entry is the module
  contract for `cleanTranscript` and the rest of the voice pipeline.
- [tests/transcribe.test.ts](../tests/transcribe.test.ts),
  [tests/clean-transcript-contract.test.ts](../tests/clean-transcript-contract.test.ts),
  [tests/voice.test.ts](../tests/voice.test.ts) and
  [src/voice/transcribe-asterisk-boundaries.test.ts](../src/voice/transcribe-asterisk-boundaries.test.ts):
  the pinned cleaning cases.
- [tests/transcript-cleaning-scope.test.ts](../tests/transcript-cleaning-scope.test.ts):
  runs every example table in this document through `cleanTranscript`, so the
  tables cannot drift from the code.

## See also

- [voice-cleaning-reference.md](voice-cleaning-reference.md): the full rule
  list, including every recognized noise word.
- [transcript-cleaning-examples.md](transcript-cleaning-examples.md): more
  input and output pairs, including ordering cases.
- [transcript-tag-examples.md](transcript-tag-examples.md): the short version
  as a JSON example list.
- [VOICE.md](VOICE.md): the `lexicon voice` pipeline this cleaning sits inside.

Back to [the docs index](README.md).
