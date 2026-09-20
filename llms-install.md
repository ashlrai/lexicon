# Install Lexicon

Instructions for an AI assistant installing this MCP server on behalf of its user.
Follow them in order. Lexicon needs no API key, no account and no network access —
do not ask the user for credentials at any point.

Lexicon is a stdio MCP server (19 tools) that holds the user's personal vocabulary:
the names, brands and identifiers speech-to-text mishears, and the canonical spelling
for each. Call `normalize_transcript` on dictated input before acting on it.

## Step 1 — check the runtime

```bash
node --version
```

Node 20 or newer is required. If it is older or missing, install Node 20+ first and stop
if you cannot; there is no other runtime.

## Step 2 — install the package

Use npm:

```bash
npm install -g @ashlr/lexicon
```

Or Homebrew on macOS and Linux (this pulls in Node for the user):

```bash
brew install ashlrai/tap/lexicon
```

Both put two executables on `PATH`: `lexicon` (CLI) and `lexicon-mcp` (the MCP server).

Confirm:

```bash
lexicon --version
```

## Step 3 — register the server with the client

If the user's client is Claude Code, Codex, Cursor, Windsurf, Gemini CLI, VS Code or
Claude Desktop, let Lexicon write the config itself. Run it once without `--apply` to
show the user what will change, then again with `--apply`:

```bash
lexicon install <client>            # preview the exact diff
lexicon install <client> --apply    # write it
```

Valid `<client>` values: `claude`, `codex`, `cursor`, `windsurf`, `gemini`, `vscode`,
`claude-desktop`. Add `--project` to write the repo-level config instead of the user-level
one, where that client supports it.

For any other MCP client, add this block to its config file by hand:

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

If `lexicon-mcp` is not on `PATH` (for example a client that launches with a minimal
environment), use an absolute path instead:

```json
{
  "mcpServers": {
    "lexicon": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/@ashlr/lexicon/plugin/mcp-server.mjs"]
    }
  }
}
```

Resolve that path with `npm root -g` and append `/@ashlr/lexicon/plugin/mcp-server.mjs`.

Two optional environment variables, both paths, neither secret:

- `LEXICON_PATH` — the global lexicon YAML. Defaults to `$XDG_CONFIG_HOME/lexicon/lexicon.yaml`,
  else `~/.config/lexicon/lexicon.yaml`.
- `LEXICON_CWD` — the directory searched for a project `.lexicon.yaml`. Defaults to the
  server's working directory.

Claude Code users can skip all of the above and install the plugin, which also brings the
hooks, the skill and the `/lexicon` command:

```bash
claude plugin marketplace add ashlrai/lexicon
claude plugin install lexicon@ashlrai
```

## Step 4 — seed the vocabulary

An empty lexicon corrects nothing, so do not stop at step 3.

```bash
lexicon init
```

Then ask the user for the handful of words their dictation gets wrong — their company,
product, teammates, and any in-house jargon — and add each one:

```bash
lexicon add "Ashlr.AI" "ashler" "ash ler"
```

The first argument is the correct spelling; the rest are what speech-to-text produces
instead. Aliases are suggested automatically when you omit them. You can also seed from a
starter pack or an existing dictation app's dictionary:

```bash
lexicon pack add developer
lexicon import ~/path/to/wispr-dictionary.csv
```

## Step 5 — verify

Run all three. Every one must pass before you tell the user it worked.

```bash
lexicon doctor
```

Reports the resolved file paths, term conflicts and whether the client integration is in
place. Fix anything it flags.

```bash
lexicon normalize "ship it to ashler today"
```

Must print the sentence back with the canonical spelling substituted — `ship it to
Ashlr.AI today` for the term added above. If the output is identical to the input, the
term is not in the lexicon yet — go back to step 4.

Finally, restart the user's MCP client and confirm the `lexicon` server connects and lists
its tools. From the client, call `lexicon_doctor` and read the `lexicon://me` resource; a
successful read means the server is live and the vocabulary is visible to the model.

## After installing

Tell the model — via the client's rules or memory file — to read `lexicon://me` at session
start and to call `normalize_transcript` on dictated input. For clients with a memory file
and no resource support:

```bash
lexicon export claude-md >> CLAUDE.md
```

## If it fails

- `lexicon: command not found` — the npm global bin directory is not on `PATH`. Print
  `npm prefix -g` and have the user add its `bin` subdirectory, or use the absolute-path
  config in step 3.
- Server starts but no tools appear — the client is probably running an old Node. Check
  the Node version the *client* launches with, not the shell's.
- Writes to a project `.lexicon.yaml` are refused — that file is untrusted by design. Show
  the user `lexicon trust <path>`, which previews the file's contents before approving it.
