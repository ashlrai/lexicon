# Source versus npm commands

The [CLI reference](CLI.md) and [module contract](CONTRACT.md) describe this
checkout, not necessarily the `lexicon` executable installed on your PATH.
[Issue #221](https://github.com/ashlrai/lexicon/issues/221) reports differences
between the source and npm package `@ashlr/lexicon` **0.5.4**. The comparison
below is a historical snapshot, not a claim about the latest npm release.

The [first-run report](FIRST-RUN.md) measured npm 0.5.4 and source 0.5.6 on
2026-10-26. The issue supplies the remaining package differences. Releases and
source can change after that date, so verify the actual executable and its help
before relying on a command or flag. A checkout's package version alone does not
prove which version is installed on PATH.

## Status

Every row below has since shipped. The last column names the earliest version
whose [CHANGELOG](../CHANGELOG.md) section mentions it. Not every CHANGELOG
version was published: npm went from 0.5.4 to 0.5.8 (0.5.5, 0.5.6 and 0.5.7
never reached npm or a GitHub release), so every row first reached npm in
0.5.8, the "On npm since" column. The first-run report was rechecked on
2026-11-19, when npm served 0.5.12, so a current npm install has all of them.
The gap matters only for an executable older than the version in the last
column (any npm install older than 0.5.8): check it as described in [Check what you are running](#check-what-you-are-running).

| Command or flag | npm 0.5.4 at the reported snapshot | Source behavior | On npm since | CHANGELOG version |
| --- | --- | --- | --- | --- |
| `lexicon doctor --fix` | Source-only; 0.5.4 reports an unknown option. | Previews safe repairs without writing; add `--apply` to perform them. | 0.5.8 | 0.5.7 |
| `lexicon doctor --json` | Source-only; 0.5.4 reports an unknown option. | Prints the doctor report as JSON; failed checks still affect the exit code. | 0.5.8 | 0.5.6 |
| `lexicon pending` | Source-only in the issue's comparison. | Lists queued corrections; `pending accept` learns them and `pending reject` drops them. | 0.5.8 | 0.5.7 |
| `lexicon add --json` | Source-only; 0.5.4 reports an unknown option. | Reports the add result as JSON; adding still writes. | 0.5.8 | 0.5.6 |
| `lexicon install --json` | Source-only; 0.5.4 reports an unknown option. | Reports the install result as JSON; install previews by default and `--apply` writes. | 0.5.8 | 0.5.6 |
| `lexicon uninstall` | Source-only in the issue's comparison. | Removes supported client integration entries; `--dry-run` previews the changes. | 0.5.8 | 0.5.7 |

This table is not a complete inventory of differences. In particular, the
first-run report also found `init --json` unavailable in 0.5.4 (its CHANGELOG
section is 0.5.6; it first reached npm in 0.5.8), while
`normalize --json` and `setup --json` worked there.

## Check what you are running

In a POSIX shell, identify the executable selected by PATH, then inspect its
version and help. An unknown command or option means that executable cannot use
the corresponding source example.

```sh
command -v lexicon
lexicon --version
lexicon --help
lexicon doctor --help
lexicon add --help
lexicon install --help
```

If `pending` or `uninstall` is listed in the top-level help, inspect it with
`lexicon pending --help` or `lexicon uninstall --help`. To check the npm
registry's current latest version independently of the installed executable,
run `npm view @ashlr/lexicon version`; the registry version does not identify
the binary already on PATH. An executable older than the release a command
needs is upgraded by rerunning the README install, `npm install -g @ashlr/lexicon`.

To inspect this checkout without changing the installed executable, install its
dependencies as described in [CONTRIBUTING.md](../CONTRIBUTING.md#setup), then
run these from the repository root:

```sh
node --import tsx src/cli/index.ts --version
node --import tsx src/cli/index.ts --help
node --import tsx src/cli/index.ts doctor --help
node --import tsx src/cli/index.ts pending --help
```

Use the source entry point explicitly when following a source-only example, and
review each command's write behavior first. Installing dependencies can run the
repository's build scripts; these help commands do not install a CLI on PATH.
