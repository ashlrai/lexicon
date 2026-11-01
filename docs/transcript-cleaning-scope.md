# Transcript cleaning scope

`cleanTranscript` prepares Whisper output for the voice pipeline before lexicon
normalization. Its contract is in [CONTRACT.md](CONTRACT.md). Cleaning is based
on the shape of text, not on whether the speaker intended it as an annotation.

## Square brackets

Every complete `[...]` span is replaced with a space, regardless of its contents.
This includes ordinary dictated text as well as sound tags. Adjacent spans are
removed independently, and a tag touching words does not join those words.
An opening bracket without a closing bracket is left in the transcript.

| Input | Cleaned |
| --- | --- |
| `[BLANK_AUDIO]` | `""` |
| `Please [background noise] continue.` | `Please continue.` |
| `Hello[MUSIC][inaudible]world` | `Hello world` |
| `Keep [this important phrase] please` | `Keep please` |
| `Hello [unfinished thought` | `Hello [unfinished thought` |

## Asterisks

A complete `*...*` span is replaced with a space when it contains one to three
plain words. Here a word consists only of ASCII letters; words may be separated
by whitespace, but whitespace cannot sit next to either asterisk. The words need
not describe a sound: `*important*` is removed too. Four or more words, digits,
punctuation, and unmatched asterisks do not match this short-tag shape.

| Input | Cleaned |
| --- | --- |
| `Please *laughs* continue.` | `Please continue.` |
| `Please*door slams*continue.` | `Please continue.` |
| `Before *door slams loudly* after` | `Before after` |
| `This is *important* today` | `This is today` |
| `Keep *the door slams loudly* here` | `Keep *the door slams loudly* here` |
| `Keep *room 2* here` | `Keep *room 2* here` |
| `Keep *well-known* here` | `Keep *well-known* here` |
| `Keep * cough * here` | `Keep * cough * here` |
| `Keep *unfinished here` | `Keep *unfinished here` |

## Other cleaning

Parenthesized spans of one to three words are removed only when they look like
noise annotations; ordinary parentheticals are kept. After tag removal, all
whitespace is collapsed to single spaces and leading and trailing whitespace is
trimmed. A transcript containing only removed tags can therefore become empty,
shown as `""` in these tables.

| Input | Cleaned |
| --- | --- |
| `(soft music) hello (applause)` | `hello` |
| `Send (the new build) tonight` | `Send (the new build) tonight` |
| `  Hello   [MUSIC]  there  ` | `Hello there` |
