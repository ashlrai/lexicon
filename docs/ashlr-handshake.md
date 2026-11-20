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
  "version": "X.Y.Z",
  "protocols": { "ashlr.handshake": 1, "mcp": 1 },
  "capabilities": ["transcript-normalize", "term-lexicon", "suggest-terms", "mcp-server", "agent-install", "voice-hooks", "doctor-json", "doctor-fix"],
  "health": { "status": "ok", "checks": [{ "id": "global-lexicon", "status": "ok" }] },
  "edits": ["~/.config/lexicon/", ".lexicon.yaml", ".mcp.json", ".cursor/mcp.json", "~/.claude/settings.json", "~/.cursor/mcp.json", "~/.codex/config.toml"],
  "receipts": []
}
```

The real output is a single line. `version` is the installed package version, the same string `lexicon --version` prints. Everything else is fixed in [`src/cli/handshake.ts`](../src/cli/handshake.ts) except the `global-lexicon` check, which is `absent` until a lexicon file exists.

Rules every implementation follows:

- **Fast and local:** no network, no vault or keychain, and no secret values or project contents in the output.
- **Stable shape:** `kind` and `schema_version` identify the contract. New fields may be added in v1; renames or removals bump `schema_version`.
- **Ids:** `capabilities` and check `id`s are kebab-case. `protocols` maps a protocol name to the version spoken.
- **Health:** `health.status` is `ok`, `degraded` (works, something it relies on is missing) or `unknown`. A check status is `ok`, `missing` (counts against health) or `absent` (informational, such as no lexicon file yet on a fresh install).
- **Edits:** paths the CLI may write. `~/` is the home directory; other paths are relative to the project.
- **Receipts:** receipt kinds the CLI emits (none yet; reserved for receipt.v1).

Lexicon answers before parsing arguments; the lexicon file is only checked for existence, never read. `~/.config/lexicon/` stands for the directory of `$LEXICON_PATH` or `$XDG_CONFIG_HOME/lexicon` when set.

## Gated capabilities and the doctor envelope

Some capabilities promise a command another tool may run. The contract maps `doctor-fix` to `lexicon doctor --fix --json`: read-only (a preview, nothing is written without `--apply`), exit 0 or 1, and a JSON object with `mode` and `plan` (lexicon also adds `outcome`). `stack doctor --ecosystem --fix`, the `ashlr doctor` companions section and `lexicon doctor` rely on that mapping. See [doctor-fix.md](doctor-fix.md) for what the plan contains.

`lexicon doctor --json` (and its alias `lexicon status --json`) carries the shared `ashlr.doctor` v1 wrapper on top of its own report. The wrapper is additive: every report field stays, and the exit code is unchanged (1 when any check fails).

| Field | Value |
| --- | --- |
| `kind` | `ashlr.doctor` |
| `schema_version` | `1` (the report's own `schemaVersion: 1` sits beside it) |
| `tool` | `lexicon` |
| `status` | `fail` if any check fails, else `warn` if any check warns, else `ok` |
| `native_status` | `ok` or `failed`, from the report's `ok` |
| `checks[]` | each check keeps `level` and `message` and gains `status` (same as `level`) and `summary` (same as `message`) |

## Conformance kit

`tests/contract/ashlr-handshake.v1.json` is the contract, vendored from ashlr-stack and pinned by its sha256 in `tests/contract/ashlr-handshake.v1.json.sha256`; nothing is fetched at test time. [`tests/handshake-conformance.test.ts`](../tests/handshake-conformance.test.ts) runs the real CLI against it: `lexicon --ashlr-handshake --json` must pass every field, pattern and health rule, each gated capability lexicon advertises must run its contract argv with the expected exit codes and JSON keys (a read-only one must leave a fresh `HOME` empty), and `lexicon doctor --json` must carry the `ashlr.doctor` wrapper above. [`tests/ashlr-handshake.test.ts`](../tests/ashlr-handshake.test.ts) covers the lexicon-specific parts: one JSON line, the version from `package.json`, and nothing created on a fresh install. Change the contract file only by copying a new version from ashlr-stack and updating both pins.

## Reading other tools: `lexicon doctor`

`lexicon doctor` runs `locus --ashlr-handshake --json` and `mdopener-mcp --ashlr-handshake --json` in parallel, each with a 2 second timeout. The probe environment holds only PATH, HOME, USER, locale (`LANG`, `LC_ALL`), TMPDIR and, on Windows, `SYSTEMROOT` and `PATHEXT`, plus `NO_COLOR=1`, so no secret in lexicon's environment reaches another tool. Each tool gets one info line, `companion <name> (optional, report-only): <detail>`, where the detail is `<version> ready [capabilities]`, `<version> health: <status> [capabilities]`, `installed, too old for --ashlr-handshake` (plain text output), `installed, handshake unreadable or timed out` (`unknown`), or `not installed`, followed by `; <fix>` when there is one (a missing tool's fix is an optional install pointer to its repository). When locus or ashlr-md reports health other than `ok` and lists `doctor-fix`, the line suggests `locus doctor --fix` or `mdopener-mcp doctor --fix`; no hint is ever derived from a version. The lines are informational and never change `ok`, `ready` or the exit code. `--json` adds `companions: [{ name, command, state, version, capabilities, health, fix, next_steps }]`, where `state` is `ready`, `degraded`, `outdated`, `unknown` or `missing`. The same rules apply in `stack doctor --ecosystem` (ashlr-stack) and `ashlr doctor` (ashlr-plugin). The probing code is [`src/cli/companions.ts`](../src/cli/companions.ts).
