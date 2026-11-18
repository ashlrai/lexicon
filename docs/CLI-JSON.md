# Versioned CLI JSON

For an agent or script, append `--json=v1` to any command:

```sh
lexicon list --json=v1
lexicon add Ashlr.AI Ashler --dry-run --json=v1
lexicon normalize "ask Ashler" --json=v1
```

Stdout contains one document with this typed envelope:

```ts
interface CliJsonV1<T = unknown> {
  schemaVersion: 1;
  ok: boolean;
  data: T;
}
```

Read `ok` first, then use `data`. The data is the same payload the command's
existing `--json` returns: an object or an array. A failed batch has `ok: false`
if any entry failed. Refusals carry `data.error` and `data.nextStep`; batch
refusals carry these on the failed entries. Diagnostics stay on stderr and
exit codes keep their existing meaning. Help and version flags return
`data.output`. A bare command group returns `data.commands`.

Use `--json=v1` after the command and its arguments, before any `--` separator.
An unsupported version returns a v1 error document and exits 1 without running
the command. Existing `--json` output remains compatible for older scripts.
Ordinary terminal output is unchanged.

Interactive `edit` and `review` return a refusal with the commands to use
instead. `mcp` and `hook` return a refusal because they own stdout protocols;
start them without the JSON flag. Clipboard JSON uses `daemon --once` or
`daemon --which`; a continuous watcher returns a refusal. `serve` reports its
listening information once and continues serving until stopped.
