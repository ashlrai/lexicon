# lexicon doctor --fix

`lexicon doctor --fix` previews repairs and writes nothing. `lexicon doctor --fix --apply`
makes them, backing up each file first. Add `--json` for a `{ mode, plan, outcome }` object.
Same semantics as `locus doctor --fix`; `stack doctor --fix` runs it because the handshake
(`lexicon --ashlr-handshake`) lists the `doctor-fix` capability.

```bash
lexicon doctor --fix            # dry run: "would fix" lines and manual items
lexicon doctor --fix --apply    # make the repairs (each file backed up first)
lexicon doctor --fix --json     # { "mode": "dry_run", "plan": {...}, "outcome": null }
```

`--cwd <dir>` picks the directory used to find the project `.lexicon.yaml`, as it does for
every command; `LEXICON_PATH` picks the global lexicon, and the state files checked below are
the ones beside it.

Exit codes: 0 when there is nothing to repair, after a preview, or when every fix applied;
1 when an applied fix was skipped (for example the file changed between plan and apply).
Manual items never change the exit code.
`--apply` without `--fix` is refused (exit 1, nothing written): stderr says
`lexicon: --apply needs --fix (...)` and `lexicon: run: lexicon doctor --fix --apply`, and with
`--json` stdout gets `{ "ok": false, "error", "nextStep" }`.

## Repairs

| Finding | `--apply` does |
| --- | --- |
| global lexicon missing | creates it empty, as `lexicon init` does (run `lexicon setup` to add terms) |
| `trust.json` is not valid JSON or not a registry | backs it up, then removes it; every project lexicon reads as untrusted (as it already did) until you run `lexicon trust` in it again |
| `hits.json` unusable | backs it up, then removes it; hit counts start over |
| pending corrections queue unusable | backs it up, then removes it; queued corrections are kept only in the backup |
| index cache unusable | backs it up, then removes it; the next match writes a new one |

Before each fix the file is checked again; one that is fine or gone now is skipped, and so is
a global lexicon that exists by then. A backup is `<file>.bak-<UTC stamp>` beside it (for
example `hits.json.bak-20261121T200655Z`, with `-1`, `-2` and so on appended when that name is
taken), created new (never over another file) with mode 0600, and compared byte for byte with
the original before the original is removed. If they differ, the original stays and the fix is
reported as skipped with its backup.

## Manual items (report only)

- A global lexicon that does not parse or cannot be read: it holds your terms. Fix it with `lexicon edit`.
- A project lexicon that does not parse or cannot be read: fix it with `lexicon edit --project`.
- `serve.json` unusable: it holds the local API pairing token, so it is never changed here. The item suggests `lexicon serve --uninstall && lexicon serve --install`.
- A state path (trust, hits, pending queue or index cache) that is a directory, a symlink or cannot be read: move it aside by hand.
- The Claude hook and MCP registration are not checked here: plain `lexicon doctor` reports them, and `lexicon install claude --apply` previews and edits those itself.

## Output

A preview prints `doctor --fix (dry run, nothing written):`, one `would fix` line per repair
naming the file, the reason and the effect, then the line to run with `--apply`. `--apply`
prints `doctor --fix --apply:` and one `fixed` or `skipped` line per repair, followed by its
`backup:` path when one was made and, for a skip, the reason. With nothing to repair it prints
`doctor --fix: nothing to repair`. Every manual item follows as a `manual` line.

`--json` plan entries: `fixes` (`{ kind: "create_global_lexicon" | "move_aside", target?, file, reason }`,
where `target` is `trust`, `hits`, `pending` or `index_cache`) and `report_only`
(`{ code, file?, message }`, where `code` is `global_lexicon_unreadable`,
`project_lexicon_unreadable`, `serve_config_unusable` or `<target>_not_a_file`). `mode` is
`dry_run` or `apply`. `outcome` is `null` for a preview and for `--apply` when there is nothing
to repair, else `{ results: [{ fix, applied, backup?, message? }] }`.

## Companions

Plain `lexicon doctor` also asks locus and ashlr-md for their handshake. When one reports
health other than `ok` and lists `doctor-fix`, it suggests `locus doctor --fix` or
`mdopener-mcp doctor --fix`; `lexicon doctor --fix` never runs them. See
[ashlr-handshake.md](ashlr-handshake.md).
