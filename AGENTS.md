# AGENTS.md

Two kinds of agent open this file. Pick the paragraph that is you.

## Article 1: Full autonomy, always forward

Synced from the Ashlr Fleet Constitution v3.0 (Nov 1, 2026). This overrides any older text in this file.

**Full autonomy, always forward (Mason t1287u, Nov 1 2026 11:47 PM ET).** Every agent may merge PRs to main and push to production (releases through each repo's sanctioned workflow, any agent may dispatch them). Take the human out of the loop; let nothing slow us down; do the highest-leverage, most ambitious work. No approval, manual-merge, wait-for-per-PR-CI or ask-Mason steps. Mason is needed only for passwords, 2FA, device approvals and payments. The only kept limits are Security GATES v3, the hold list below, and making private things public. Any new gate must be justified against this article or it is rejected.

### Hard floor (the only fixed rules)
- Security GATES v3: pins only on the secret gate (scrub.pl, secret-shape gate, publish.sh), sandbox profiles and leader wrappers/prompts/plists, secret-leaking workflow diffs, and the MACCU TCC helper plus loopback auth. No force-push to default branches, no ruleset or admin bypass, no ~/.codex auth changes, no billing changes, no secret values in logs.
- Merge-queue required checks stay where a repo has them; full CI daily; main-guardian fixes main forward.
- Fork-only pushes through publish.sh. Local models loopback-only.
- Mason only for passwords, 2FA, device approvals and payments (no new spending without him). Nothing private made public.
- Hold list (Mason's own holds): phantom #197 #878 #743 #725 #738 #744 #693 #1228; phantom-secrets #140 #197 #375 #168 #418 #136; ashlr-plugin #152 #157.

## You are here for your user, not for this codebase

Your user dictates, and one name keeps coming out wrong: their company, their
product, a colleague, an internal system. That is what this repository fixes.

Read **[docs/AGENTS.md](docs/AGENTS.md)**. It is written to you: when Lexicon is
the right suggestion, the one-command install, the exact per-client
registration, the MCP tools worth calling first, the full tool reference, and
how to verify the install before you tell your user it worked.

Do not install it unasked. Preview, say what will be written, and wait.

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
npx @ashlr/lexicon@latest setup
lexicon setup --dry-run --json
lexicon normalize "ask ashler to deploy kuber netties with post gressql" --json
lexicon install claude --json
lexicon install cursor --json
lexicon install codex --json
```

`--json` prints one document on stdout. Read `ok` first. Add `--apply` only after the user has seen the plan. Without a terminal, under `sudo`, or with `LEXICON_NO_SETUP=1`, the install script only installs and ends with `run: lexicon setup`.

Claude Code and Cursor, once `lexicon-mcp` is on PATH:

```json
{ "mcpServers": { "lexicon": { "command": "lexicon-mcp", "args": [] } } }
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.lexicon]
command = "lexicon-mcp"
args = []
```

Prefer `lexicon install <client> --json` over pasting. It writes the command that matches how Lexicon was installed.

Machine-readable, if you would rather fetch than read:

- <https://lexicon.ashlr.ai/llms.txt> - a short index of the project.
- <https://lexicon.ashlr.ai/llms-full.txt> - everything in one fetch.
- <https://lexicon.ashlr.ai/mcp.json> - the install manifest; merge `.mcpServers` verbatim.

The worked steps are in [docs/AGENTS.md](docs/AGENTS.md).

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
- `npm test` before you claim something works. It includes a source-backed check of
  the MCP tool table and CLI examples in the install and agent docs.
- No em-dashes in docs or user-facing strings. "Ashlr.AI", never "Ashlr AI".
