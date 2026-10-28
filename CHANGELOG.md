- `lexicon trust` off a terminal (a script, CI, an agent's shell) no longer pins the file silently: without `--yes` it prints the preview, trusts nothing, names the `lexicon trust <path> --yes` command and exits 1 (`{ ok: false, ... }` under `--json`). No environment variable bypasses this. With `--yes` it pins and prints the path and sha256 as before. A file already trusted at the same bytes still reports `already trusted`. Scripts that ran `lexicon trust` unattended must add `--yes`.

### Added

- `npm run fresh:sync` and `npm run fresh:check` (`scripts/freshness/`): doc blocks between `fresh:begin name` / `fresh:end` HTML-comment markers -- release badges, pinned install snippets, the release table above, `#vX.Y.Z` example pins -- are regenerated from `package.json's version and the dated sections of this changelog, and the check exits 1 on drift or a malformed marker. The markers are seeded in README.md, llms-install.md, docs/RELEASING.md, examples/README.md and this file.

- `--dry-run` previews init, add, remove, harvest --add, export --out, review and edit without saving changes. Edit reports its target without launching an editor. Pack install, update and removal, trust, untrust, learn and pending accept/reject also support previews that keep lexicon, trust and registry state unchanged.

- `lexicon pending reject` remembers what you rejected: the pending file gains a `rejected:` list of ids (never the words, capped at 500), and the prompt hook no longer queues a correction you already rejected. `lexicon learn` with the same words still works. Additive file change; an older lexicon that rewrites the file forgets the list.
- `node scripts/bench/startup.mjs` times one CLI cold start (`--version` and `normalize --diff`) and one in-process `normalize`. Stdout is a single JSON document. The Lexicon rows in [docs/BENCHMARKS.md](docs/BENCHMARKS.md) are one run of that command, not a saved baseline. See [scripts/bench/README.md](scripts/bench/README.md).
- `lexicon suggest` lists the pending corrections queue first (newest first), each with its id, heard -> meant, source (for example `prompt-hook`) and count, plus the `lexicon pending accept/reject <id>` commands. Listing never changes the queue or the lexicon; an unreadable queue is a stderr warning, not a failure. `--json` output is unchanged.

