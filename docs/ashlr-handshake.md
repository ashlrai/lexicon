# Ashlr companion handshake (v1)

`lexicon --ashlr-handshake` (with or without `--json`) prints one JSON object and exits 0. `phm companions`,
`phm doctor` or an agent can call it instead of parsing `--help`. The same
contract is implemented by `locus`, `stack` (ashlr-stack), `ashlr-plugin` and
`mdopener-mcp` (ashlr-md), each with `--ashlr-handshake`.

```json
{
  "kind": "ashlr.handshake",
  "schema_version": 1,
  "name": "lexicon",
  "command": "lexicon",
  "version": "0.5.6",
  "protocols": { "ashlr.handshake": 1, "mcp": 1 },
  "capabilities": ["transcript-normalize", "term-lexicon", "suggest-terms", "mcp-server", "agent-install", "voice-hooks", "doctor-json"],
  "health": { "status": "ok", "checks": [{ "id": "global-lexicon", "status": "ok" }] },
  "edits": ["~/.config/lexicon/", ".lexicon.yaml", ".mcp.json", ".cursor/mcp.json", "~/.claude/settings.json", "~/.cursor/mcp.json", "~/.codex/config.toml"],
  "receipts": []
}
```

Rules every implementation follows:

- **Fast and local:** no network, no vault or keychain, and no secret values or project contents in the output.
- **Stable shape:** `kind` and `schema_version` identify the contract. New fields may be added in v1; renames or removals bump `schema_version`.
- **Ids:** `capabilities` and check `id`s are kebab-case. `protocols` maps a protocol name to the version spoken.
- **Health:** `health.status` is `ok`, `degraded` (works, something it relies on is missing) or `unknown`. A check status is `ok`, `missing` (counts against health) or `absent` (informational, such as no lexicon file yet on a fresh install).
- **Edits:** paths the CLI may write. `~/` is the home directory; other paths are relative to the project.
- **Receipts:** receipt kinds the CLI emits (none yet; reserved for receipt.v1).

Lexicon answers before parsing arguments; the lexicon file is only checked for existence, never read. `~/.config/lexicon/` stands for the directory of `$LEXICON_PATH` or `$XDG_CONFIG_HOME/lexicon` when set.
