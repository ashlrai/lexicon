# Dogfood: @ashlr/lexicon against the real Claude Code CLI

Live run of the hook + MCP integration through the headless CLI, on the
maintainer's machine, with the maintainer's real lexicon. Nothing in `src/`
was changed for this run; the proposed fixes at the end were verified on a
scratch copy of `dist/`.

| | |
| --- | --- |
| Date | 2026-09-19 |
| Claude Code | 2.1.257 |
| Model (from result JSON) | `claude-fable-5-1` (settings: `fable[1m]`, 1M context) |
| Install mode | Manual (README option b): hooks in `~/.claude/settings.json` -> `plugin/hook.mjs`, MCP server `lexicon` at user scope -> `plugin/mcp-server.mjs`. The plugin (option a) is NOT installed, so `skills/lexicon/SKILL.md` was not in context for any run. |
| Lexicon | Global `~/.config/lexicon/lexicon.yaml`, 36 terms (Ashlr.AI, Mason Wyatt, ashlrcode, Vercel, Supabase, SaaS with `never: [sauce]`, Kubernetes, ...). No project file: every run used a scratch directory outside any git repo. |
| Other hooks present | wrkpad (SessionStart + UserPromptSubmit) and Measurably (UserPromptSubmit) run alongside the lexicon hook. They are relevant to the latency numbers only. |
| Permission mode | The user's settings set `defaultMode: bypassPermissions`, so `--allowedTools` was passed but never exercised (see Findings). |
| API calls used | 11 headless calls total. |

Every command below ran from `<scratch>/eN/` with the Bash timeout at 120s,
`< /dev/null` on stdin (without it `claude -p` waits 3s for piped input and
warns), and stdout/stderr captured to files.

## 1. Hook-only path: PASS

```bash
claude -p "write one sentence telling ashler and mason white that the versel deploy is done" --output-format json
```

Hook output for this prompt (verified by piping the same payload to
`plugin/hook.mjs` directly):

```text
Voice lexicon corrections for this prompt (the user dictated; apply these):
"ashler" -> "Ashlr.AI" (alias, 1.00)
"mason white" -> "Mason Wyatt" (alias, 1.00)
"versel" -> "Vercel" (alias, 1.00)
Corrected prompt:
write one sentence telling Ashlr.AI and Mason Wyatt that the Vercel deploy is done
```

Answer:

> Hi Ashlr.AI team and Mason Wyatt, the Vercel deploy is done and live.

Tool calls: none (1 turn). `duration_ms` 4846, `duration_api_ms` 2418. All
three corrections applied; no mention of the corrections in the reply, which
is the behavior SKILL.md asks for on exact alias hits.

## 2. Tool path: PASS

```bash
claude -p "Use the lexicon normalize_transcript tool on this text and show me the corrected version: ping ashlar about the soup a base migration" \
  --output-format stream-json --verbose --allowedTools "mcp__lexicon" "mcp__lexicon__normalize_transcript"
```

`system/init` event: `lexicon` listed as `connected`; nine `mcp__lexicon__*`
tools present (`add_term, export_lexicon, harvest_repo, learn_correction,
lexicon_stats, list_terms, normalize_transcript, remove_term,
suggest_canonical`) plus the `mcp__lexicon__voice-context` prompt.

Tool calls observed, in order:

1. `ToolSearch {"query":"select:mcp__lexicon__normalize_transcript"}` (Claude Code defers MCP tool schemas when many servers are configured; the model has to load the schema first)
2. `mcp__lexicon__normalize_transcript {"text":"ping ashlar about the soup a base migration"}` -> `{"output":"ping Ashlr.AI about the Supabase migration","changed":true,"replacements":[{"original":"ashlar","replacement":"Ashlr.AI","reason":"alias","confidence":1},{"original":"soup a base","replacement":"Supabase",...}]}`

Answer:

> Corrected version:
> > ping Ashlr.AI about the Supabase migration
>
> Two exact alias hits, both at full confidence: "ashlar" -> Ashlr.AI, "soup a base" -> Supabase

3 turns, `duration_ms` 8463, `duration_api_ms` 6821. Note the
UserPromptSubmit hook had also fired on this prompt (it contains "ashlar" and
"soup a base"), so the model had the corrected text in context before it
called the tool; it still called the tool because the user asked for it
explicitly.

## 3. Learn path: PASS (with a hook bug, see Findings)

```bash
cp ~/.config/lexicon/lexicon.yaml lex.yaml
LEXICON_PATH=<scratch>/e3/lex.yaml claude -p "it's Ashlr.AI not Ashlur. remember that." \
  --output-format stream-json --verbose --allowedTools "mcp__lexicon" "mcp__lexicon__learn_correction"
```

Hook output for this prompt (with `LEXICON_PATH` set, verified directly):

```text
Voice lexicon corrections for this prompt (the user dictated; apply these):
"Ashlur" -> "Ashlr.AI" (phonetic, 0.90)
Corrected prompt:
it's Ashlr.AI not Ashlr.AI. remember that.
The user is correcting a spelling: "Ashlur. remember that" should be "Ashlr.AI". Call the lexicon learn_correction tool with these values, then continue.
```

Two problems in that note, both in the hook, neither fatal here:

- `heard` is `"Ashlur. remember that"`: `parseCorrection` swallowed the next sentence.
- The "Corrected prompt" line reads `it's Ashlr.AI not Ashlr.AI`: the phonetic matcher rewrote the very word the user was pointing at.

Tool calls observed:

1. `ToolSearch {"query":"select:mcp__lexicon__learn_correction"}`
2. `mcp__lexicon__learn_correction {"heard":"Ashlur","meant":"Ashlr.AI"}` -> term Ashlr.AI now lists alias `Ashlur`, scope global

Answer:

> Saved. "Ashlur" now maps to Ashlr.AI in the global lexicon -> future dictation auto-corrects it.

`diff lex.before.yaml lex.yaml`: `+ - Ashlur` under Ashlr.AI (and `hits: 6 -> 8`).
`grep -c Ashlur ~/.config/lexicon/lexicon.yaml` -> 0, so `LEXICON_PATH`
was honored by both the hook and the MCP server spawned by claude, and the
real lexicon was untouched. 3 turns, `duration_ms` 8284, `duration_api_ms` 6532.

The model ignored the garbage tail in `heard` and passed the bare word. That
is the model covering for the hook; a smaller model or a longer tail would
likely have saved `"Ashlur. remember that"` as an alias.

## 4. Session context path: PASS

```bash
claude -p "what does my voice lexicon say Ashler means? answer in five words" --output-format stream-json --verbose
```

Answer (no tool calls, 1 turn):

> Brand alias for Mason's company.

"Ashler" is not in the prompt as a correction, so the UserPromptSubmit hook
did fire (it rewrote "Ashler" to "Ashlr.AI") but that note carries no
category or notes. "Brand" and "Mason's company" can only have come from the
SessionStart table (`| Ashlr.AI | ... | brand Mason's company; never write Ashler or Ashlar (ASH-ler) |`).
So the SessionStart hook runs in `-p` mode and its context is read.
`duration_ms` 3601, `duration_api_ms` 2369.

## 5. Negative: PASS

```bash
claude -p "pass the sauce and head off to the store, reply with exactly the same sentence" --output-format json
```

Hook output: empty (the `never: [sauce]` entry on SaaS held, and "head off" did
not phonetically match Hetzner's "head sner").

Answer, byte-identical to the input:

> pass the sauce and head off to the store, reply with exactly the same sentence

1 turn, `duration_ms` 3655, `duration_api_ms` 2180.

## 6. Latency

There is no `--config-dir` flag in 2.1.257 (`CLAUDE_CONFIG_DIR` exists as an
env var but would also move auth and MCP registration). The clean way was
`--setting-sources local --settings <file>`: both variants skip the real
user settings and load one scratch file, identical except that
`settings-without.json` has the two `plugin/hook.mjs` entries removed
(UserPromptSubmit goes from 3 hook commands to 2, SessionStart from 2 to 1).

```bash
claude -p "say ok" --output-format json --setting-sources local --settings <scratch>/e6/settings-with.json
claude -p "say ok" --output-format json --setting-sources local --settings <scratch>/e6/settings-without.json
```

Three runs each, alternating:

| Variant | Wall (s) | `duration_ms` | `duration_api_ms` | non-API ms |
| --- | --- | --- | --- | --- |
| with lexicon hooks | 9.03, 6.77, 6.72 | 3873, 3199 | 2835, 1965 | 1038, 1234 |
| without | 6.30, 6.13, 21.20 (API outlier) | 3081, 17917 | 1670, 16591 | 1411, 1326 |

(The first "with" run was the cold one; the third "without" run spent 16.6s
in the API.) The non-API portion is the same within noise, because Claude
Code runs all hooks for one event concurrently: the lexicon hook is hidden
behind the wrkpad and Measurably hooks that run at the same time.

Standalone cost of the hook process, `echo <payload> | node plugin/hook.mjs`,
five runs each on the 36-term lexicon:

| Event | ms |
| --- | --- |
| UserPromptSubmit | 139, 140, 134, 134, 146 |
| SessionStart | 126, 124, 128, 140, 134 |

So the true overhead is about 135ms per event (one SessionStart per session,
one UserPromptSubmit per prompt), inside the 200ms budget in CLAUDE.md and
invisible next to a 2 to 3s model round trip.

## Findings

### What worked

- All five behaviors pass on the real CLI with the real lexicon: hook-only
  correction, explicit tool use, learn from a correction sentence, session
  context recall, and the `never` list holding on a stoplist-style false
  friend.
- `LEXICON_PATH` reaches both the hook and the claude-spawned MCP server, so
  the documented override is a safe way to test writes without touching the
  real file.
- The SessionStart hook runs in headless mode and its table is read (exp 4).
  The SKILL.md paragraph "At session start ... already put a '## Voice
  lexicon' table in your context" is accurate.
- Hook exit and timing behavior matches the docs: empty output when nothing
  changes, about 135ms per invocation, no stderr noise.
- Every behavior above happened WITHOUT `skills/lexicon/SKILL.md` in context
  (manual install has no skill). The hook notes and the tool descriptions
  alone were enough for this model. That is the good news; it also means the
  hook note is the load-bearing prompt for manual installs and must stand on
  its own.

### What did not (bugs, none touched in this run)

1. `parseCorrection` swallows the sentence after the correction.
   `src/core/learn.ts`: `BARE_WORD` excludes `,;:!?` but not `.`, because
   canonicals like `Ashlr.AI` and `Entire.io` contain periods. With
   `MAX_BARE_WORDS = 4`, `"it's Ashlr.AI not Ashlur. remember that."` yields
   `heard: "Ashlur. remember that"`. Same shape: `"I said Vercel not versel
   please fix it"` yields `heard: "versel please fix it"`. The comma form
   (`"... not Ashlur, remember that"`) already returns `undefined`, so the
   period form is inconsistent as well as wrong. The hook then tells the
   model to save a three-word alias. The model fixed it up in exp 3; that is
   luck, not design.

2. The hook normalizes the word being corrected. On a correction prompt the
   phonetic matcher rewrote "Ashlur" to "Ashlr.AI" (0.90), so the note's
   "Corrected prompt" says `it's Ashlr.AI not Ashlr.AI. remember that.`
   That line is wrong on its face and, worse, it also bumps the hit counter
   for a term the user is in the middle of saying was misread.

3. Headless permission flags were not really tested: the user's
   `defaultMode: bypassPermissions` made `--allowedTools` moot. The task
   brief suggests `--allowedTools "mcp__lexicon__*"`; the Claude Code
   docs describe the server-wide form as the bare server name
   (`mcp__lexicon`). The README should name the form that is documented
   rather than a glob.

4. Minor, not a bug: in a setup with many MCP servers, Claude Code defers
   MCP tool schemas and the model spends one extra turn on `ToolSearch`
   before the first `mcp__lexicon__*` call (exp 2 and 3, about 1.5s each).
   Nothing in this package can change that, but SKILL.md's "call it before
   acting" wording implies a single step.

### Recommendations

**A. Fix `parseCorrection` (src/core/learn.ts).** Two regex changes, verified
on a patched copy of `dist/core/learn.js` against the cases below:

```ts
// A period is part of a word only when something follows it without a space
// (Ashlr.AI, Entire.io, README.md); a period followed by whitespace ends the
// word, so ". remember that" cannot be swallowed into `heard`.
const BARE_WORD = `(?!not\\b)(?:[^\\s"“”\`,;:!?.]|\\.(?=\\S))+`;

// A correction may be followed by a new sentence ("... not Ashlur. remember
// that.", "... not Ashler! now deploy it"): once a sentence terminator plus
// whitespace follows the heard side, ignore the rest of the message.
const TAIL = `\\s*(?:[.!?]+\\s+[\\s\\S]*)?[.!?]*\\s*$`;
```

Results with both changes:

| Prompt | Before | After |
| --- | --- | --- |
| `it's Ashlr.AI not Ashlur. remember that.` | heard `Ashlur. remember that` | heard `Ashlur` |
| `it's Ashlr.AI not Ashlur! save it` | undefined (`!` was already excluded, but the tail failed `TAIL`) | heard `Ashlur` |
| `no, it's Ashlr.AI not Ashler. Now deploy it to Vercel.` | undefined | heard `Ashler` |
| `it's Ashlr.AI not Ashlur.` | heard `Ashlur` | heard `Ashlur` |
| `it's Entire.io not entire dot io` | unchanged | unchanged |
| `replace soup a base with Supabase.` | unchanged | unchanged |
| `the file is not README.md. open it` | undefined | undefined |
| `I said Vercel not versel please fix it` | heard `versel please fix it` | heard `versel please fix it` (unpunctuated tails are not addressed; the 4-word cap still applies) |

The `BARE_WORD` change alone is the conservative option (it makes the period
case return `undefined`, matching the comma case). Add unit rows to
`tests/learn.test.ts` for the first three prompts.

**B. Do not normalize the `heard` span of a correction (src/hooks/user-prompt-submit.ts).**
In `userPromptSubmit`, run `parseCorrection` first and, when it matches,
skip the `formatAdditionalContext` block (and the hits bump) entirely and
emit only the correction note. A correction sentence is metadata about the
lexicon, not a dictated instruction to be corrected. If you would rather
keep the corrected prompt for the non-correction part of a long message,
filter `result.replacements` to drop any replacement whose `original` is
inside `correction.heard` before formatting. The README "What the hooks do"
section should then say: "On a correction prompt the hook emits only the
learn_correction line; it does not run normalize on the word being
corrected."

**C. Harden the hook note text (src/hooks/user-prompt-submit.ts, `formatCorrectionNote`).**
Even after A, a bare-word `heard` can still carry a short unpunctuated tail.
Proposed wording:

```text
The user is correcting a spelling: "Ashlur" should be "Ashlr.AI". Call the lexicon learn_correction tool with heard: "Ashlur", meant: "Ashlr.AI". If "Ashlur" contains words that are not part of the misspelled name, pass only the name. Then continue with the rest of the message.
```

Named fields remove the "which is heard and which is meant" ambiguity the
current sentence leaves to the model (the tool schema has them, but the note
is read before the schema is loaded).

**D. SKILL.md wording, "When the user corrects you".** Current text says the
hook adds `... Call the lexicon learn_correction tool with these values, then
continue.` and "Make the call unless the sentence clearly was not a
correction". Add one sentence after it:

```text
The hook's "Y" is a regex capture of the words after "not"; if it carries
trailing words ("Ashlur. remember that"), pass only the misspelled name as
`heard`. When the hook's "Corrected prompt" line rewrites the misspelling
itself (it's Ashlr.AI not Ashlr.AI), trust the correction note, not the
corrected prompt.
```

Drop the second sentence once B ships.

**E. SKILL.md, "When to call normalize_transcript".** Add, after the bullet
list:

```text
In sessions with many MCP servers Claude Code loads tool schemas on demand;
the first lexicon call costs one ToolSearch turn. Prefer the hook's
corrected prompt when it is present rather than re-running normalize for the
same text.
```

**F. README "Use with Claude Code".** Two small additions:

- Under "b. Manual": "Manual installs do not load `skills/lexicon/SKILL.md`; the hook notes and tool descriptions carry the instructions. Install the plugin (option a) to get the skill and the `/lexicon` command."
- A "Headless / `claude -p`" note: both hooks fire in print mode; to pre-approve the tools in a non-bypass session pass `--allowedTools mcp__lexicon` (server-wide) or list tools such as `mcp__lexicon__normalize_transcript`; to test writes safely set `LEXICON_PATH=/tmp/lex.yaml` in the environment of the `claude` process, which the hook and the MCP server inherit.

**G. Side effect worth documenting.** The hook bumps `hits` on every matched
prompt, including test prompts and hook timing loops; Vercel went 0 -> 7
during this run from five standalone hook invocations plus two real prompts.
Mention in the README that `lexicon stats` counts hook matches from any
session, including headless and scripted ones.

## Files

- Scratch outputs (session scratchpad, not committed): `dogfood/e1/out.json`,
  `e2/out.jsonl`, `e3/out.jsonl` + `lex.before.yaml`/`lex.yaml`,
  `e4/out.jsonl`, `e5/out.json`, `e6/out*.json` + `settings-with.json`/`settings-without.json`,
  `fix/dist/core/learn.js` (patched copy used to verify A).
