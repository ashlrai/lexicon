# MCP server reference

Server name: `lexicon`. Transport: stdio. Bin: `lexicon-mcp` (or `lexicon mcp`, or `node plugin/mcp-server.mjs`). The lexicon is re-read on every call, so edits to the file take effect immediately. Nineteen tools, two resources, two prompts.

Registering it in a client is one command: see [CLIENTS.md](CLIENTS.md). Point any other MCP client at the stdio server directly:

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

`lexicon-mcp` is on your PATH after `npm i -g`. From a checkout, use `"command": "node", "args": ["/path/to/lexicon/plugin/mcp-server.mjs"]` instead; the bundle runs without a build. See [examples/mcp-config.json](../examples/mcp-config.json).

The agent calls `normalize_transcript` on dictated input and reads `lexicon://me` for the full vocabulary. The server also sends one-screen `instructions` at connect time, so a client that honours them knows the workflow without the Claude Code skill.

## Tools

| Tool | Arguments | Returns |
|---|---|---|
| `normalize_transcript` | `text`, `dryRun?`, `minConfidence?` | `output`, `changed`, `replacements[]`, `summary`. Also bumps each term's `hits` counter |
| `add_term` | `canonical`, `aliases?`, `phonetic?`, `category?`, `notes?`, `never?`, `scope?` | The stored term, its file path and `created`. Aliases are auto-suggested when omitted |
| `remove_term` | `canonical`, `scope?` | Whether it existed |
| `list_terms` | `query?`, `category?` | Matching terms, counts per file, the paths in use, and a note when a project file was skipped as untrusted |
| `harvest_repo` | `path?`, `limit?`, `minCount?`, `add?` | Candidates. `add: true` writes them to that repo's project lexicon |
| `export_lexicon` | `format`, `categories?`, `limit?` | The export as text |
| `learn_correction` | `heard`, `meant`, `scope?` | The term the alias was added to, `created`, `aliasAdded`, a one-line summary |
| `suggest_canonical` | `heard` | Up to three existing terms closest to the garbled word, with confidence, for "did you mean X?" |
| `lexicon_stats` | none | Term and alias counts, total hits, top ten terms, never-hit terms, per-file breakdown |
| `lexicon_doctor` | none | The `lexicon doctor` checks as data: `{ ok, checks: [{ level, message }], paths, versions }` |
| `install_client` | `client`, `apply?`, `scope?` | Preview (default) or apply the MCP config for `claude`, `codex`, `cursor`, `windsurf`, `gemini`, `vscode` or `claude-desktop` |
| `trust_project` | `action` (`status`, `trust`, `untrust`), `path?` | Trust state, or a sanitized preview of the file's canonicals before pinning it. The agent shows the preview and asks first |
| `import_dictionary` | `path?` or `content?`, `format?`, `scope?`, `dryRun?` | Import a Wispr, Superwhisper, macOS, espanso, text, CSV or JSON dictionary |
| `list_packs` | none | The starter packs in `packs/`, their size and which are installed. See [PACKS.md](PACKS.md) |
| `add_pack` | `name`, `scope?` | Install a starter pack into the global or project lexicon. See [PACKS.md](PACKS.md) |
| `suggest_terms` | `cwd?`, `limit?` | Proposed aliases, terms, never-words and stale terms from voice history, usage and the repo |
| `apply_suggestion` | `suggestion`, `scope?` | Applies one suggestion from `suggest_terms`, passed back as received |
| `setup_lexicon` | `company?`, `person?`, `clients?`, `serve?`, `apply?` | Without `apply` returns a plan computed by a dry run (what it would seed and harvest, the clients it detected, whether it would install the login service) and writes nothing. With `apply: true` runs `lexicon setup` non-interactively for exactly the `clients` given (omitted = none) and installs the local API only with `serve: true`; returns the `SetupSummary` |
| `serve_status` | none | Whether the local API on `127.0.0.1:41733` is up, with its version and term count |

## Resources

| Resource | Type | Content |
|---|---|---|
| `lexicon://me` | `text/markdown` | The `claude-md` export of the merged lexicon. What an agent should read at session start. Adds one line naming a skipped untrusted project file |
| `lexicon://json` | `application/json` | The merged lexicon as JSON |

## Prompts

| Prompt | Purpose |
|---|---|
| `voice-context` | The `claude-md` export plus an instruction to apply the canonical spellings for the rest of the session |
| `onboard` | Walks the agent through first-run setup: ask for company, product and teammate spellings, which clients are in use, then call `setup_lexicon` and `add_term` |

## Writes and previews

Project-scope writes (`add_term`, `learn_correction`, `apply_suggestion`, `import_dictionary`, `harvest_repo` with `add: true`) go through the same [trust gate](TRUST.md) as the CLI and return an error instead of touching an unreviewed `.lexicon.yaml`.

`setup_lexicon`, `install_client` and `trust_project` preview by default and only write when the agent passes `apply: true` or `action: 'trust'` after showing you the preview.

Why these tools exist and how an agent is meant to chain them is in [AGENT-NATIVE.md](AGENT-NATIVE.md).
