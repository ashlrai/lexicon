# Lexicon x Phantom: integration sketch

How this repo plugs into Phantom, written from Lexicon's side. Phantom and its
ecosystem form a fully autonomous, code-first, agent-native software factory,
run by agents with the human as a passive board member, chasing open source
RSI (recursive self improvement); the [README](README.md#part-of-the-ashlrai-ecosystem)
lists the other repos. The board member steers that factory partly by voice,
and speech-to-text mangles exactly the names the agents need: the company, its
products, its people, its internal systems. Lexicon is the shared terminology
layer underneath: one YAML file of the words speech-to-text gets wrong, applied
everywhere the user's voice lands, whichever agent or assistant receives it.
Nothing here changes Phantom core; it describes the contract Phantom would
integrate against.

## The terminology-list model

One source of truth, three scopes:

- **Global** `~/.config/lexicon/lexicon.yaml` (override with `LEXICON_PATH`):
  the user's own vocabulary. Company names, product names, colleagues, internal
  systems. This is the file Phantom reads and writes.
- **Project** `.lexicon.yaml` at a git root: per-repo terms, merged only when
  trusted (`lexicon trust`). Phantom must surface the trust preview and never
  auto-trust on the user's behalf; a hostile repo's terms reach model context.
- **Packs** (`packs/*.yaml`, installed via `lexicon pack add`): 272 curated
  starter terms across the nine packs: developer tooling, AI, business,
  voice tools, cloud and DevOps, legal profession, law and litigation,
  the Ashlr.AI fleet, and architecture. Phantom can offer these as a
  checklist during onboarding, the way `lexicon setup` does.

Term shape: `canonical` (the spelling the user wants), `aliases` (what STT
actually writes), `phonetic` (pronunciation hint), `category`
(brand/person/product/acronym/identifier/place/other), `never` (words that must
not be rewritten to this canonical), `context` (words that must also appear in
the text for the term to fire, so `locus` can leave a person named Lucas
alone), `notes` (shown to the agent), `caseSensitive`. Settings:
`minConfidence`, `phonetic`, `fuzzy`, `protectedWords`, `skipCode`. Full schema
in `docs/LEXICON-FILE.md`.

## How vocabulary flows into voice-to-text

Two directions, both already implemented:

**Outbound: user speaks, the agent receives corrected text.** Every surface
below takes raw transcript in and hands corrected text to the agent or
assistant. The primitives Phantom can call, in order of preference:

1. `normalize()`: pure function, `npm i @ashlr/lexicon`. Text plus lexicon
   in, corrected text plus a replacement list out. No processes, no files
   beyond the YAML. Best when Phantom already holds the transcript.
2. MCP server (`lexicon-mcp`, stdio, 21 tools): `normalize_transcript`,
   `learn_correction`, `add_term`, `setup_lexicon`, `lexicon_doctor`. Best when
   Phantom talks to an agent over MCP anyway.
   The complete tool contract is `add_pack`, `add_term`, `apply_suggestion`,
   `export_lexicon`, `harvest_repo`, `import_dictionary`, `import_vocabulary`,
   `install_client`, `learn_correction`, `lexicon_doctor`, `lexicon_stats`,
   `list_packs`, `list_terms`, `normalize_transcript`, `remove_term`,
   `serve_status`, `setup_lexicon`, `suggest_canonical`, `suggest_terms`,
   `trust_project`, and `uninstall_client`.
3. Local HTTP API (`lexicon serve`, loopback `127.0.0.1:41733`, bearer-token auth,
   12 endpoints): `POST /normalize`, `POST /learn`, `GET /lexicon`. Best for
   non-JS hosts and the tray apps. The default server binds to loopback and
   rejects non-loopback Host headers before authentication. An explicit
   `--host` changes the bind interface; Phantom should keep the default.
4. CLI (`lexicon normalize`, `lexicon learn`, ...): best for scripts, hooks
   and one-shot corrections.

**Pre-transcription biasing.** Corrections happen after STT by default, but
`lexicon export` also produces biasing hints that improve the recognizer
itself: Whisper/OpenAI prompt lists, Deepgram, AssemblyAI, Speechmatics, Azure and Google
vocabularies, Wispr Flow and Superwhisper dictionaries, macOS Text Replacement,
espanso. For agents and assistants that run their own STT, Phantom can push the
user's terms into the recognizer before transcription rather than fixing the
transcript after.

**Inbound: corrections flow back.** When the user says "it's Ashlr.AI not
Ashler" to any agent, that is `learn_correction` (MCP), `POST /learn` (local
API) or `lexicon learn` (CLI): the alias lands in the shared file once, and
every surface picks it up. The Claude Code hook does not write it; it flags
the correction for the agent and queues it in `pending-aliases.yaml` for
`lexicon pending` review. `lexicon suggest` mines the voice history and
proposes aliases, new terms, never-words, phonetic hints and stale terms.
Only suggestions at 0.80 confidence or above (promoted guesses, well-attested
garbles, names seen five or more times) are applied unattended by `--yes` or
an agent applying them on its own; phonetic hints, harvest candidates and
stale removals always wait for a human ([SUGGEST.md](docs/SUGGEST.md)).

## Surface map for a heterogeneous fleet

| Fleet entry point | Lexicon surface that covers it | How |
|---|---|---|
| Claude Code | Plugin hooks | `SessionStart` injects the claude-md export (capped at 4000 chars); `UserPromptSubmit` corrects each dictated prompt as `additionalContext`, never rewriting the prompt |
| Any MCP-capable agent or assistant | MCP server | stdio `lexicon-mcp`; `lexicon://me` resource hands the model the user's vocabulary at session start |
| ChatGPT / Claude.ai / Grok / Gemini / Perplexity web | Browser extension | rewrites the composer when the user presses Enter or the send button, with a toast and Undo |
| Any macOS app or dictation tool | LexiconBar menu bar app | rewrites dictated text in the focused field through Accessibility, with an undo bubble |
| Any Windows app | LexiconBar for Windows | the same burst correction through UI Automation; that half has not yet been run on Windows ([WINDOWS-APP.md](docs/WINDOWS-APP.md)) |
| Any text field, any OS | Clipboard daemon | `lexicon daemon --once --paste` on a hotkey (`--paste` is macOS only) |
| Phantom's own STT pipeline | Library or exports | `normalize()` between transcription and the model, or export biasing hints into the recognizer |

## Opt-in / opt-out

Lexicon is additive and local, so the integration should be too. Suggested
shape for Phantom's config (names illustrative, Phantom's side to finalize):

- A single kill switch: with Lexicon off, transcripts pass through untouched.
- Per-surface toggles: MCP on, Claude Code hooks on, browser extension off,
  macOS app on. Each surface is independently installable today
  (`lexicon install <client>`, `lexicon serve --install`, the extension zip);
  Phantom would call the same entry points.
- Per-scope toggles: global terms always; project terms only from trusted
  repos; packs as an onboarding checklist, not a default dump (a pack
  writes 12 to 82 terms into the global lexicon, and the `lexicon setup`
  default selection of developer, ai and voice-tools writes 141; under
  `lexicon setup --yes` nothing installs unless asked).
- Learning requires consent: `learn_correction` writes to the user's file
  as soon as it is called (it has no preview, unlike `setup_lexicon` and
  `install_client`), so Phantom should confirm before an agent teaches the
  shared lexicon from a correction.

## Boundaries Phantom must respect

- **No telemetry, no account, no sync service.** The lexicon is a plain local
  file by design (see `SECURITY.md`). If Phantom syncs state across machines,
  the lexicon file stays out of that sync unless the user explicitly opts in;
  do not build the hosted sync this repo deliberately does not have.
- **The trust gate is not Phantom's to bypass.** Project `.lexicon.yaml`
  files are untrusted until reviewed. `LEXICON_TRUST_ALL=1` must never be set
  on a user's behalf.
- **The hook contract.** The Claude Code hook exits 0, stays under 200ms, and
  never rewrites the prompt or writes to the lexicon file. Fleet-wide prompt
  rewriting belongs in Phantom's own layer, not smuggled through this hook.
- **Counts are load-bearing.** Docs in this repo state exact surface counts, and
  `npm run check:facts` fails the build when prose disagrees with code. Any
  Phantom doc that quotes Lexicon's surface should derive the number, not
  copy it.

## Open questions for Phantom's side

- Which agent owns the "it's X not Y" moment? If two agents can both call
  `learn_correction`, whose confirmation UX wins?
- Should the fleet share one global lexicon, or does each agent get a
  filtered view (e.g. work terms for the work assistant)? The file supports
  per-term `notes` and categories; filtering is Phantom's policy to define.
- Pre-transcription biasing needs recognizer credentials Phantom may not
  hold (Deepgram/AssemblyAI keys). Post-transcription correction works with
  no credentials at all; biasing is the upgrade path.
