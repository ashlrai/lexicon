# Install into your agents

One lexicon file, one command per client. `lexicon setup` runs all of this for every client it detects; this page is what it does, and how to do it by hand.

- [Claude Code](#claude-code)
- [Other agent clients](#other-agent-clients)
- [Any MCP client](#any-mcp-client)
- [ChatGPT, Claude.ai, Grok and other browser chats](#chatgpt-claudeai-grok-and-other-browser-chats)
- [Everything else on your desktop](#everything-else-on-your-desktop)

## Claude Code

Three options, from most to least integrated. `lexicon setup` and `lexicon install claude --apply` perform option b for you.

### a. Plugin

```bash
claude plugin marketplace add ashlrai/lexicon
claude plugin install lexicon@ashlrai
```

Or inside a Claude Code session: `/plugin marketplace add ashlrai/lexicon` then `/plugin install lexicon@ashlrai`. The marketplace manifest is [.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json).

The plugin ships:

- `.mcp.json`: the `lexicon` MCP server.
- `hooks/hooks.json`: a `SessionStart` hook that hands the model your lexicon once per session and a `UserPromptSubmit` hook that corrects each dictated prompt. Both are described under [What the hooks do](#what-the-hooks-do).
- `skills/lexicon/SKILL.md`: tells Claude when to normalize, when to save a correction, when to ask "did you mean", and how to run setup, doctor and suggestions.
- `commands/lexicon.md`: the `/lexicon` command (`/lexicon`, `/lexicon add X as Y, Z`, `/lexicon learn Y -> X`, `/lexicon harvest`, `/lexicon export <format>`, `/lexicon remove X`, `/lexicon stats`, `/lexicon setup`, `/lexicon doctor`, `/lexicon suggest`, `/lexicon trust [path]`).

The plugin is self-contained. `.mcp.json` and `hooks/hooks.json` run `plugin/mcp-server.mjs` and `plugin/hook.mjs`, two single-file bundles committed to the repo with every dependency inlined. A plugin install is a bare clone with no `npm install` and no build step, and that is all it needs: the only runtime requirement is Node 20 or newer on your `PATH`. The bundles are produced by `npm run build:bundle` and CI fails when they are out of date with `src/`.

### b. Manual

```bash
lexicon install claude          # print what would change
lexicon install claude --apply  # do it
```

(`lexicon install-claude` is a hidden alias of the same command, kept working for older scripts.)

Without `--apply` it prints the three steps. With `--apply` it performs the first two:

1. Registers the MCP server: `claude mcp add --scope user lexicon -- node "<install path>/plugin/mcp-server.mjs"`. Use `--scope project` to register it in the current repo instead.
2. Merges `SessionStart` and `UserPromptSubmit` hooks running `node "<install path>/plugin/hook.mjs"` (timeout 5s) into `~/.claude/settings.json`. Existing hooks are kept. The fragment is in [examples/claude-settings.hook.json](../examples/claude-settings.hook.json).
3. Reminds you to add "Read the `lexicon://me` resource before interpreting dictated text" to your `CLAUDE.md`.

Paths are absolute and quoted, so an install path with spaces works. The bundles under `plugin/` are preferred (the npm package ships them too); a checkout that only ran `npm run build` falls back to `dist/mcp/server.js` and `dist/hooks/user-prompt-submit.js`. `lexicon doctor` checks that the plugin or the hooks are in place.

Manual installs do not load `skills/lexicon/SKILL.md`; the hook notes and the tool descriptions carry the instructions. Install the plugin (option a) to get the skill and the `/lexicon` command.

### c. Minimal

No hook, no MCP. Paste the markdown export into `CLAUDE.md` so the model at least knows the right spellings.

```bash
lexicon export claude-md >> CLAUDE.md
```

### What the hooks do

Claude Code hooks cannot rewrite the prompt. The `UserPromptSubmit` hook does not try. It runs `normalize` on the submitted text and, only if something changed, returns an `additionalContext` note:

```text
Voice lexicon corrections for this prompt (the user dictated; apply these):
"Ashler" -> "Ashlr.AI" (alias, 1.00)
"head sner" -> "Hetzner" (alias, 1.00)
Corrected prompt:
tell Ashlr.AI to ship it to Hetzner
```

The model starts the turn already knowing that "Ashler" means "Ashlr.AI". When nothing changed it prints nothing. It always exits 0, logs errors to stderr only, and measures about 100ms end to end including Node startup (budget 200ms), so a broken lexicon never blocks a prompt. It also bumps each matched term's `hits` counter in the background, so `lexicon stats` counts hook matches from any session, including headless and scripted ones.

When the prompt itself is a correction ("it's Ashlr.AI, not Ashlar", "Ashlar -> Ashlr.AI", "replace Ashlar with Ashlr.AI", "it's Ashlr.AI not Ashlar. remember that.") the hook adds one more line asking the model to call `learn_correction` with `heard: "Ashlar", meant: "Ashlr.AI"`. On a correction prompt the hook does not normalize the words being corrected: "Ashlar" is left as the user wrote it, is not counted as a hit, and the rest of the prompt is still corrected. The hook never writes to the lexicon; the model makes the call, so a false positive costs nothing.

The same file runs as the `SessionStart` hook (startup, resume, clear and compact). It emits the `claude-md` export of your merged lexicon as `additionalContext`, so the spellings reach the model once per session even if it never reads `lexicon://me`. The context is capped at about 4000 characters; longer tables end with "... N more terms; read the lexicon://me resource for the full list." An empty lexicon emits a short onboarding note instead, at most once a day, asking the model to offer `setup_lexicon`. An untrusted project file adds one line naming its path, never its contents (see [TRUST.md](TRUST.md)).

### Headless and scripted use

Both hooks fire in print mode (`claude -p "..."`), so a scripted run gets the same corrections as an interactive one. In a session that is not in bypass-permissions mode, pre-approve the tools with `--allowedTools mcp__lexicon` (the whole server) or list them, for example `--allowedTools mcp__lexicon__normalize_transcript mcp__lexicon__learn_correction`. To test writes without touching your real file set `LEXICON_PATH=/tmp/lex.yaml` in the environment of the `claude` process; the hook and the MCP server it spawns both inherit it.

```bash
LEXICON_PATH=/tmp/lex.yaml claude -p "it's Ashlr.AI not Ashlur. remember that." --allowedTools mcp__lexicon
```

## Other agent clients

`lexicon install <client>` prints the MCP config the client needs, with the absolute path to the installed server. Add `--apply` to merge it into the client's config file (existing keys and other servers are kept; running it twice is a no-op).

```bash
lexicon install codex            # print the [mcp_servers.lexicon] block for ~/.codex/config.toml
lexicon install codex --apply    # write it
```

| Client | Command | Writes |
|---|---|---|
| Claude Code | `lexicon install claude` | `claude mcp add` + hooks in `~/.claude/settings.json` |
| OpenAI Codex CLI | `lexicon install codex` | `~/.codex/config.toml` (`[mcp_servers.lexicon]`) |
| Cursor | `lexicon install cursor` | `~/.cursor/mcp.json` |
| Windsurf | `lexicon install windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| Gemini CLI | `lexicon install gemini` | `~/.gemini/settings.json` (top-level `mcpServers`) |
| Claude Desktop | `lexicon install claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows), `~/.config/Claude/claude_desktop_config.json` (Linux) |
| VS Code | `lexicon install vscode` | `~/Library/Application Support/Code/User/mcp.json` (macOS), `~/.config/Code/User/mcp.json` (Linux), `%APPDATA%\Code\User\mcp.json` (Windows). Note: VS Code uses `servers`, not `mcpServers`, and each entry carries `"type": "stdio"` |
| Anything else | `lexicon install` | prints the generic `mcpServers` snippet |

`--project` (or `--scope project`) writes the repo-level file instead where the client has one: `./.codex/config.toml`, `./.cursor/mcp.json`, `./.gemini/settings.json`, `./.vscode/mcp.json`. Windsurf and Claude Desktop have no project-level config and `--project` is refused for them. Every client ends with the same hint: `lexicon export claude-md >> <rules file>` (`CLAUDE.md`, `AGENTS.md` for Codex, `.cursor/rules/lexicon.mdc`, `GEMINI.md`, `.windsurfrules`, `.github/copilot-instructions.md`) so the model prefers the canonical spellings even when it does not call the tool.

### Where writing the file is not quite enough

Four clients have a discovery rule this command cannot check for you, so it prints a note after writing. They are not bugs in the config:

- **Codex, `--project`.** A repo-local `.codex/config.toml` is loaded but *disabled* until you mark the project as trusted in Codex. The user-level `~/.codex/config.toml` has no such condition.
- **VS Code, user scope.** VS Code keeps `mcp.json` per profile. The path above is the default profile of VS Code stable; on a custom profile, Insiders, or with `--user-data-dir`, run **MCP: Open User Configuration** in VS Code and paste the entry there. Workspace scope (`./.vscode/mcp.json`, via `--project`) has no such ambiguity and is the more reliable target.
- **Gemini CLI.** If your `settings.json` sets `mcp.allowed`, add `"lexicon"` to that list or the server is skipped.
- **Claude Desktop.** The config is read at launch only: quit the app completely and reopen. The Linux path is best effort (`$XDG_CONFIG_HOME/Claude/`, else `~/.config/Claude/`), because Anthropic documents only the macOS and Windows locations.

### Running without installing anything

`npx @ashlr/lexicon@latest setup` works, and installs nothing globally. When the CLI notices it is running from an npx cache (a directory npm deletes on its own schedule) it writes `npx -y @ashlr/lexicon@<version> mcp` into each client config instead of an absolute path, so the config keeps working after the cache is cleared. The Claude Code hook gets the same treatment with a wider timeout, because npx adds about a second per prompt. `npm i -g @ashlr/lexicon` and a rerun replaces both with direct paths and makes it instant. `lexicon serve --install` refuses to create a login service from an npx cache at all, since a launchd or systemd unit pointing into one would crash-loop.

## Any MCP client

See [MCP.md](MCP.md) for the stdio config, the nineteen tools, the two resources and the two prompts.

## ChatGPT, Claude.ai, Grok and other browser chats

You cannot patch their recognizer. Two things work: the [browser extension](EXTENSION.md) fixes the text composer before you hit send, and pasting the export into custom instructions or memory lets the model correct itself.

```bash
lexicon export claude-md | pbcopy
```

## Everything else on your desktop

Hooks and MCP only reach agents that support them. Everything else goes through one of these.

| Surface | What to use |
|---|---|
| Shortcuts, Raycast, scripts, your own app | `lexicon serve`: a local HTTP API on `127.0.0.1:41733` with a bearer token. See [LOCAL-API.md](LOCAL-API.md) |
| Local dictation without a dictation app | `lexicon voice`: ffmpeg records, whisper.cpp transcribes with your canonicals as prompt hints, the lexicon corrects. See [VOICE.md](VOICE.md) |
| Any text field, any app | `lexicon daemon --once --paste` on a shortcut. See [DAEMON.md](DAEMON.md) |
| Any app, any dictation tool, macOS | [LexiconBar](MACOS-APP.md) fixes dictated text in the focused field via Accessibility, and shows a bubble you can undo |
| Your dictation app's own dictionary | `lexicon export <format>`. See [EXPORTS.md](EXPORTS.md) |

Start the pieces you want once:

```bash
lexicon serve --install          # local API at login (launchd or systemd user unit)
lexicon serve --show             # URL and token to paste into the extension options
lexicon voice --list-devices     # pick a microphone, then bind: lexicon voice --toggle --paste
npm run build:extension          # then Load unpacked: extension/dist
scripts/build-macos-app.sh       # apps/macos/build/LexiconBar.app (hotkey, clipboard, voice, API)
```

The voice path is deliberately minimal. Wispr Flow and Superwhisper remain nicer dictation apps; use them and export your lexicon into their dictionaries. `lexicon voice` is for people who want a fully local path with no accounts.

## See also

- [MCP.md](MCP.md) documents the tools, resources and prompts the server you just registered exposes.
- [TRUST.md](TRUST.md) explains why a repo's `.lexicon.yaml` stays off until you approve it.
- [GROWING.md](GROWING.md) is what to do once it works: filling the lexicon without typing it.

Back to [the docs index](README.md).
