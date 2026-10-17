# MCP server reference

Every tool, resource and prompt the `lexicon` server exposes, for anyone wiring it into an MCP client or writing an agent that calls it. To *register* the server in a client, use [CLIENTS.md](CLIENTS.md); this page is what it answers once it is running.

Server name: `lexicon`. Transport: stdio. Bin: `lexicon-mcp` (or `lexicon mcp`, or `node plugin/mcp-server.mjs`). `lexicon-mcp --version` prints the package version and `--help` a one-line usage, both exiting 0 without starting the server (on the default branch, not yet in a published release). The lexicon is re-read on every call, so edits to the file take effect immediately. Twenty tools, two resources, two prompts.

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

Guided import harvests only explicitly selected sources. Lexicon adds no automatic upload or telemetry, but candidate names and evidence are returned to the requesting MCP client and may be shared with that client's model provider. Review that client's privacy settings before requesting a source. GitHub requests use the user's existing `gh` session.

## Tools

Arguments are checked against each tool's schema before the tool runs. A key the schema does not declare (`alias` for `aliases`, `txt` for `text`) is refused with `Unrecognized key: "<name>"` instead of being dropped, and every schema in `tools/list` carries `additionalProperties: false`. `remove_term`'s `canonical` and `alias`, and `suggest_canonical`'s `heard`, must hold more than whitespace (on the default branch, not yet in a published release).

| Tool | Arguments | Returns |
|---|---|---|
| `normalize_transcript` | `text`, `dryRun?`, `minConfidence?` | `output`, `changed`, `replacements[]`, `summary`, and `incomplete` when the text was longer than 100,000 characters or matching ran past 1 second (the unchecked rest comes back unchanged). Also bumps each term's `hits` counter |
| `add_term` | `canonical`, `aliases?`, `phonetic?`, `category?`, `notes?`, `never?`, `scope?` | The stored term, its file path and `created`. Aliases are auto-suggested when omitted |
| `remove_term` | `canonical`, `alias?`, `scope?` | Whether it existed; when not, a `note` (and `foundIn`) saying which `scope` holds it; when a copy is left in the other lexicon file, `stillIn` and a `note` naming the `scope` that removes it; when the untrusted project lexicon has a copy, `untrustedProject` { path, trust } (that file is never edited). With `alias`, removes only that alias and returns the aliases the term keeps, plus `untrustedProject` and a `note` when the untrusted project lexicon's copy of the term holds that alias too; an unknown term or alias is an error, and a refused untrusted project copy names the `scope: "global"` call |
| `list_terms` | `query?`, `category?` | Matching terms, counts per file, the paths in use, and a note when a project file was skipped as untrusted |
| `harvest_repo` | `path?`, `limit?`, `minCount?`, `add?` | Candidates. `add: true` writes them to that repo's project lexicon and adds `added` and `failures` (plus a `note` when any write failed); when none could be written the result is an error carrying the same fields |
| `export_lexicon` | `format`, `categories?`, `limit?` | The export as text |
| `learn_correction` | `heard`, `meant`, `scope?` | The term the alias was added to, `created`, `aliasAdded`, a one-line summary |
| `suggest_canonical` | `heard` (at most 60 characters) | Up to three existing terms closest to the garbled word, with confidence, for "did you mean X?"; `skippedProject` when an untrusted project lexicon was left out |
| `lexicon_stats` | none | Term and alias counts, total hits, top ten terms, never-hit terms, per-file breakdown |
| `lexicon_doctor` | none | The `lexicon doctor` checks as data: `{ ok, ready, summary, nextStep, checks: [{ level, message }], paths, versions }`, the same object `lexicon doctor --json` prints |
| `install_client` | `client`, `apply?`, `scope?` | Preview (default) or apply the MCP config for `claude`, `codex`, `cursor`, `windsurf`, `gemini`, `vscode` or `claude-desktop` |
| `trust_project` | `action` (`status`, `trust`, `untrust`), `path?` | Trust state, or a sanitized preview of the file's canonicals before pinning it. The agent shows the preview and asks first |
| `import_dictionary` | `path?` or `content?` (neither may be blank), `format?`, `scope?`, `dryRun?` | Import a Wispr, Superwhisper, macOS, espanso, markdown, text, CSV or JSON dictionary |
| `import_vocabulary` | `sources?`, `apply?`, `scope?`, `previewToken?`, `approvedCandidateIds?` | Ask which sources to read first. Omitted sources returns descriptions without probing or harvesting. Explicit sources previews candidate contents and ids. Apply uses the saved five-minute snapshot and only user-approved ids, never a fresh harvest; a missing token, unknown id or changed destination is refused |
| `list_packs` | `registry?` | The starter packs in `packs/`, their size and which are installed (from trusted files; an untrusted project lexicon adds `projectTrust`, `skippedProject` and `note`; `registryMismatch { fileOnly, recordOnly }` when `settings.packs` and the registry records disagree); with `registry` also the community packs in that index. See [PACKS.md](PACKS.md) |
| `add_pack` | `name`, `scope?`, `registry?`, `confirm?`, `previewDigest?` | Install a starter pack into the global or project lexicon. `name` as `<author>/<name>` with `registry` installs a community pack: without `confirm: true` it returns every term field and a preview digest without writing; confirmation must include that digest and the same destination, and changed content is refused. See [PACKS.md](PACKS.md) |
| `suggest_terms` | `cwd?`, `limit?` | Proposed aliases, terms, never-words and stale terms from voice history, usage and the repo |
| `apply_suggestion` | `suggestion`, `scope?` | Applies one suggestion from `suggest_terms`, passed back as received |
| `setup_lexicon` | `company?`, `person?`, `clients?`, `packs?`, `harvest?`, `serve?`, `apply?` | Without `apply` returns a plan computed by a dry run (what it would seed and harvest, the clients it detected, whether it would install the login service) and writes nothing. With `apply: true` runs `lexicon setup` non-interactively for exactly the `clients` given (omitted = none). The three that write a lot are each opt-in and separately confirmed: `packs` names the starter packs to install (omitted = none), `harvest: true` writes the repo names in `wouldHarvest` into the project `.lexicon.yaml` and trusts it, and `serve: true` installs the local API as a login service. Returns the `SetupSummary` |
| `serve_status` | none | Whether the local API is up on `127.0.0.1` (the port in `serve.json`, default 41733), with its version and term count; when it is not, `error` and a `hint` (also when another program answers on the port) |

## Resources

| Resource | Type | Content |
|---|---|---|
| `lexicon://me` | `text/markdown` | The `claude-md` export of the merged lexicon. What an agent should read at session start. Adds one line naming a skipped untrusted project file, and one saying the lexicon is empty when it has no terms |
| `lexicon://json` | `application/json` | The merged lexicon as JSON (an untrusted project file is left out, and named by path in `skippedProject`) |

## Prompts

| Prompt | Purpose |
|---|---|
| `voice-context` | The `claude-md` export plus an instruction to apply the canonical spellings for the rest of the session (with no terms, a note that there is nothing to apply and how to set it up instead) |
| `onboard` | Walks the agent through first-run setup: ask for company, product and teammate spellings, which clients are in use, then call `setup_lexicon` and `add_term` |

A lexicon file that does not parse fails every tool, resource and prompt that reads it (`onboard` reads none) with the store's error, which names the file, and a second line with the fix: `lexicon edit` (`lexicon edit --project` for a `.lexicon.yaml`), then `lexicon doctor`. A tool returns it as an `isError` result; a resource or prompt as the JSON-RPC error message.

## Writes and previews

Project-scope writes (`add_term`, `learn_correction`, `apply_suggestion`, `import_dictionary`, `harvest_repo` with `add: true`) go through the same [trust gate](TRUST.md) as the CLI and return an error instead of touching an unreviewed `.lexicon.yaml`.

`setup_lexicon`, `install_client` and `trust_project` preview by default and only write when the agent passes `apply: true` or `action: 'trust'` after showing you the preview.

Why these tools exist and how an agent is meant to chain them is in [AGENT-NATIVE.md](AGENT-NATIVE.md).

## See also

- [AGENT-NATIVE.md](AGENT-NATIVE.md) explains why these tools exist and how an agent is meant to chain them.
- [AGENTS.md](AGENTS.md) is the procedural version, written to the agent rather than about it.
- [TRUST.md](TRUST.md) covers the gate every project-scope write goes through.

Back to [the docs index](README.md).
