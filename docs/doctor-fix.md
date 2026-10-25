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

Exit codes: 0 when there is nothing to repair, after a preview, or when every fix applied;
1 when an applied fix was skipped (for example the file changed between plan and apply).
`--apply` without `--fix` is refused (exit 1, nothing written).

## Repairs

| Finding | `--apply` does |
| --- | --- |
| global lexicon missing | creates it empty, as `lexicon init` does (run `lexicon setup` to add terms) |
| `trust.json` is not valid JSON or not a registry | backs it up, then removes it; projects read as untrusted (as they already did) until `lexicon trust` |
| `hits.json` unusable | backs it up, then removes it; hit counts start over |
| pending corrections queue unusable | backs it up, then removes it |
| index cache unusable | backs it up, then removes it; the next match writes a new one |

Before each fix the file is checked again; one that is fine or gone now is skipped. A backup
is `<file>.bak-<UTC stamp>` beside it, created new (never over another file) with mode 0600,
and compared byte for byte with the original before the original is removed.

## Manual items (report only)

- A global or project lexicon that does not parse or cannot be read: it holds your terms. Fix it with `lexicon edit`.
- `serve.json` unusable: it holds the local API pairing token, so it is never changed here.
- A state path that is a directory or a symlink.
- The Claude hook and MCP registration: `lexicon install claude --apply` previews and edits those itself.

`--json` plan entries: `fixes` (`{ kind: "create_global_lexicon" | "move_aside", target?, file, reason }`)
and `report_only` (`{ code, file?, message }`); `outcome` is `null` for a preview, else
`{ results: [{ fix, applied, backup?, message? }] }`.
