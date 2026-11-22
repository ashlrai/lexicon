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

## How `ok` is set

The envelope never invents its own verdict. `ok` is `false` when `data` is an
object whose own `ok` is `false`, or an array with any such element, and `true`
otherwise. So a payload without an `ok` field, such as the bare term array
`lexicon list --json` prints, is wrapped with `ok: true`.

Most payloads repeat the flag inside `data` (`data.ok`), which is the same
value. Two things follow:

- `ok: false` is not always an error. A status probe answers "no" this way:
  `lexicon voice --status --json=v1` when idle prints
  `{ "schemaVersion": 1, "ok": false, "data": { "ok": false, "recording": false } }`
  and exits 1, with no `data.error`. Branch on `data.error` (or the exit code
  the command documents) when you need to tell a refusal from a negative answer.
- The exit code still comes from the command. `lexicon remove Nope --json=v1`
  on a term that does not exist prints `ok: false` with `data.error`,
  `data.nextStep`, `data.canonical` and `data.removed: false`, and exits 1.

## Failures you get as JSON

Every refusal is one envelope on stdout with `ok: false`, `data.ok: false`,
`data.error` and `data.nextStep`, and the command exits 1:

| Situation | Example `data.error` | `data.nextStep` |
|---|---|---|
| Unknown option | `unknown option '--bogus'` | `see the usage: lexicon list --help` |
| Missing argument | `missing required argument 'canonical'` | `see the usage: lexicon add --help` |
| Too many arguments, an unknown command included | `too many arguments for 'remove'. Expected 1 argument but got 2.` | `see the usage: lexicon remove --help` |
| Version other than `v1` | `unsupported JSON version: v2` | `use --json=v1` |
| A command with no single result (`edit`, `review`, `mcp`, `hook`, the clipboard watcher) | `review is interactive and has no --json output` | the commands or MCP tools to use instead |

Argument errors print the same document under plain `--json`, without the
envelope. The usual human message also goes to stderr; an unsupported version
writes nothing to stderr.

The version is matched exactly: `--json=V1`, `--json=1` and an empty
`--json=` are all refused, before the command runs or reads anything. When
the flag is given more than once, the first version other than `v1` wins, so
`--json=v1 --json=v2` is refused; `--json=v1 --json` is fine.

## Help, version and command groups

- `lexicon --version --json=v1` prints `{ "data": { "output": "<version>\n" } }`
  inside the envelope, and `lexicon <command> --help --json=v1` puts the help
  text in `data.output`.
- `lexicon --json=v1` on its own, or a group such as `lexicon pack --json=v1`,
  returns `data.commands`, the subcommand names, with `ok: true`.
- `lexicon help --json=v1` is not a help command: it is refused as an extra
  argument. Use `--help`.

## Where the flag goes

Only arguments before `--` are read as flags, so text after it stays literal:
`lexicon normalize hi -- --json=v1` prints `hi --json=v1` as plain text.

`--json=v1` always runs the full CLI. The resident daemon's fast reads for
`list`, `stats`, `path` and `export` ([DAEMON.md](DAEMON.md)) apply only to
the unversioned forms, so a versioned read pays normal start-up time and
always gets the envelope.

Back to [the docs index](README.md).
