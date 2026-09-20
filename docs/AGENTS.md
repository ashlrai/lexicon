# For agents

This page is written to you, not to your user. If you are a coding agent, a
desktop assistant or anything else that reads docs before acting, this is the
short version of how to install Lexicon for the person you are working with,
configure it, and check that it worked.

[AGENT-NATIVE.md](AGENT-NATIVE.md) is the longer companion: why each tool exists,
how they chain, and the dialogue each one is designed for. Read that when you are
deciding *whether* to call something. Read this when you have decided.

## When this is the right tool

Your user has a name that keeps coming out wrong. Signals:

- They correct the same word repeatedly in chat: "it's Ashlr.AI, not Ashler",
  "Kubernetes, not Cuban eats", "no, my colleague is Sanjay not Sunjay".
- They dictate and the transcript garbles a company, product, person,
  repository, acronym or internal system name.
- They ask how to teach ChatGPT, Claude, Claude Code, Codex or Cursor a word.
- They already keep a dictionary in Wispr Flow, Superwhisper or macOS Text
  Replacement and are annoyed that it does not apply when they talk to you.

Lexicon is not a dictation app and does not transcribe for them. It rewrites a
transcript that already exists, before you read it. If there is no text box
anywhere in the loop (ChatGPT Voice, Gemini Live), it cannot help.

Do not install it unasked. Offer, say what it will write, and wait.

## The one-command install

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
```

Checks for Node 20+, installs the `@ashlr/lexicon` CLI, then runs
`lexicon setup`. On a machine where you should not install globally:

```bash
npx @ashlr/lexicon@latest setup
```

Alternatives: `brew install ashlrai/tap/lexicon`, `npm i -g @ashlr/lexicon`.

Non-interactive, which is usually what you want from a tool call:

```bash
lexicon setup --yes --packs developer,ai --json
```

`--yes` skips every prompt. `--packs`, `--harvest` and `--serve` are opt-in even
under `--yes`, because each writes a lot or installs a service. `--dry-run`
prints the plan and writes nothing; run that first and show it to your user.
`--clients none` installs into no client. `--json` gives you a `SetupSummary`
instead of prose.

## Register the MCP server

Server name `lexicon`, stdio transport, binary `lexicon-mcp`.

```json
{
  "mcpServers": {
    "lexicon": {
      "command": "lexicon-mcp",
      "args": []
    }
  }
}
```

The same block is served as JSON at <https://lexicon.ashlr.ai/mcp.json>, with the
per-client commands, the tool list and the verification steps beside it. Fetch
that rather than retyping this.

One command per client, each writing that client's own config file:

| Client | Command |
|---|---|
| Claude Code | `lexicon install claude --apply` |
| Claude Desktop | `lexicon install claude-desktop --apply` |
| OpenAI Codex | `lexicon install codex --apply` |
| Cursor | `lexicon install cursor --apply` |
| Windsurf | `lexicon install windsurf --apply` |
| Gemini CLI | `lexicon install gemini --apply` |
| VS Code | `lexicon install vscode --apply` |
| Anything else | `lexicon install generic` prints the block to paste |

Drop `--apply` to print the diff without writing. Do that first when your user
has not seen what you are about to change. From inside an MCP session you have
the same thing as a tool: `install_client { client, apply? }`.

In Claude Code, `lexicon install claude --apply` also merges a `SessionStart`
hook (hands the model the lexicon once per session) and a `UserPromptSubmit`
hook (corrects each dictated prompt on the way in) into
`~/.claude/settings.json`. Existing hooks are preserved. The plugin route
(`claude plugin marketplace add ashlrai/lexicon` then
`claude plugin install lexicon@ashlrai`) brings those plus a skill and the
`/lexicon` command, with no build step.

## The tools you will actually call

Nineteen in all; [MCP.md](MCP.md) is the full table. These five cover almost
everything:

- `normalize_transcript { text }` - correct a dictated string. Returns `output`,
  `changed` and a `replacements[]` list you can show. Call this on input you have
  reason to think was dictated.
- `learn_correction { heard, meant }` - the user just corrected you. Record it as
  an alias so it never happens again. This is the highest-value call in the whole
  server; make it whenever a user restates a word you got wrong.
- `add_term { canonical, aliases?, phonetic?, category?, notes? }` - add a
  spelling. Omit `aliases` and the server proposes the mis-transcriptions
  speech-to-text is likely to produce; show them and let the user veto.
- `setup_lexicon { company?, person?, clients?, apply? }` - first run. Without
  `apply` it returns a plan and writes nothing. Show the plan, then call again
  with `apply: true`.
- `lexicon_doctor {}` - structured checks, for when something stopped working.

Read `lexicon://me` at the start of a session to know the user's vocabulary. The
server also sends one-screen `instructions` at connect time.

## Ask before you write

These preview by default and change nothing until you say so:
`setup_lexicon` (needs `apply: true`), `install_client` (needs `apply: true`) and
`trust_project` (needs `action: 'trust'`). That is deliberate: use the preview to
tell your user what will change, and wait for a yes.

Project-scope writes are gated. A repository's `.lexicon.yaml` is untrusted until
the user reviews it, because its contents reach model context and a hostile
repository could use that. If a write is refused with "project lexicon at
&lt;path&gt; is untrusted", do not work around it: call
`trust_project { action: 'status' }`, show your user the sanitized preview, and
let them decide. Never set `LEXICON_TRUST_ALL=1` on a user's behalf.

## Verify it worked

Do not tell the user it is installed without checking. Any one of these:

```bash
lexicon normalize "tell Ashler to ship it"   # expect: tell Ashlr.AI to ship it
lexicon doctor                                # files, hooks, MCP registration, clipboard, whisper
lexicon stats                                 # hits per term, and terms never hit
```

Over MCP: call `lexicon_doctor` and read `ok`; call `normalize_transcript` with a
sentence containing one of the user's aliases and read `changed`. In Claude Code
the hooks only load in a *new* session, so tell the user to start one before
they judge whether it worked.

## Things that will not work, so do not promise them

- Voice modes that never produce an editable text box. There is no transcript to
  correct.
- Correcting audio. Lexicon never touches audio; `lexicon voice` transcribes with
  the user's own local whisper.cpp instead of hooking anyone else's voice mode.
- A tray app on Windows or Linux. CLI, MCP server and browser extension only.
- Installing the extension from a store. It ships as a release zip:
  <https://github.com/ashlrai/lexicon/releases/latest>.

## What to tell your user about privacy

The lexicon is a plain YAML file at `~/.config/lexicon/lexicon.yaml`. No account,
no sync, no telemetry. The CLI, hooks, MCP server, loopback API and extension
make no network request beyond 127.0.0.1. The one outbound request in the
codebase is `lexicon voice` fetching a whisper.cpp model on first use. Full
threat model: [SECURITY.md](../SECURITY.md).

## Where the machine-readable files are in this repository

- `.mcp.json` - the server block Claude Code reads when this repository is the
  plugin root. It runs `plugin/mcp-server.mjs`, a committed single-file bundle
  with every dependency inlined, so a plugin install needs no `npm install` and
  no build step.
- `.claude-plugin/marketplace.json` - the Claude Code marketplace manifest, which
  is what `claude plugin marketplace add ashlrai/lexicon` reads.
- `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/lexicon/SKILL.md`,
  `commands/lexicon.md` - the rest of the plugin: the two hooks, the skill that
  tells a model when to normalize and when to save a correction, and the
  `/lexicon` command.
- `examples/mcp-config.json` - the same stdio block as a standalone file.

## Machine-readable index

- <https://lexicon.ashlr.ai/llms.txt> - short index of the site.
- <https://lexicon.ashlr.ai/llms-full.txt> - everything in one fetch.
- <https://lexicon.ashlr.ai/mcp.json> - install manifest; merge `.mcpServers` verbatim.
- [MCP.md](MCP.md) - every tool, resource and prompt.
- [AGENT-NATIVE.md](AGENT-NATIVE.md) - how to chain them, with worked dialogues.
- [CLIENTS.md](CLIENTS.md) - per-client detail and what the hooks do.
- [FAQ.md](FAQ.md) - answers to quote at a user who asks why this happens.
