# Copy-paste

Commands only. Every one runs. `--json` prints one document on stdout. Read `ok` first. A refusal is `{ ok: false, error, nextStep }`.

Do not install Lexicon for someone until they have seen the dry-run plan.

The same text, for a model that wants one fetch: [llms.txt](../llms.txt) and [llms-full.txt](../llms-full.txt). Narrative: [AGENTS.md](AGENTS.md).

## Install

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
```

The script runs `lexicon setup` when it has a terminal. Without a terminal, under `sudo`, or with `LEXICON_NO_SETUP=1`, it only installs and ends with `run: lexicon setup`.

```bash
npx @ashlr/lexicon@latest setup
brew install ashlrai/tap/lexicon
npm i -g @ashlr/lexicon
```

Plain `brew install lexicon` is a different project. Use the tap name above.

## Preview, then apply

```bash
lexicon setup --dry-run --json
lexicon setup --yes --packs developer,ai --json
```

## Correct, add, learn, check

```bash
lexicon normalize "ask ashler to deploy kuber netties with post gressql" --json
lexicon normalize --diff "ask ashler to deploy kuber netties with post gressql"
lexicon add Ashlr.AI Ashler Ashlar "Ashler AI" --phonetic ASH-ler --json
lexicon learn --from "it's Ashlr.AI not Ashler" --dry-run --json
lexicon doctor --json
```

`normalize --json` on an empty lexicon sets `example` to true and writes nothing. `--diff` prints the replacements on stderr:

```text
"ashler" -> "Ashlr.AI" (alias, 1.00)
"kuber netties" -> "Kubernetes" (phonetic, 0.88)
"post gressql" -> "PostgreSQL" (phonetic, 0.88)
```

Stdout is `ask Ashlr.AI to deploy Kubernetes with PostgreSQL`.

## MCP: Claude, Cursor, Codex

```bash
lexicon install claude --json
lexicon install claude --apply --json
lexicon install cursor --json
lexicon install cursor --apply --json
lexicon install codex --json
lexicon install codex --apply --json
```

Without `--apply`, nothing is written. Restart Claude Code and Codex after apply. Reload Cursor.

Hand config, only when `lexicon-mcp` is on PATH:

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

Codex uses TOML at `~/.codex/config.toml`:

```toml
[mcp_servers.lexicon]
command = "lexicon-mcp"
args = []
```

Claude Code plugin, no CLI:

```bash
claude plugin marketplace add ashlrai/lexicon
claude plugin install lexicon@ashlrai
```

## Tools to call

```text
normalize_transcript { text }
learn_correction { heard, meant }
add_term { canonical, aliases?, phonetic? }
setup_lexicon { apply? }
lexicon_doctor {}
```

`setup_lexicon` and `install_client` write nothing until `apply` is true.

Back to [the docs index](README.md).
