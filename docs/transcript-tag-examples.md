# Transcript tag cleaning examples

In `lexicon voice`, Whisper's transcript is cleaned before the lexicon corrects
spellings. The `raw` field in voice JSON and history is already cleaned; `output`
is the subsequent lexicon-normalized text. The examples below show only the
cleaning step, with no spelling corrections. See [VOICE.md](VOICE.md) for the
voice pipeline and [CONTRACT.md](CONTRACT.md) for the module contract.

Square brackets remove everything from `[` through the next `]`, regardless of
the contents. This includes ordinary dictated text, empty brackets and adjacent
tags. An unmatched opening bracket remains. Square brackets are not parsed as
nested structures.

Starred spans are removed when they contain one to three words made only of
ASCII letters, separated by whitespace. The words need not describe a sound:
`*important*` is removed too. Four-word spans and spans containing punctuation,
digits or accented letters do not match as a whole. Parenthesized spans of up
to three ASCII-letter words are removed only when they look like noise tags;
ordinary parentheticals remain. Removed spans become spaces, then all whitespace
is collapsed to single spaces and leading and trailing whitespace is trimmed.

Each `input` and `cleaned` value below is a JSON string, so `\n` represents a
newline and `""` represents an empty result.

```json
[
  { "input": "[BLANK_AUDIO]", "cleaned": "" },
  { "input": "[MUSIC] Hello [inaudible] there", "cleaned": "Hello there" },
  { "input": "Hello[noise][applause]world", "cleaned": "Hello world" },
  { "input": "Keep [these words] and [] go", "cleaned": "Keep and go" },
  { "input": "Hello [unfinished thought", "cleaned": "Hello [unfinished thought" },
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

These rules apply to `lexicon voice` transcription, not generally to every
text normalization entry point. Review the transcript when literal bracketed
or starred text matters, since cleaning can remove dictated words.
