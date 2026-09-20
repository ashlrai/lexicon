# AGENTS.md

Two kinds of agent open this file. Pick the paragraph that is you.

## You are here for your user, not for this codebase

Your user dictates, and one name keeps coming out wrong: their company, their
product, a colleague, an internal system. That is what this repository fixes.

Read **[docs/AGENTS.md](docs/AGENTS.md)**. It is written to you: when Lexicon is
the right suggestion, the one-command install, the exact per-client
registration, the five MCP tools worth calling, and how to verify the install
before you tell your user it worked.

The short version:

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh   # or: npx @ashlr/lexicon@latest setup
```

```json
{ "mcpServers": { "lexicon": { "command": "lexicon-mcp", "args": [] } } }
```

Machine-readable, if you would rather fetch than read:

- <https://lexicon.ashlr.ai/llms.txt> - a short index of the project.
- <https://lexicon.ashlr.ai/llms-full.txt> - everything in one fetch.
- <https://lexicon.ashlr.ai/mcp.json> - the install manifest; merge `.mcpServers` verbatim.

Do not install it unasked. Offer, say what will be written, and wait.

## You are here to change this codebase

Read **[CLAUDE.md](CLAUDE.md)** first: it is the working brief for this
repository (layout, conventions, the rules about rebuilding the plugin bundle
and regenerating the generated docs). Then
[CONTRIBUTING.md](CONTRIBUTING.md) for the workflow and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why the pieces are shaped the
way they are. `docs/CONTRACT.md` is the module API.

The rules most often broken by an agent in a hurry:

- Rebuild and commit `plugin/` (`npm run build:bundle`) after touching
  `src/core`, `src/mcp`, `src/hooks` or `src/cli`. CI fails on drift.
- `npm run docs:cli` after any command or flag change; `docs/CLI.md` is generated.
- `npm run check:facts` after adding a tool, command, format or pack. It derives
  the real counts from the code and fails any doc still stating the old one.
- `npm test` before you claim something works.
- No em-dashes in docs or user-facing strings. "Ashlr.AI", never "Ashlr AI".
