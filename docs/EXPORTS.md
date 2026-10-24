# Exports and imports

Getting your terms into a dictation app's own dictionary or an STT engine's biasing parameter, and bringing in a dictionary you already trained somewhere else.

One lexicon, fifteen ways out and eight ways in.

## Export into your dictation app

```bash
lexicon export <format> --out <file>
```

| Format | What you get | Where it goes |
|---|---|---|
| `wispr` | CSV `word,replacement` | Wispr Flow > Dictionary > Import |
| `superwhisper` | Replacements JSON | Superwhisper replacements |
| `macos` | Text Replacement `.plist` | Drag into System Settings > Keyboard > Text Replacements |
| `espanso` | espanso match YAML. A `{{` in a name is escaped as `\{\{`, so espanso types it instead of reading a variable; a name holding a literal `\{\{` or `\}\}` (which espanso always unescapes) is left out, named in a `# left out` comment at the top | `~/.config/espanso/match/lexicon.yml` |
| `whisper-prompt` | One line for Whisper `initial_prompt`, canonicals joined with `, ` | Any Whisper wrapper. Whisper reads only the last 224 tokens of a prompt, so the line keeps the most used names (at most 100) while it fits 223 tokens and leaves out the rest, named on stderr. The tokenizer is not bundled, so the count is an offline estimate that errs high (two letters a token, one per digit or punctuation mark, one per UTF-8 byte outside ASCII). Whisper reads the line as text it has already heard and never splits it, so a name holding `, ` still biases the right spelling, though a person cannot tell where it ends |
| `openai` | One line of canonicals | OpenAI transcription `prompt` field (same as `whisper-prompt`, with the same 224-token window; OpenAI documents it for `whisper-1`, and the newer models' own limit is not confirmed here, so the smaller window is kept) |
| `deepgram` | Keyword boost JSON (`keyword:boost`) | Deepgram `keywords` parameter. The format has no escape for a colon, so one in a name becomes a space (`Win:2` is written `Win 2:1`) |
| `assemblyai` | `word_boost` JSON | AssemblyAI `word_boost` / `boost_param`. At most 1,000 entries, the API's limit: a larger lexicon keeps its most used names |
| `azure` | `phraseList` JSON | Azure Speech `PhraseListGrammar`. At most 500 phrases, the most used kept: the size Azure documents for a phrase list, not confirmed offline |
| `google` | Adaptation `phraseSets` JSON | Google Speech-to-Text model adaptation (boost 20 for brand/person/product, 10 otherwise). A phrase over 100 characters (Google's per-phrase limit) is left out, and the set stops at 1,000 phrases, the most used kept, a conservative cap under the per-request phrase limit Google documents (limits not confirmed offline) |
| `claude-md` | Markdown table under `## Voice lexicon` | `CLAUDE.md`, `AGENTS.md`, any system prompt. Also what `lexicon://me` and the `SessionStart` hook emit |
| `markdown` | `- **Canonical** (category): aliases` bullets | READMEs, wikis |
| `text` | `Canonical: alias1, alias2` per line | Anything human-edited; `lexicon import` reads it back |
| `csv` | Generic `canonical,alias` | Anything else |
| `json` | Raw lexicon JSON | Scripts, backups |

`lexicon export` with no format lists them. `--category brand person` limits the export to those categories. `--limit N` caps term count. `--out` replaces the file in one step (a temp file and a rename, so an interrupted export never leaves half a file), creates missing directories, and refuses a directory or the lexicon file the export is read from. Names are written in Unicode NFC (the form typed and transcribed text uses) by every format but `json`, `text`, `markdown` and `claude-md`, which keep the file's own text; an alias written in two forms is one row, and a name in two forms is boosted once. The order is the same on every machine: names sort A to Z by a fixed English collation, not the system locale, so one lexicon always exports byte for byte the same and `--limit` keeps the same terms.

`--json` prints one document instead, for scripts and agents: `{ ok: true, format, terms, bytes, path }` after writing `--out` (`terms` counts what `--category` and `--limit` kept; the one-row-per-alias formats csv, wispr, superwhisper, macos and espanso add `rows`, the rows written, since a term without an alias writes none), `{ ok: true, format, terms, bytes, content }` with the export as a string when there is no `--out`, and `{ ok: true, formats }` with no format. A failure is `{ ok: false, error, nextStep }`.

Some targets have limits of their own (a list size, a per-phrase length, a prompt window, a cell a spreadsheet would run as a formula, a trigger two terms share). A format leaves out what does not fit rather than writing a file the target refuses or misreads, and says what it left out: one `lexicon: <format> export left out ...` line per kind on stderr, the same sentences under `dropped` with `--json`, a note block from MCP `export_lexicon`, and an `X-Lexicon-Note` header from `GET /export/:format` (which points at `--json` for the names). The export itself never carries the note.

Exporting into an STT engine's own biasing parameter (`whisper-prompt`, `deepgram`, `assemblyai`, `azure`, `google`) helps before the fact; the lexicon then fixes what the engine still got wrong. Both halves are measured in [BENCHMARK.md](BENCHMARK.md).

## Import the dictionary you already have

Already trained a dictation app? Bring its dictionary over in one command instead of retyping it. The format is detected from the content; pass it explicitly when the file has no header.

```bash
lexicon import ~/Downloads/wispr-dictionary.csv          # auto-detected
lexicon import - --format text < names.txt               # stdin
lexicon import replacements.json --project --dry-run     # preview into .lexicon.yaml, write nothing
lexicon import Text\ Substitutions.plist --category brand
lexicon import CLAUDE.md --dry-run                        # the ## Voice lexicon table, back in
```

| Format | What it reads | Where to get it |
|---|---|---|
| `wispr` | CSV `word,replacement` (header optional, BOM/CRLF fine) | Wispr Flow > Dictionary > Export |
| `superwhisper` | JSON `[{ original, replacement }]` or `{ replacements: [...] }` | Superwhisper replacements file |
| `macos` | Text Replacement `.plist` (`shortcut` = alias, `phrase` = canonical) | Drag entries out of System Settings > Keyboard > Text Replacements |
| `espanso` | `matches:` YAML (`trigger` = alias, `replace` = canonical; templates with `vars`, regex or multi-line replacements are skipped) | `~/.config/espanso/match/*.yml` |
| `markdown` | The `\| Canonical \| ... \|` table under `## Voice lexicon` (only that section is read), or `- **Canonical** (category): alias1, alias2` bullets | `lexicon export claude-md` / `lexicon export markdown`, or a CLAUDE.md / AGENTS.md you kept by hand |
| `text` | One term per line: `Canonical`, `Canonical: alias1, alias2` or `Canonical = alias1 \| alias2` (`Canonical =` alone for a canonical with a colon and no aliases); `#` comments, `\#Canonical` for a canonical that starts with `#`; a backslash escapes a separator inside a name (`A \= B` is the canonical "A = B", `a\\|b` and `a\,b` an alias holding `\|` or `,`, `\\` a backslash) | Anything you typed by hand, or `lexicon export text` |
| `csv` | `canonical,alias,category,phonetic` (columns matched by header) | `lexicon export csv` |
| `json` | A lexicon JSON or YAML file | `lexicon export json`, another machine's `lexicon.yaml` |

Rows are merged by canonical (case-insensitive), aliases deduped, and each term is then added with the same merge rules as `lexicon add`, so re-importing is safe. The output is a table of what was created or merged plus a summary line, `imported N terms (M new, K merged, S skipped)`; skipped rows and why go to stderr. Inputs over 8 MB are refused before parsing.

Flags for both commands are in the [CLI reference](CLI.md). Adding a new format is three files and a test: see [CONTRIBUTING.md](../CONTRIBUTING.md).

## See also

- [LIBRARY.md](LIBRARY.md) does the same bias-then-correct pass from your own code.
- [LEXICON-FILE.md](LEXICON-FILE.md) is the source every export is rendered from.
- [MATCHING.md](MATCHING.md) covers what the `whisper-prompt` export is biasing.

Back to [the docs index](README.md).
