# Exports and imports

Getting your terms into a dictation app's own dictionary or an STT engine's biasing parameter, and bringing in a dictionary you already trained somewhere else.

One lexicon, fifteen ways out and seven ways in.

## Export into your dictation app

```bash
lexicon export <format> --out <file>
```

| Format | What you get | Where it goes |
|---|---|---|
| `wispr` | CSV `word,replacement` | Wispr Flow > Dictionary > Import |
| `superwhisper` | Replacements JSON | Superwhisper replacements |
| `macos` | Text Replacement `.plist` | Drag into System Settings > Keyboard > Text Replacements |
| `espanso` | espanso match YAML | `~/.config/espanso/match/lexicon.yml` |
| `whisper-prompt` | One line for Whisper `initial_prompt` | Any Whisper wrapper. Keep it under about 100 terms or it stops helping |
| `openai` | One line of canonicals | OpenAI transcription `prompt` field (same as `whisper-prompt`) |
| `deepgram` | Keyword boost JSON | Deepgram `keywords` parameter |
| `assemblyai` | `word_boost` JSON | AssemblyAI `word_boost` / `boost_param` |
| `azure` | `phraseList` JSON | Azure Speech `PhraseListGrammar` |
| `google` | Adaptation `phraseSets` JSON | Google Speech-to-Text model adaptation (boost 20 for brand/person/product, 10 otherwise) |
| `claude-md` | Markdown table under `## Voice lexicon` | `CLAUDE.md`, `AGENTS.md`, any system prompt. Also what `lexicon://me` and the `SessionStart` hook emit |
| `markdown` | `- **Canonical** (category): aliases` bullets | READMEs, wikis |
| `text` | `Canonical: alias1, alias2` per line | Anything human-edited; `lexicon import` reads it back |
| `csv` | Generic `canonical,alias` | Anything else |
| `json` | Raw lexicon JSON | Scripts, backups |

`lexicon export` with no format lists them. `--category brand person` limits the export to those categories. `--limit N` caps term count.

Exporting into an STT engine's own biasing parameter (`whisper-prompt`, `deepgram`, `assemblyai`, `azure`, `google`) helps before the fact; the lexicon then fixes what the engine still got wrong. Both halves are measured in [BENCHMARK.md](BENCHMARK.md).

## Import the dictionary you already have

Already trained a dictation app? Bring its dictionary over in one command instead of retyping it. The format is detected from the content; pass it explicitly when the file has no header.

```bash
lexicon import ~/Downloads/wispr-dictionary.csv          # auto-detected
lexicon import - --format text < names.txt               # stdin
lexicon import replacements.json --project --dry-run     # preview into .lexicon.yaml, write nothing
lexicon import Text\ Substitutions.plist --category brand
```

| Format | What it reads | Where to get it |
|---|---|---|
| `wispr` | CSV `word,replacement` (header optional, BOM/CRLF fine) | Wispr Flow > Dictionary > Export |
| `superwhisper` | JSON `[{ original, replacement }]` or `{ replacements: [...] }` | Superwhisper replacements file |
| `macos` | Text Replacement `.plist` (`shortcut` = alias, `phrase` = canonical) | Drag entries out of System Settings > Keyboard > Text Replacements |
| `espanso` | `matches:` YAML (`trigger` = alias, `replace` = canonical; templates with `vars`, regex or multi-line replacements are skipped) | `~/.config/espanso/match/*.yml` |
| `text` | One term per line: `Canonical`, `Canonical: alias1, alias2` or `Canonical = alias1 \| alias2`; `#` comments | Anything you typed by hand, or `lexicon export text` |
| `csv` | `canonical,alias,category,phonetic` (columns matched by header) | `lexicon export csv` |
| `json` | A lexicon JSON or YAML file | `lexicon export json`, another machine's `lexicon.yaml` |

Rows are merged by canonical (case-insensitive), aliases deduped, and each term is then added with the same merge rules as `lexicon add`, so re-importing is safe. The output is a table of what was created or merged plus a summary line, `imported N terms (M new, K merged, S skipped)`; skipped rows and why go to stderr. Inputs over 8 MB are refused before parsing.

Flags for both commands are in the [CLI reference](CLI.md). Adding a new format is three files and a test: see [CONTRIBUTING.md](../CONTRIBUTING.md).

## See also

- [LIBRARY.md](LIBRARY.md) does the same bias-then-correct pass from your own code.
- [LEXICON-FILE.md](LEXICON-FILE.md) is the source every export is rendered from.
- [MATCHING.md](MATCHING.md) covers what the `whisper-prompt` export is biasing.

Back to [the docs index](README.md).
