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
| `add_term` | `canonical`, `aliases?`, `phonetic?`, `category?`, `notes?`, `never?`, `scope?` | The stored term, its file path and `created`; `unchanged: true` and a `note` (`Nothing was added: ...`) when the term already had every alias and field given. Aliases are auto-suggested when omitted (often none are found for an ordinary name); an explicit `aliases: []` adds the term with none and generates none. A project file that was not trusted stays untrusted and the result adds `trusted: false` and a `nextStep` to relay. A value over the lexicon schema's caps (80 characters for the canonical, an alias or a `never` word; 200 and no newline for `notes` and `phonetic`) is an error naming that field, `term not added: aliases[1] ("..."): must be at most 80 characters. Nothing was written; fix that field and try again.` |
| `remove_term` | `canonical`, `alias?`, `scope?` | Whether it existed (`removed`). A term that is not found is not an error: `isError` stays false and the result has `removed: false` and a `note`, unlike `lexicon remove`, which exits 1; the `note` (and `foundIn`) says which `scope` holds it, or points at `list_terms`; when a copy is left in the other lexicon file, `stillIn` and a `note` naming the `scope` that removes it; when the untrusted project lexicon has a copy, `untrustedProject` { path, trust } (that file is never edited). With `alias`, removes only that alias and returns the aliases the term keeps, plus `untrustedProject` and a `note` when the untrusted project lexicon's copy of the term holds that alias too; an unknown term or alias is an error, and a refused untrusted project copy names the `scope: "global"` call |
| `list_terms` | `query?`, `category?` | Matching terms, counts per file, the paths in use, and a note when a project file was skipped as untrusted, or when nothing came back (the lexicon has no terms yet, or the filter matched none of them) |
| `harvest_repo` | `path?`, `limit?`, `minCount?`, `add?` | Candidates. `path` must be inside the server directory, its git root, a client root or a directory listed in `LEXICON_HARVEST_ROOTS` (otherwise an error naming `lexicon harvest <path>`). `add: true` writes them to that repo's project lexicon and adds `added`, `failures` and `path` (plus a `note` when any write failed); a file you already trusted stays trusted, while a new, untrusted or changed one is written without being trusted and the result adds `trusted: false` and a `nextStep` to relay (run `lexicon trust`); when none could be written the result is an error carrying the same fields |
| `export_lexicon` | `format`, `categories?` (omitted: every category), `limit?` (omitted: every term; a cap keeps the most-used) | The export as text; a second `Note (not part of the export)` block when it is empty or an untrusted project lexicon was left out |
| `learn_correction` | `heard`, `meant` (each at most 60 characters), `scope?` | The term the alias was added to, `created`, `aliasAdded`, a one-line summary; `trusted: false` and `nextStep` when a project file that was not trusted was written. A `heard` or `meant` over the cap is an error that says to pass only the name |
| `suggest_canonical` | `heard` (at most 60 characters) | Up to three existing terms closest to the garbled word, with confidence, for "did you mean X?"; `skippedProject` when an untrusted project lexicon was left out |
| `lexicon_stats` | none | Term and alias counts, total hits, top ten terms, never-hit terms, per-file breakdown; a `note` naming `setup_lexicon` and `add_term` when there are no terms |
| `lexicon_doctor` | none | The `lexicon doctor` checks as data: `{ ok, ready, summary, nextStep, error?, checks: [{ level, message }], paths, versions }` (`error` the first failing check's message, present exactly when `ok` is false), the same object `lexicon doctor --json` prints, except that `nextStep` names the MCP tool that fixes it (`setup_lexicon`, `install_client`, `trust_project`) or the npx form of a command only the user can run |
| `install_client` | `client`, `apply?`, `scope?` | Preview (default) or apply the MCP config for `claude`, `codex`, `cursor`, `windsurf`, `gemini`, `vscode` or `claude-desktop`: `{ client, scope, applied, ok, output, stderr?, next? }`. `ok: false` (a step failed) carries `nextStep` instead of `next`; `scope: 'project'` for `windsurf` or `claude-desktop` is an error that says to call again without scope |
| `trust_project` | `action` (`status`, `trust`, `untrust`), `path?` | Trust state, or a sanitized preview of the file's canonicals before pinning it. The agent shows the preview and asks first. For `status` and `trust`, `path` is held to the same directories as `harvest_repo`'s (otherwise an error naming `lexicon trust <path>`) |
| `import_dictionary` | `path?` or `content?` (neither may be blank), `format?`, `scope?`, `dryRun?` | Import a Wispr, Superwhisper, macOS, espanso, markdown, text, CSV or JSON dictionary. A `path` that is read (no `content`) is held to the same directories as `harvest_repo`'s (otherwise an error naming `lexicon import <path>`); `trusted: false` and `nextStep` when a project file that was not trusted was written. A project-scope `dryRun` does not read a file that is not trusted: the report has `untrustedTarget: true`, `trusted: false` and a `note`, and its rows carry no `created` |
| `import_vocabulary` | `sources?`, `apply?`, `scope?`, `previewToken?`, `approvedCandidateIds?` | Ask which sources to read first. Omitted sources returns descriptions without probing or harvesting. Explicit sources previews candidate contents and ids. Apply uses the saved five-minute snapshot and only user-approved ids, never a fresh harvest; a missing token, unknown id or changed destination is refused; `apply: true` without `sources`, `previewToken` or `approvedCandidateIds` names the missing ones and says to preview first. `previewToken` or `approvedCandidateIds` without `apply: true` is refused before any source is read, and the preview stays usable |
| `list_packs` | `registry?` | The starter packs in `packs/`, their size and which are installed (from trusted files; an untrusted project lexicon adds `projectTrust`, `skippedProject` and `note`; `registryMismatch { fileOnly, recordOnly }` when `settings.packs` and the registry records disagree); with `registry` also the community packs in that index; `registry` must be one the user registered (installed from with the CLI, or in `LEXICON_REGISTRIES`), any other is refused before it is read. See [PACKS.md](PACKS.md) |
| `add_pack` | `name`, `scope?`, `registry?`, `confirm?`, `previewDigest?` | Install a starter pack into the global or project lexicon. `name` as `<author>/<name>` with `registry` installs a community pack: without `confirm: true` it returns every term field and a preview digest without writing; confirmation must include that digest and the same destination, and changed content is refused; an unregistered `registry` is refused as in `list_packs`. A vendored pack installs directly; `registry`, `previewDigest` or `confirm: false` with one is refused and nothing is written. An install returns `{ name, title, added, merged, alreadyInstalled, path, scope, summary }`; a pack already installed in that file comes back `alreadyInstalled: true` with the summary `<name> is already installed in <path> (N terms, M aliases); nothing was added`, as `lexicon pack add` says it. See [PACKS.md](PACKS.md) |
| `suggest_terms` | `cwd?`, `limit?` (default 20) | Proposed aliases, terms, never-words and stale terms from voice history, usage and the repo, as a bare JSON array. An empty array comes with a second text block, `No suggestions: ...`, saying why (no voice history yet, or nothing new in it) and what produces suggestions. `cwd` is held to the same directories as `harvest_repo`'s `path` |
| `apply_suggestion` | `suggestion?`, `suggestions?`, `scope?` | Applies one suggestion from `suggest_terms`, passed back as received, or several at once in `suggestions` (1 to 100, in order, one write per lexicon file for a run of adds; the result is `{ count, applied, failures, summary }`, each `applied` entry the single result plus its `index`, each failure `{ index, kind, canonical, error }`, and a refused one does not stop the rest). An `alias` or `never` suggestion for a term that is no longer in the lexicon is an error and writes nothing, and so is a project suggestion whose `path` is another repo's `.lexicon.yaml` (from `suggest_terms` with `cwd`), since the server writes only its own; `trusted: false` and `nextStep` when a project file that was not trusted was written |
| `setup_lexicon` | `company?`, `person?`, `clients?`, `packs?`, `harvest?`, `serve?`, `apply?` | Without `apply` returns a plan computed by a dry run (what it would seed and harvest, the clients it detected, whether it would install the login service, and `serveBlocked` with the fix when a plugin or npx copy cannot install it) and writes nothing. With `apply: true` runs `lexicon setup` non-interactively for exactly the `clients` given (omitted = none). The three that write a lot are each opt-in and separately confirmed: `packs` names the starter packs to install (omitted = none; the plan's `packsOnOffer`, the same list as `wouldInstallPacks`, is the default set to offer, and `packsToInstall` is what the call would install, empty until `packs` names some), `harvest: true` writes the repo names in `wouldHarvest` into the project `.lexicon.yaml` (a file you already trusted stays trusted; any other is left untrusted and the result's `nextStep` asks you to run `lexicon trust`), and `serve: true` installs the local API as a login service. Returns the `SetupSummary` with its `nextStep` (in tool terms: add a name with `add_term`, or have the user dictate one) and the same step as the result's `nextStep`, after the trust step when there is one. The progress text of `lexicon setup`, whose hints name CLI flags, is not relayed; a failed client or login service is, with the retry as a tool call |
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

Neither prompt takes arguments (`prompts/list` gives `arguments: []`). Omit `arguments` or pass `{}`; an undeclared one is refused, as a tool refuses an unknown key, with JSON-RPC error -32602 naming it: `Invalid arguments for prompt onboard: unknown argument "scope" for prompt onboard: it takes no arguments; omit arguments or pass {}`.

An untrusted or changed project `.lexicon.yaml` is never parsed by `normalize_transcript`, `list_terms`, `export_lexicon`, `suggest_canonical`, `lexicon_stats`, `list_packs`, `suggest_terms`, `add_term`'s conflict check, the two resources or `voice-context`: they check trust first and name a skipped file by path only, so a large or broken repo file costs them nothing and cannot fail them. `remove_term` and `learn_correction` still parse it, because they report a copy of a term in it.

A lexicon file that does not parse fails every tool, resource and prompt that reads it (`onboard` reads none) with the store's error, which names the file, and a second line with the fix: `lexicon edit` (`lexicon edit --project` for a `.lexicon.yaml`), then `lexicon doctor`. A tool returns it as an `isError` result; a resource or prompt as the JSON-RPC error message.

## Writes and previews

No MCP tool makes a project `.lexicon.yaml` trusted on its own (see [TRUST.md](TRUST.md#what-a-write-does)). Project-scope writes from `add_term`, `learn_correction`, `apply_suggestion`, `import_dictionary`, `import_vocabulary`, `add_pack`, `harvest_repo` with `add: true` and `setup_lexicon` with `harvest: true` land in a file you already trusted as usual and keep it trusted; a file that does not exist yet, or is untrusted or changed, is written without being trusted, and the result adds `trusted: false` and a `nextStep` asking you to review it and run `lexicon trust`.

A tool that reads a path the model names (`harvest_repo`'s `path`, `suggest_terms`'s `cwd`, `trust_project`'s `path` for `status` and `trust`, `import_dictionary`'s `path`) reads only inside the server directory and its git root, the client's MCP roots, and the absolute directories you list in `LEXICON_HARVEST_ROOTS` (separated by `:`, or `;` on Windows) in the server's environment. Symlinks are resolved first. Anything else is refused with the command you can run yourself (`lexicon harvest <path>`, `lexicon suggest --cwd <path>`, `lexicon trust <path>`, `lexicon import <path>`).

`setup_lexicon`, `install_client` and `trust_project` preview by default and only write when the agent passes `apply: true` or `action: 'trust'` after showing you the preview.

Why these tools exist and how an agent is meant to chain them is in [AGENT-NATIVE.md](AGENT-NATIVE.md).

## Environment variables

Set these in the MCP server's environment (the `env` block of the client's server entry, or `claude mcp add -e`). Each is a decision for you to make, not for the model: none can be changed from a tool call.

| Variable | Effect |
|---|---|
| `LEXICON_PATH` | The global lexicon file. Default `$XDG_CONFIG_HOME/lexicon/lexicon.yaml`, else `~/.config/lexicon/lexicon.yaml`; `trust.json` and the other per-user files sit next to it |
| `LEXICON_CWD` | The directory the server finds the project `.lexicon.yaml` from, instead of the client's first MCP root or its own working directory. `lexicon install` passes it through when set |
| `LEXICON_HARVEST_ROOTS` | More absolute directories that `harvest_repo`'s `path`, `suggest_terms`'s `cwd`, `trust_project`'s `path` and `import_dictionary`'s `path` may name, separated by `:` (`;` on Windows). See [Writes and previews](#writes-and-previews) |
| `LEXICON_REGISTRIES` | More community pack registry indexes `list_packs` and `add_pack` may read, separated by commas or newlines (an `https://` URL or an absolute path). Without it only an index you installed a pack from with the CLI is read; see [PACKS.md](PACKS.md) |
| `LEXICON_TRUST_ALL` | `1` treats every project `.lexicon.yaml` as trusted. Only for CI or a throwaway container where the repo is already vetted; see [TRUST.md](TRUST.md) |

## See also

- [AGENT-NATIVE.md](AGENT-NATIVE.md) explains why these tools exist and how an agent is meant to chain them.
- [AGENTS.md](AGENTS.md) is the procedural version, written to the agent rather than about it.
- [TRUST.md](TRUST.md) covers the gate every project-scope write goes through.

Back to [the docs index](README.md).
