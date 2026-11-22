# Exports and imports

Getting your terms into a dictation app's own dictionary or an STT engine's biasing parameter, bringing in a dictionary you already trained somewhere else, and collecting names from your contacts, calendar and GitHub.

One lexicon, sixteen ways out and eight ways in.

## Export into your dictation app

```bash
lexicon export <format> --out <file>
```

| Format | What you get | Where it goes |
|---|---|---|
| `wispr` | CSV `word,replacement` (LF line ends, no byte order mark) | Wispr Flow > Dictionary > Import. A pair with a cell a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`, after any spaces, or with a tab or a carriage return) is left out and named on stderr: Wispr Flow reads each cell as the word itself, so the spreadsheet escape would be typed into transcripts. Add such a name in Wispr Flow by hand. A word two terms share (compared as written) is written once, for the more used term, and the other is named on stderr |
| `superwhisper` | Replacements JSON. An `original` two terms share (compared as written) is written once, for the more used term, and the other is named on stderr | Superwhisper replacements |
| `macos` | Text Replacement `.plist` | Drag into System Settings > Keyboard > Text Replacements. Control characters XML cannot hold (possible only in a lexicon built in code) are removed. A shortcut two terms share (compared ignoring case, the cautious reading of how macOS matches them, not confirmed offline) is written once, for the more used term, and the other is named on stderr |
| `espanso` | espanso match YAML. A `{{` in a name is escaped as `\{\{`, so espanso types it instead of reading a variable; a name holding a literal `\{\{` or `\}\}` (which espanso always unescapes) is left out, named in a `# left out` comment at the top and on stderr. Every string is double-quoted, so a name such as `yes`, `on`, `~` or `0o7` is never read as a boolean, null or number by any YAML version. A trigger two terms share is written once, for the more used term (ties go to brand, person and product, then A to Z), and the other is named on stderr | `~/.config/espanso/match/lexicon.yml` |
| `whisper-prompt` | One line for Whisper `initial_prompt`, canonicals joined with `, `, each once with its whitespace collapsed | Any Whisper wrapper. Whisper reads only the last 224 tokens of a prompt, so the line keeps the most used names (at most 100) while it fits 223 tokens and leaves out the rest, named on stderr. The tokenizer is not bundled, so the count is an offline estimate that errs high (two letters a token, one per digit or punctuation mark, one per UTF-8 byte outside ASCII). Neither Whisper nor OpenAI defines a separator for the list, so a name holding a comma (or starting with a double quote) is written in double quotes with inner quotes doubled, CSV style (`"Crosby, Stills & Nash"`), and reads as one name; its quotes count toward the token window |
| `openai` | One line of canonicals, a name holding a comma quoted as for `whisper-prompt` | OpenAI transcription `prompt` field (same as `whisper-prompt`, with the same 224-token window; OpenAI documents it for `whisper-1`, and the newer models' own limit is not confirmed here, so the smaller window is kept) |
| `deepgram` | JSON with `keyterm` (the names as written, whitespace collapsed, each once, at most 100) and `keywords` (`keyword:boost`) | `keyterm` is the default: send each entry as a `keyterm=` parameter to Nova-3, Deepgram's current model, which does not take `keywords`. The 100 cap is conservative; Deepgram's own keyterm limit is not confirmed offline. `keywords` is for Nova-2 and older. It has no escape for a colon, so one in a name becomes a space (`Win:2` is written `Win 2:1`), and a name that then reads as one already listed is written once, for the more used term, and named on stderr |
| `assemblyai` | `word_boost` JSON | AssemblyAI `word_boost` / `boost_param`. At most 1,000 entries, the API's limit: a larger lexicon keeps its most used names. A name of more than 6 words (AssemblyAI's per-phrase limit as last documented, not confirmed offline) is left out and named |
| `speechmatics` | `additional_vocab` JSON | Speechmatics custom dictionary: one `{ "content": canonical, "sounds_like": [aliases] }` per term (no `sounds_like` when a term has no alias), for `transcription_config.additional_vocab`. At most 1,000 entries (as last documented, not confirmed offline): a larger lexicon keeps its most used names and names the rest |
| `azure` | `phraseList` JSON | Azure Speech `PhraseListGrammar`. At most 500 phrases, the most used kept: the size Azure documents for a phrase list, not confirmed offline |
| `google` | Adaptation `phraseSets` JSON | Google Speech-to-Text model adaptation (boost 20 for brand/person/product, 10 otherwise). A phrase over 100 characters (Google's per-phrase limit) is left out, and the set stops at 1,000 phrases, the most used kept, a conservative cap under the per-request phrase limit Google documents (limits not confirmed offline) |
| `claude-md` | Markdown table under `## Voice lexicon` | `CLAUDE.md`, `AGENTS.md`, any system prompt. Also what `lexicon://me` and the `SessionStart` hook emit |
| `markdown` | `- **Canonical** (category): aliases` bullets | READMEs, wikis |
| `text` | `Canonical: alias1, alias2` per line | Anything human-edited; `lexicon import` reads it back |
| `csv` | Generic `canonical,alias,category,phonetic` (LF line ends, no byte order mark, so a script reads the first header as `canonical`) | Anything else, spreadsheets included: a cell a spreadsheet would run as a formula (starting with `=`, `+`, `-` or `@`, after any spaces, or with a tab or a carriage return) is written as text with a leading `'`, and stderr says how many. `lexicon import` keeps that `'` as part of the name. To see accents in Excel, open it with Data > From Text/CSV and pick UTF-8 |
| `json` | Raw lexicon JSON: the fields a lexicon file holds. `scope` and `hits`, which the merged view adds (which file a term came from, and this user's counts from `hits.json`), are left out, so a backup does not change with every corrected prompt; `lexicon list --json`, `lexicon stats --json` and the MCP `lexicon://json` resource still report them | Scripts, backups |

`lexicon export` with no format lists them. `--category brand person` (or `--category brand,person`) limits the export to those categories. `--limit N` caps term count. `--out` replaces the file in one step (a temp file and a rename, so an interrupted export never leaves half a file), creates missing directories, and refuses a directory or the lexicon file the export is read from. Names are written in Unicode NFC (the form typed and transcribed text uses) by every format but `json`, `text`, `markdown` and `claude-md`, which keep the file's own text; an alias written in two forms is one row, and a name in two forms is boosted once. The order is the same on every machine. The one-row-per-alias formats (csv, wispr, superwhisper, macos, espanso) and `json` keep the lexicon's own term order; `text` sorts names A to Z, `claude-md` and `markdown` by category and then A to Z, and the engine formats (`whisper-prompt`, `openai`, `deepgram`, `assemblyai`, `speechmatics`, `azure`, `google`) most hits first, then brand, person and product terms, then A to Z. A to Z is a fixed English collation, not the system locale, so one lexicon always exports byte for byte the same and `--limit` keeps the same terms.

`--json` prints one document instead, for scripts and agents: `{ ok: true, format, terms, bytes, path }` after writing `--out` (`terms` counts what `--category` and `--limit` kept, and for whisper-prompt and openai the names the line holds after its 100-name default and the prompt-token window; the one-row-per-alias formats csv, wispr, superwhisper, macos and espanso add `rows`, the rows written, since a term without an alias writes none), `{ ok: true, format, terms, bytes, content }` with the export as a string when there is no `--out`, and `{ ok: true, formats }` with no format. A failure is `{ ok: false, error, nextStep }`.

Some targets have limits of their own (a list size, a per-phrase length, a prompt window, a cell a spreadsheet would run as a formula, a trigger two terms share). A format leaves out what does not fit rather than writing a file the target refuses or misreads, and says what it left out: one `lexicon: <format> export left out ...` line per kind on stderr, the same sentences under `dropped` with `--json`, a note block from MCP `export_lexicon`, and an `X-Lexicon-Note` header from `GET /export/:format` (which points at `?json=1` and `--json` for the names), and `dropped` in `GET /export/:format?json=1`. The export itself never carries the note.

Exporting into an STT engine's own biasing parameter (`whisper-prompt`, `deepgram`, `assemblyai`, `speechmatics`, `azure`, `google`) helps before the fact; the lexicon then fixes what the engine still got wrong. Both halves are measured in [BENCHMARK.md](BENCHMARK.md).

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

### Scripts, agents and failure paths

- **Preview.** `--dry-run` reads the target file, marks each row `new` or `merged`, writes nothing and ends with `dry run (<format>): would have imported N terms (M new, K merged, S skipped) into global lexicon <path>`. A real run ends with the same summary plus `[<format>]`, where `<format>` is the one detected when you left it out. A real run on a file with nothing to import prints `nothing to import (<format>): ...` and exits 0.
- **Category and source.** `--category` fills in only terms the file gave no category. `--source` sets the provenance stamped on each term (default `import`; one of `user`, `harvest:repo`, `harvest:git`, `harvest:package`, `import`, `import:contacts`, `import:calendar`, `import:github`, `learned`, `pack`). An unknown value of either is refused with the list.
- **Encoding.** UTF-8 is read as is, and a UTF-16 file with a byte order mark is decoded. A file in another encoding (a Windows-1252 export, say) is refused by name before the lexicon is touched, with an `iconv` and a PowerShell command that convert it, since importing it as UTF-8 would store the wrong spelling.
- **Project files.** `--project` writes the `.lexicon.yaml` at the git root. An untrusted one is refused before any term is written, with `lexicon trust` as the next step; `--project --dry-run` still previews against it.
- **JSON.** `--json` prints `{ ok: true, format, scope, dryRun, terms: [{ canonical, aliases, created }], skipped: [{ line, reason }], counts: { total, created, merged, skipped }, path }`. `created` is `true` for a new term and `false` for a merge; `path` is the target file, left out by a real run that imported nothing.
- **Failures** exit 1, and under `--json` print `{ ok: false, error, nextStep }`: an unknown format (stderr also lists the formats), a format given both as the argument and as `--format` with different values, a `--guided`-only flag (`--sources`, `--limit`, `--yes`, `--preview-id`, `--accept`, `--home`) without `--guided`, no file argument, a missing file or a directory, an unknown `--category` or `--source`, an encoding it will not guess, an input over 8 MB, and an untrusted project file.

## Import names from your contacts, calendar and GitHub

No dictionary to bring over? `lexicon import --guided` collects candidate names from where they already live, and you approve each one before anything is written.

```bash
lexicon import --guided                     # on a terminal: pick sources, then review
lexicon import --guided --dry-run           # same picker, prints the candidates, writes nothing
lexicon import --guided --sources github --json    # preview for scripts and agents
```

| Source | What it reads | Needs |
|---|---|---|
| `contacts` | First and last names (as `person`) and organizations (as `brand`) from the local macOS Contacts database, opened read-only | macOS, a database under `~/Library/Application Support/AddressBook`, `sqlite3` on PATH |
| `calendar` | Attendee and organizer names (as `person`) and proper nouns in event titles (as `other`) from the `.ics` files under `~/Library/Calendars` | macOS, that directory |
| `github` | Your profile name and username, the members and repos of up to 20 of your orgs, and up to 200 of your own repos (logins as `identifier`, repos as `product`) | `gh` installed and logged in; it calls `api.github.com` with that login and asks for no new scopes |

Nothing is read until you pick a source, and a source that is not available is skipped with the reason. Email and Slack are listed but not implemented: they would need new OAuth scopes or a workspace token. A name found more than once, in any source, is one candidate (compared ignoring case) with its counts and evidence added up; candidates are reviewed most frequent first, at most `--limit` of them (default 50). The review uses the same keys as `lexicon harvest --interactive`: `y` adds, `n` skips, `e` edits the aliases, `c` changes the category, `a` adds the rest, `q` quits. Approved names go through the same merge rules as `lexicon add`, tagged `import:contacts`, `import:calendar` or `import:github`; `--project` writes to `.lexicon.yaml` and is refused for an untrusted one.

Off a terminal nothing is chosen for you: every run must name `--sources`. A write takes two steps. The `--json` preview returns a `previewId` and an `id` for each candidate; then pass the ones the user approved:

```bash
lexicon import --guided --sources github --yes --preview-id <previewId> --accept <id>,<id>
```

The `previewId` covers the sources, the destination (global or project, and the file path, not what is in it) and every candidate, so if any of them changed since the preview the write is refused and you preview again. The MCP `import_vocabulary` tool is the same flow for agents (preview, then apply with the preview's token and the approved ids). Candidate previews go to whatever client asked for them, so an agent's model provider may see them. [DESIGN-VOCABULARY-IMPORT.md](../DESIGN-VOCABULARY-IMPORT.md) is the design record.

### Scripts, agents and guided-import failures

- **Previews.** Off a terminal, `--sources <list> --dry-run` prints the same candidate list as on a terminal (`dry run: N candidates (nothing written)`, grouped by source tag) and `--sources <list> --json` prints it as JSON. `--json` without `--yes` is always a preview, even with `--preview-id` and `--accept`, and `--yes --dry-run` is a preview too. A plain run off a terminal with `--sources` but neither flag is refused and points at the `--json` preview.
- **JSON.** The preview prints `{ ok: true, sources: [{ id, label, available, chosen, reason? }], candidates: [{ id, canonical, category, source, aliases, evidence, count }], previewId, dryRun: true, added: 0, merged: 0, skipped: 0 }`. `sources` lists all five; one you did not pick says `not selected; availability was not probed`, and one you picked that cannot be read carries the reason (`email` and `slack` never can). A write prints the same shape with `dryRun: false`, `accepted: true|false` on each candidate, the real `added`, `merged` and `skipped` counts and the `path` written. The text form of a write is `imported N terms (A new, M merged, S skipped) into <path>`.
- **Approving.** `--accept` takes candidate ids from that preview, comma-separated. Every id not listed counts as skipped, so `--accept ''` writes nothing and exits 0. A name already in the lexicon is merged, as with `lexicon add`. The `previewId` does not change when only the lexicon's contents change, so a preview stays valid after an earlier import into the same file.
- **Nothing to import.** A picked source that is unavailable is skipped with its reason. When none is left the run prints `no usable import source selected; nothing imported.` (or the JSON report with no candidates) and exits 0; when the sources hold no names it prints `no candidates found in the chosen sources.` and exits 0. `--limit 0` reviews no candidates.
- **Project files.** `--project --dry-run` and the `--json` preview still read the sources against an untrusted `.lexicon.yaml`; a `--yes` write to one is refused before any candidate is collected, with `lexicon trust` as the next step. Adding `--project` to a write also changes the destination, so it needs a preview taken with `--project`.
- **Failures** exit 1, and under `--json` print `{ ok: false, error, nextStep }`: no `--sources` off a terminal or with `--json` or `--yes` (even with `--dry-run`), an unknown source (the error lists `contacts, calendar, github, email, slack`), a `--limit` that is not a non-negative integer, `--yes` without both `--preview-id` and `--accept`, a `--preview-id` that is not a 64-character hex digest, a preview that no longer matches (`source contents or destination changed since preview`), an accepted id the preview does not have (`approved candidate is absent from the preview`), and an untrusted project file.

`--home <dir>` reads the sources as if `<dir>` were your home directory; it exists for tests.

Flags for both commands are in the [CLI reference](CLI.md). Adding a new format is three files and a test: see [CONTRIBUTING.md](../CONTRIBUTING.md).

## See also

- [LIBRARY.md](LIBRARY.md) does the same bias-then-correct pass from your own code.
- [LEXICON-FILE.md](LEXICON-FILE.md) is the source every export is rendered from.
- [MATCHING.md](MATCHING.md) covers what the `whisper-prompt` export is biasing.

Back to [the docs index](README.md).
