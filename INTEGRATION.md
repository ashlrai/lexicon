# Lexicon x Phantom: integration sketch

How this repo plugs into Phantom, written from Lexicon's side. Phantom is the
orchestration layer over a personal fleet of heterogeneous assistants (Muse,
Grok, ChatGPT, ...). Lexicon is the shared terminology layer underneath it:
one YAML file of the words speech-to-text gets wrong, applied everywhere the
user's voice lands. Nothing here changes Phantom core; it describes the
contract Phantom would integrate against.

## The terminology-list model

One source of truth, three scopes:

- **Global** `~/.config/lexicon/lexicon.yaml` (override with `LEXICON_PATH`):
  the user's own vocabulary. Company names, product names, colleagues, internal
  systems. This is the file Phantom reads and writes.
- **Project** `.lexicon.yaml` at a git root: per-repo terms, merged only when
  trusted (`lexicon trust`). Phantom must surface the trust preview and never
  auto-trust on the user's behalf; a hostile repo's terms reach model context.
- **Packs** (`packs/*.yaml`, installed via `lexicon pack add`): 176 curated
  starter terms across developer tooling, AI, business and dictation apps.
  Phantom can offer these as a checklist during onboarding, the way
  `lexicon setup` does.

Term shape: `canonical` (the spelling the user wants), `aliases` (what STT
actually writes), `phonetic` (pronunciation hint), `category`
(brand/person/product/acronym/identifier/place/other), `never` (words that must
not be rewritten to this canonical), `notes` (shown to the agent). Settings:
`minConfidence`, `phonetic`, `fuzzy`, `protectedWords`, `skipCode`. Full schema
in `docs/LEXICON-FILE.md`.

## How vocabulary flows into voice-to-text

Two directions, both already implemented:

**Outbound: user speaks, assistant receives corrected text.** Every surface
below takes raw transcript in and hands corrected text to the assistant. The
primitives Phantom can call, in order of preference:

1. `normalize()`: pure function, `npm i @ashlr/lexicon`. Text plus lexicon
   in, corrected text plus a replacement list out. No processes, no files
   beyond the YAML. Best when Phantom already holds the transcript.
2. MCP server (`lexicon-mcp`, stdio, 20 tools): `normalize_transcript`,
   `learn_correction`, `add_term`, `setup_lexicon`, `lexicon_doctor`. Best when
   Phantom talks to an assistant over MCP anyway.
3. Local HTTP API (`lexicon serve`, loopback `127.0.0.1:41733`, Bearer <redacted>,
   11 endpoints): `POST /normalize`, `POST /learn`, `GET /lexicon`. Best for
   non-JS hosts and the tray apps.
4. CLI (`lexicon normalize`, `lexicon learn`, ...): best for scripts, hooks
   and one-shot corrections.

**Pre-transcription biasing.** Corrections happen after STT by default, but
`lexicon export` also produces biasing hints that improve the recognizer
itself: Whisper/OpenAI prompt lists, Deepgram, AssemblyAI, Azure and Google
vocabularies, Wispr Flow and Superwhisper dictionaries, macOS Text Replacement,
espanso. For fleet assistants that run their own STT, Phantom can push the
user's terms into the recognizer before transcription rather than fixing the
transcript after.

**Inbound: corrections flow back.** When the user says "it's Ashlr.AI not
Ashler" to any fleet assistant, that is `learn_correction` (MCP),
`POST /learn` (local API) or `lexicon learn` (CLI): the alias lands in the
shared file once, and every surface picks it up. `lexicon suggest` mines the
voice history for terms the matcher keeps guessing at and proposes phonetic
hints or alias promotions, held below the auto-apply confidence so a human
approves.

## Surface map for a heterogeneous fleet

| Fleet entry point | Lexicon surface that covers it | How |
|---|---|---|
| Claude Code | Plugin hooks | `SessionStart` injects the claude-md export (capped at 4000 chars); `UserPromptSubmit` corrects each dictated prompt as `additionalContext`, never rewriting the prompt |
| Any MCP-capable assistant | MCP server | stdio `lexicon-mcp`; `lexicon://me` resource hands the model the user's vocabulary at session start |
| ChatGPT / Claude.ai / Grok / Gemini / Perplexity web | Browser extension | rewrites the composer when the user presses send |
| Any macOS app or dictation tool | LexiconBar menu bar app | rewrites dictated text in the focused field through Accessibility, with an undo bubble |
| Any text field, any OS | Clipboard daemon | `lexicon daemon --once --paste` on a hotkey |
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
  repos; packs as an onboarding checklist, not a default dump (a pack is a
  hundred-odd global terms; under `lexicon setup --yes` nothing installs
  unless asked).
- Learning requires consent: `learn_correction` writes to the user's file, so
  Phantom should confirm before a fleet assistant teaches the shared lexicon
  from a correction, the same way the MCP tools preview writes before
  applying.

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
- **Counts are load-bearing.** Docs in this repo state exact numbers (19 MCP
  tools, 25 CLI commands, 15 export formats, 176 pack terms) and
  `npm run check:facts` fails the build when prose disagrees with code. Any
  Phantom doc that quotes Lexicon's surface should derive the number, not
  copy it.

## Open questions for Phantom's side

- Which assistant in the fleet owns the "it's X not Y" moment? If two
  assistants can both call `learn_correction`, whose confirmation UX wins?
- Should the fleet share one global lexicon, or does each assistant get a
  filtered view (e.g. work terms for the work assistant)? The file supports
  per-term `notes` and categories; filtering is Phantom's policy to define.
- Pre-transcription biasing needs recognizer credentials Phantom may not
  hold (Deepgram/AssemblyAI keys). Post-transcription correction works with
  no credentials at all; biasing is the upgrade path.
