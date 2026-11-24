# Contributing

Small, well-scoped pull requests are the easiest kind to merge here. A new starter pack, one exporter, one importer, one harvester source, one matcher guard.

## New contributors

Questions and work in progress go in [The Dev Shack](https://discord.gg/jBQrSU6XeD) on Discord.

**Dev setup.** From a clone, one command. It is safe to run again, it asks nothing, and it works on macOS and Linux. It installs Node 20 or newer when the copy on PATH is missing or older, installs dependencies from the lockfile, and runs the smoke test:

```bash
bash scripts/setup.sh
```

A [dev container](.devcontainer/devcontainer.json) runs that same script when the container is created.

**Tests.** `npm test` runs the suite. While you are changing one module, `npx vitest run tests/<file>.test.ts` is enough. The commands a pull request must pass are listed in [Contribute with an agent](#contribute-with-an-agent).

**Pick a task.** Open the [`good first issue`](https://github.com/ashlrai/lexicon/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) list and take one issue. It names the files to touch and how to check the result. Say so on the issue before you start. When that list is empty, use a shape from [Good first issues](#good-first-issues).

**Pull request.**

1. Fork `ashlrai/lexicon` and clone your fork.
2. Make a branch from `main`.
3. Open a pull request against `main`.
4. Wait until `CI Gate` is green.
5. Maintainers merge it through the merge queue.

The same path, with the exact gate commands, is [Contribute with an agent](#contribute-with-an-agent).

## Good first issues

If you want a concrete place to start, look at the [`good first issue`](https://github.com/ashlrai/lexicon/labels/good%20first%20issue) label. It marks self-contained work: the issue names the files to touch and how to check the result. The label often has no open issues; when it is empty, pick a shape from the table below instead. The open [`help wanted`](https://github.com/ashlrai/lexicon/labels/help%20wanted) issues are platform work (a tray app, a Firefox listing), larger than a first pull request. The recipes below cover the four most common shapes.

The lowest-effort contribution of all needs no code: if speech-to-text mangles a public name and the lexicon does not catch it, open a [misheard term issue](https://github.com/ashlrai/lexicon/issues/new?template=misheard_term.yml) with the canonical spelling and what your STT engine actually wrote. Real transcripts are worth more than guesses, and they feed both the starter packs and the benchmark corpus. The form labels each one `good first issue`, so a reported term is also a ready first pull request for whoever adds it to its pack.

Good shapes for a first PR:

| Shape | Recipe | Roughly |
|---|---|---|
| A public name speech-to-text gets wrong, added to the starter pack it fits | [docs/PACKS.md](docs/PACKS.md#adding-a-term-to-a-shipped-pack) | One YAML entry, plus a count if a test or doc pins it |
| A term pack for a profession the packs do not cover (law, medicine, finance, design) | [docs/PACKS.md](docs/PACKS.md#adding-a-pack-to-this-repo) | One YAML file plus one test |
| An export format for another dictation app or STT engine | [Adding an exporter](#adding-an-exporter) | Three files plus a test |
| An import format for a dictionary the tool cannot read yet | [Adding an importer](#adding-an-importer) | Three files plus a test |
| A harvester source (a new manifest type, a new identifier convention) | [Adding a harvester source](#adding-a-harvester-source) | One function plus a fixture |
| A term the matcher gets wrong | A failing case in `tests/normalize.test.ts`, then the guard in `src/core/matcher.ts` | One test plus one guard |

Before you start: say so on the issue so two people do not write the same exporter. If nothing on the list fits, open an issue describing the correction that went wrong, with the output of `lexicon normalize --diff "<what STT wrote>"`.

## Contribute with an agent

Lexicon is part of the Ashlr.AI ecosystem, where most changes are written, verified and merged by coding agents. Your pull request goes through the same path as theirs, whether you or your agent writes it. The short version:

1. **Fork and clone.** Fork `ashlrai/lexicon` on GitHub, clone your fork, then install from the lockfile and build:

   ```bash
   git clone https://github.com/<you>/lexicon
   cd lexicon
   npm ci
   npm run build
   ```

2. **Point the agent at the brief.** Claude Code reads [CLAUDE.md](CLAUDE.md) on its own; other agents start at [AGENTS.md](AGENTS.md), which routes them to the same brief. It holds the layout, the conventions and the rules agents most often miss.
3. **Make one small change on a branch**, with its test (see the shapes in [Good first issues](#good-first-issues)).
4. **Verify what you touched, then everything.** After `npm run build`, `node dist/cli/index.js test-select` (or `lexicon test-select` after `npm link`) prints the test commands for your staged, unstaged and untracked changes and falls back to `npm test` when it cannot narrow them. Its mapping is deliberately small (see [Tests](#tests)), so for most changes, including anything under `src/`, a doc or a pack, it prints `npm test`; while iterating on a module, run its own file directly (`npx vitest run tests/matcher.test.ts`). Before pushing, run what the required gate runs plus the full suite, which the gate does not:

   ```bash
   npm run typecheck
   npm run build
   npm run check:crypto
   npx vitest run tests/upstream-redaction.test.ts
   npm test
   ```

   Then the rule-driven extras from [CLAUDE.md](CLAUDE.md): `npm run build:bundle` and commit `plugin/` when `src/core`, `src/mcp`, `src/hooks`, `src/cli` or a dependency changed (`npm run check:bundle` confirms nothing drifted); `npm run docs:cli` after a command or flag change; `npm run check:facts` after adding a tool, command, format or pack; update `docs/CONTRACT.md` when a public signature changes and the README tables when a tool, format or command is added; `npm run check:links` after moving a doc; `npm run fresh:check` when a version or release fact moved.
5. **Push to your fork and open a pull request against `main`.** Fill in the template checklist and add a `CHANGELOG.md` bullet under `Unreleased`.

What happens next:

- The one required check is **`CI Gate`**. It passes only when the fast job (typecheck, build, crypto policy, redaction tests) and both diff secret scans (pinned Gitleaks and the secret-shape scan over added lines) succeed; a skipped or cancelled job fails it. The scans ignore any `.gitleaks.toml` or `.gitleaksignore` in the PR, so a leak cannot be allowlisted from the same diff. Never commit a token, even a fake one shaped like a real one.
- On a first pull request from a fork, GitHub may hold the workflow runs until a maintainer approves them. That is GitHub's default for new contributors, not a failure.
- Merging goes through GitHub's merge queue, which runs `CI Gate` again on the result of merging your branch with current `main` and squash-merges it when green. Nothing else blocks: the branch rules require no approving review and do not require your branch to be up to date with `main`, so there is no need to rebase just to catch up.
- Auto-merge is how a pull request enters the queue: `gh pr merge --auto <number>` (or **Enable auto-merge** on the PR page) queues it as soon as `CI Gate` passes. GitHub only lets accounts with write access do this, so on a fork PR a maintainer or the fleet arms it for you. A new push to the branch re-runs the gate first.
- Changes under the paths in [`.github/CODEOWNERS`](.github/CODEOWNERS) (workflows, `CODEOWNERS` itself, `src/serve/`, the serve and argument parsing CLI files, the crypto check, the secret-shape scan fixtures) request a review from the code owner. The request is a signal to look, not a merge requirement.
- The full portable suite (every OS, Node 20/22/24, e2e, bundle drift, doc checks) runs daily on `main`, not on your PR. That is why the local `npm test` above matters: a break it would have caught lands on `main` and becomes a fix-forward issue.

## Setup

The one-command path is in [New contributors](#new-contributors) (`bash scripts/setup.sh`). Node 20 or newer. To do the same steps by hand, clone and install as in step 1 of [Contribute with an agent](#contribute-with-an-agent); to only read or try the code, clone `ashlrai/lexicon` itself instead of a fork (opening a pull request needs the fork). `npm ci` installs the exact versions in `package-lock.json` and runs the `prepare` script, which is `npm run build` (tsc into `dist/`) followed by `npm run build:bundle` (the committed `plugin/` bundles, see below). The explicit `npm run build` after it is what you rerun after editing `src/`; `npm ci --ignore-scripts && npm run build` installs without rebuilding the bundles.

`npm run dev` rebuilds on change. `npm run typecheck` runs `tsc --noEmit` on the package, extension and demo site sources.

## Working in this repo with Lexicon installed

Many contributors dictate to their agents, so two committed files are worth knowing about before your own Lexicon install meets them.

- **`.lexicon.yaml`** at the root is this project's own lexicon. Like any project lexicon it is not applied until you trust it, so in this repo the CLI prints `lexicon: untrusted project lexicon skipped: <path> (run: lexicon trust)` and the Claude Code session note says the file was skipped. That is the [trust gate](docs/TRUST.md) working, not a bug. `lexicon trust --dry-run` shows the preview and pins nothing; `lexicon trust` asks before pinning (off a terminal it needs `--yes`). Trust pins the file's sha256, so after a `git pull` that changes it, it is skipped again until you re-run `lexicon trust`. An agent should show you the `trust_project` summary and ask rather than trust it on its own, and should not open the file itself.
- **Adding a name to it:** trust it first (a project write refuses on an untrusted file), then `lexicon add <Canonical> <aliases...> --project` (add `--dry-run` to preview), committed with the pull request that needs it. Hit counts go to `hits.json` beside your global lexicon, never into this file, so dictating while you work does not dirty the tree.
- **`.mcp.json`** registers the `lexicon` MCP server as `node plugin/mcp-server.mjs`, so opening the repo as a project in Claude Code (which asks you to approve project servers) runs the committed bundle from your checkout. After changing `src/`, `npm run build:bundle` is what makes that server reflect your change.

## The committed plugin bundles

`plugin/mcp-server.mjs` and `plugin/hook.mjs` are what the Claude Code plugin runs (`.claude-plugin/plugin.json`, `hooks/hooks.json`). They are esbuild bundles of `src/mcp/server.ts` and `src/hooks/plugin-entry.ts` (a small stub that enables Node's compile cache and imports `plugin/hook-main.mjs`, the bundle of `src/hooks/user-prompt-submit.ts`) with every dependency inlined, because `claude plugin install` clones the repo without `npm install` or a build. They are committed on purpose.

Run `npm run build:bundle` before committing any change that the MCP server or the hook can reach (almost everything under `src/core`, `src/mcp`, `src/hooks` and `src/cli`, since the MCP server imports the CLI handlers, or a dependency bump) and commit the regenerated files. `npm run check:bundle` rebuilds and fails on any diff under `plugin/`. The daily full CI suite on `main` runs the same check; the PR gate does not, so run it yourself. `dist/` (the tsc output for the npm package and library types) stays untracked.

To try the CLI from a checkout:

```bash
npm link
lexicon doctor
```

## Build commands

```bash
npm ci                  # lockfile install; runs prepare (build + build:bundle)
npm run build           # tsc -> dist/
npm run build:bundle    # esbuild -> plugin/mcp-server.mjs + plugin/hook.mjs + plugin/hook-main.mjs (commit these)
npm run check:bundle    # rebuild and fail if plugin/ differs from the checked-in files (the daily CI suite runs the same check)
npm run dev             # tsc --watch into dist/
npm run typecheck       # tsc --noEmit (package, extension and site)
npm run lint            # tsc --noEmit on the package only
npm run check:crypto    # flags classical-only asymmetric crypto not on the allowlist (part of CI Gate)
npm test                # a few node --test files, then unit + integration + e2e (vitest)
npm run test:watch      # vitest in watch mode
npm run test:e2e        # only tests/e2e.test.ts: the real CLI, hook and MCP server as subprocesses
npm run smoke           # the built CLI, the bundled hook and the MCP server, end to end (after build + build:bundle)
npm run mcp             # start the built MCP server on stdio (node dist/mcp/server.js)
npm run bench           # synthetic accuracy benchmark (see bench/README.md)
npm run bench:non-english  # the non-English corpus (docs/BENCH-NON-ENGLISH.md)
npm run bench:audio     # TTS-audio benchmark through whisper.cpp
npm run bench:compare   # the same audio against raw whisper, a --prompt hint list and exact substitution
npm run bench:hook      # wall-clock latency of plugin/hook.mjs against the 200ms budget
npm run docs:cli        # regenerate docs/CLI.md from every command's --help
npm run build:extension # extension/dist, extension/dist-firefox and the two zips
npm run build:site      # the demo site (site/dist), including install.sh
npm run dev:site        # build the demo site and serve it locally
npm run check:links     # every relative link in README.md and docs/ resolves
npm run check:facts     # every number the docs state (tool/command/format/pack/stoplist counts) matches the code
npm run fresh:sync      # regenerate the fresh:-marked doc blocks from package.json and CHANGELOG
npm run fresh:check     # fail on a stale fresh:-marked block
npm run check:server-json  # validate server.json (MCP Registry manifest) and its versions; uses the network
npm run resolve:conflicts  # settle CLAUDE.md, README.md and lockfile conflicts (see below)
```

Pull requests and merge-queue entries run the fast required `CI Gate`: typecheck, build, the crypto policy check, redaction tests and the two diff secret scans. The full portable suite runs daily and on `workflow_dispatch`, with Linux on Node 20, 22 and 24 plus Windows and macOS on Node 22. Those runs include bundle drift, tests, CLI/hook/MCP smoke checks and the extension build. Documentation checks reuse the Node 22 rows: links and CLI-reference drift on Linux and Windows, factual counts on Linux. There is no separate `docs` job. Run the checks locally before submitting; the fast gate does not run the full test suite.

`check:facts` derives the real numbers rather than trusting the prose: it asks the built MCP server for its tools, resources and prompts over stdio, parses `lexicon --help` for the command count, and reads `EXPORT_FORMATS`, `IMPORT_FORMATS`, `packs/*.yaml` and `STOPLIST`. It then scans the markdown, the landing page and the manifests for a contradicting claim. A line whose number it misreads can opt out with a trailing `check-facts:ignore` comment; `node scripts/check-facts.mjs --list` prints the ground truth.

Doc text that *is* a release fact -- a version badge, a pinned install command, the release table, a `#vX.Y.Z` example pin -- lives between `<!-- fresh:begin name -->` and `<!-- fresh:end -->` markers instead of being checked after the fact. `npm run fresh:sync` regenerates those blocks from `package.json` and the dated CHANGELOG sections, and `npm run fresh:check` (`node scripts/freshness/check.mjs --list` shows the block names) exits 1 on drift. Wrap a versioned snippet in markers rather than writing the number bare.

Manual stdio check of the MCP server: `node dist/mcp/server.js`. Interactive check: `npx @modelcontextprotocol/inspector node dist/mcp/server.js`.

## Repo layout

```text
src/util/        the bottom layer, dependency-free and imported directly: errors, json, jsonc, which, atomic, package, xdg and a few more
src/core/        the library: types, caps (limits and format lists), schema, store, trust, matcher (+ matcher/), stoplist, normalize, suggest, suggestTerms, harvest, learn, pending, stats, notes, packs, registry (community packs), import-sources and import-preview (the guided vocabulary import), edit-check, demo, shell, redact, exporters/, importers/; index.ts is the public API
src/cli/         the `lexicon` command (index.ts answers version flags and tries the daemon fast read, run.ts dispatches, program.ts wires commander, handlers in commands.ts and cmd-*.ts, prompt.ts for interactive input, the setup wizard in setup/)
src/mcp/         the stdio MCP server (`lexicon-mcp`); tools registered through tools/index.ts, handlers grouped in tools/*.ts
src/hooks/       the Claude Code SessionStart and UserPromptSubmit hook
src/daemon/      the clipboard watcher and its per-platform backends, the opt-in resident expander (`lexicon daemon --expander`) and the CLI's fast-read client for it
src/serve/       the local HTTP API (`lexicon serve`)
src/voice/       ffmpeg + whisper.cpp push-to-talk (`lexicon voice`)
src/ambiguity/   the ambiguity engine ported from Pellucid; self-contained, nothing else in src/ imports it yet
plugin/          committed esbuild bundles of the MCP server and hook that the plugin runs
packs/           the starter term packs (developer, ai, business, voice-tools, cloud-devops, profession-q8, legal, ashlr, architecture)
registry/        an example community pack registry (index.example.yaml and packs/)
extension/       the browser extension (Manifest V3; built into extension/dist and dist-firefox)
web/             the Next.js marketing site for lexicon.ashlr.ai (web/lib/generated holds a browser bundle of src/core)
apps/macos/      LexiconBar, the SwiftPM menu bar app
apps/windows/    LexiconBar for Windows, the tray app (see docs/WINDOWS-APP.md for what is verified)
packaging/       the Homebrew formula
site/            the demo site published to GitHub Pages, plus install.sh
tests/           vitest; one file per module, e2e.test.ts for whole-journey subprocess tests, fixtures/fake-repo for harvest (vitest also picks up src/**/*.test.ts and bench/**/*.test.ts)
test/            node --test files that `npm test` runs before vitest
bench/           accuracy benchmark corpora and runners (synthetic and audio)
examples/        example lexicon, client configs, library and STT pipeline examples
scripts/         builders (build-bundle, build-extension, build-macos-app, build-site, gen-cli-docs), checks (check-bundle, check-facts, check-links, check-crypto, check-server-json, freshness/), release-contract, smoke and install.sh
docs/            architecture, research, benchmark, quickstart, the module contract, per-feature guides and the generated CLI reference
skills/ commands/ hooks/ .claude-plugin/ .mcp.json   what makes the repo a Claude Code plugin
```

Module layout and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the per-module API is in [docs/CONTRACT.md](docs/CONTRACT.md). Releases are described in [docs/RELEASING.md](docs/RELEASING.md).

## Tests

For a quick local check, run `lexicon test-select` from the repository root. It
prints commands for the current staged, unstaged, and untracked changes. Pass
repository-relative paths to select for a specific change, or add `--json` for
structured command argument arrays. Run the commands from the repository root.
A changed `tests/` or `bench/` test file selects itself. Beyond that, only paths
whose coverage has been reviewed are mapped (the `mappings` table in
`src/cli/cmd-test-select.ts`: today the command's own source and
`scripts/check-links.mjs`). Every other path is unknown, and one unknown path
selects `npm test` for the whole change: that covers every other source file
under `src/`, the colocated `src/**/*.test.ts` files, docs (several tests pin
doc text), packs, scripts and config. Deleted tests and an empty change list
select `npm test` too. So the command narrows a change that only touches tests;
for a source change, run the module's own test file while you work (the
per-module files are listed below), then the full suite before claiming the
change works. A new mapping belongs in that table only after its coverage has
been reviewed, with a case in `tests/test-select.test.ts`.

Vitest. Tests live under `tests/`: one file per core module, plus a few hundred focused files named after the behaviour or regression they pin. Vitest also picks up the few `src/**/*.test.ts` files colocated with their module and `bench/**/*.test.ts`. The wall-clock files listed in `PERF_FILES` in `vitest.config.ts` run in their own `perf` project, one worker, after the rest finishes. The per-module files:

```text
tests/
  schema.test.ts      normalize.test.ts   harvest.test.ts     mcp.test.ts       trust.test.ts
  store.test.ts       suggest.test.ts     exporters.test.ts   hook.test.ts      learn.test.ts
  matcher.test.ts     cli.test.ts         importers.test.ts   install.test.ts   stats.test.ts
  daemon.test.ts      review.test.ts      serve.test.ts       voice.test.ts     setup.test.ts
  suggest-terms.test.ts                   extension.test.ts (jsdom; skipped on Node 20)
  e2e.test.ts (real CLI/hook/MCP as subprocesses)
  fixtures/fake-repo/ a small repo (package.json, README.md, src/, scripts/, node_modules/) for harvest tests
bench/bench.test.ts   accuracy regression guard over the benchmark corpus (npx vitest run bench; also non-english.test.ts, run.test.ts)
```

`npm test` runs them once; `npm run test:watch` watches. `npm run bench` prints the accuracy report as markdown and writes `bench/results.json`; `docs/BENCHMARK.md` is updated by hand from that report. See `bench/README.md`.

Matcher and normalize tests use inline fixtures. Store, trust, CLI and hook tests use a temp directory and `LEXICON_PATH` so they never touch a real config. The daemon test injects read/write functions instead of touching the clipboard. Interactive commands (`harvest --add`, `add -i`, `review`, `edit`, `setup`, `suggest --apply`) take a `Prompter` or an editor spawner as a parameter, so the tests script the answers. The voice, serve and setup tests inject `exec`, `spawn` and filesystem probes through their `*Deps` parameters and never touch a microphone, a port on a real config or the machine's client configs.

### End-to-end journeys

`tests/e2e.test.ts` is the only suite that does not mock anything: it spawns the real CLI (`node --import tsx src/cli/index.ts`), the hook and the MCP server as subprocesses against a throwaway HOME under `os.tmpdir()` (`HOME`, `XDG_CONFIG_HOME` and `LEXICON_PATH` all point there) and a temp git repo passed with `--cwd`. It covers the user journey end to end: init, add, list, normalize (args, stdin, `--json`, `--diff`, `--dry-run`, `--min-confidence`), learn, import, every export format, harvest, the trust flow, stats, path, doctor, install, the hook's `additionalContext`, and a JSON-RPC handshake with the MCP server over stdio. The daemon is skipped so the suite runs on CI without a clipboard. With `LEXICON_E2E_DIST=1` (CI sets it after `npm run build`) it spawns the built `dist/` entry points under plain node instead of the sources under tsx: the same code in about half the time, so run `npm run build` first if you set it locally.

```bash
npm run test:e2e          # about 20s
LEXICON_SKIP_E2E=1 npm test   # everything but the journeys
```

To add a journey test:

1. Pick the `describe` block for the area (or add one) and use `runCli(args, { env, stdin?, cwd? })`, which returns `{ code, stdout, stderr }`. Pass `cwd` when the command should see a project `.lexicon.yaml`; it is turned into `--cwd`.
2. Read-only checks can use the `shared` home (seeded once with `Ashlr.AI` and `Mason Wyatt`). Anything that writes gets its own home from `freshHome(label)` or, to start from the seeded terms, `cloneOf(shared, label)`. Homes are deleted in `afterAll`.
3. Assert on exit code, stdout and stderr separately. Warnings and `--diff` output belong on stderr; stdout is the data channel (and for `lexicon mcp`, the protocol channel).
4. Keep it fast: each spawn costs about 200ms. Reuse the shared home where you can and keep the whole file under a minute.
5. For a new command, also run `npm run docs:cli` so `docs/CLI.md` picks up its `--help`.

## Conventions

- ESM. Relative imports end in `.js` even though the source is `.ts` (NodeNext resolution).
- No default exports.
- No `any` in public signatures. Prefer `unknown` plus a zod parse.
- Every module codes against `src/core/types.ts`. Import siblings only via `../core/index.js`.
- `src/core/matcher.ts` stays pure: no filesystem, no environment, no logging.
- Log to stderr only in the MCP server and hook. Stdout is the protocol channel.
- The hook must always exit 0 and finish under 200ms for a 1KB prompt.
- No em-dashes in docs or user-facing strings.

## Adding a starter pack

A pack for a profession the shipped packs do not cover is a useful thing a newcomer can add. The full recipe, including the one rule that decides the hard cases (never make an ordinary English word an alias on its own), is in [docs/PACKS.md](docs/PACKS.md#adding-a-pack-to-this-repo).

## Adding an exporter

1. Create `src/core/exporters/<format>.ts` exporting one function:

   ```ts
   import type { ExportOptions, Lexicon } from '../types.js';

   export function exportMyFormat(lexicon: Lexicon, opts: ExportOptions = {}): string {
     // respect opts.categories and opts.limit
   }
   ```

2. Add the format name to the `EXPORT_FORMATS` array in `src/core/types.ts`; the `ExportFormat` type is derived from it.
3. Register it in `src/core/exporters/index.ts`: add a `description` and `ext` entry to `EXPORT_FORMAT_INFO` and add it to the `EXPORTERS` map that `exportLexicon()` dispatches through (the build fails until both have it). Use `sortByImportance()` from `shared.ts` so term order matches the other exporters.
4. Add a test in `tests/exporters.test.ts` with a small lexicon and an exact expected string. Cover `categories` and `limit`.
5. The MCP `export_lexicon` tool accepts every name in `EXPORT_FORMATS` on its own (`src/mcp/tools/terms.ts`); add the format to the list in that tool's description by hand.
6. Add a row to the export table in `docs/EXPORTS.md`, the format lists in `commands/lexicon.md` and `skills/lexicon/SKILL.md`, the exporters line in `docs/CONTRACT.md` and `EXPORT_CONTENT_TYPES` in `src/serve/server.ts` if the extension is new. Update the format count wherever it is stated ("sixteen"), including `README.md`.

The CLI (`lexicon export` with no format) picks up new formats from `EXPORT_FORMATS` automatically.

## Adding an importer

1. Create `src/core/importers/<format>.ts` exporting `parse<Format>Import(content: string): RawImport` (`rows` plus `skipped` with a 1-based line and a reason) and, when the format can be sniffed, a `looksLike<Format>(content)` predicate. Use `rowFor()` from `shared.ts` and `parseCsv()` from `csv-parse.ts` where they fit. Parsers must be linear-time; the CLI already caps input at 8 MB.
2. Add the name to `IMPORT_FORMATS` in `src/core/caps.ts` and to the `ImportFormat` union in `src/core/importers/index.ts`. In that same file, describe it in `IMPORT_FORMAT_INFO`, register the parser in `PARSERS`, and add a detection step to `detectImportFormat()` (unambiguous structured markers first, extensions last).
3. Add a test in `tests/importers.test.ts` with an exact fixture, including a malformed row that lands in `skipped`. If the format has an exporter, add a round-trip case.
4. Add a row to the import table in `docs/EXPORTS.md`, update the count in `README.md`, and add the format to the `lexicon import` description in `src/cli/program.ts` (the format argument and `--help` list come from `IMPORT_FORMATS`), then run `npm run docs:cli`. Update the format count wherever it is stated ("eight"); `npm run check:facts` will tell you every place you missed.

## Adding a harvester source

`src/core/harvest.ts` collects `HarvestCandidate[]` from several sources and merges them by canonical. The scan lives in `harvestReport()`; `harvestRepo()` returns its candidates.

1. Add a function next to the existing ones, in one of two shapes. Manifest readers (`harvestPackageJson`, `harvestPyproject`, `harvestCargo`, `harvestGoMod`) take `(file, rel, bump)` and record candidates through the shared `bump` callback with `canonical`, `category`, `source`, `evidence` and a count. Text scanners (`pascalCaseIdentifiers`, `readmeProperNouns`, `countDotTldBrands`) take the file text and return a `Map` of name to count, which the file loop passes to `bump`. Git authors (`gitAuthors(root)`) and the directory name are recorded before the loop.
2. Add a value to `TERM_SOURCES` in `src/core/types.ts` if none fits (harvest uses `harvest:repo`, `harvest:git` and `harvest:package`).
3. Add an opt-out flag to `HarvestOptions` if the source is slow or noisy, defaulting to on (like `git`, `packages` and `identifiers`).
4. Call it from the file loop in `harvestReport()`. Files come from `gitFiles()` (git's file list, so `.gitignore` applies) or, outside a git work tree, `walk()`. Both skip the always-ignored directories (`node_modules`, `dist`, `build`, `.git`, `vendor`, `target`, `.next`, `coverage`, `__pycache__`, `.venv`, `venv`, plus `HarvestOptions.ignore`), keep only `READ_EXTENSIONS` (add the extension there if the source reads a new file type) and stop at `HARVEST_MAX_FILES` (5000). `readText()` skips files over 512KB.
5. Filter through `HARVEST_STOPLIST` (and `isGenericIdentifier()` for code identifiers) before recording. Pass `external = false` to `bump` for a name seen only in code, so it stays behind `HarvestOptions.symbols`. Suggested aliases are added to every candidate by `harvestAliases()` at the end; do not add them in the source function.
6. Extend `tests/fixtures/fake-repo/` and add a case to `tests/harvest.test.ts`.

## Pull requests

Keep them small. One exporter, one importer, one harvester, one matcher change per PR. Include the test. Add a bullet to `CHANGELOG.md` under the `Unreleased` heading at the top, in the matching subsection (Added, Changed, Fixed, Security or Internal). The commands to run before pushing, and the rule-driven extras (plugin bundle, `docs:cli`, `check:facts`, `check:links`, `fresh:check`), are listed once, in step 4 of [Contribute with an agent](#contribute-with-an-agent); the pull request template's checklist mirrors them.

### Resolving conflicts on the usual suspects

`CHANGELOG.md` is union-merged through `.gitattributes`, so lane-side merges and rebases keep both sides' entries and never stop on that file. (GitHub's server-side merge ignores attributes, so the web UI may still flag it.) When `CLAUDE.md`, `README.md` or a lockfile conflicts, run the helper instead of resolving by hand:

```bash
node scripts/resolve-merge-conflicts.mjs   # or: npm run resolve:conflicts
```

`CLAUDE.md` and `README.md` resolve to main's version with the PR's own hunks re-applied where they still fit. `package-lock.json`, `bun.lock` and `Cargo.lock` are regenerated by their package manager against the resolved manifest, never merged by hand, and every `resolved`/source URL must stay on the official registry (registry.npmjs.org or crates.io). Anything the script cannot settle stays conflicted and is listed on stderr.

### Full-suite and desktop CI

The portable matrix in `.github/workflows/ci.yml` runs on the daily schedule and manual dispatch, including its macOS row. To request it on a branch, dispatch it explicitly:

```bash
gh workflow run ci.yml -R ashlrai/lexicon --ref <branch>
```

The `ci:macos`, `ci:windows` and `ci:full` labels do not start or expand the current fast PR gate. Re-running a PR run repeats that gate; it does not start the portable matrix.

The separate `macos-app.yml` and `windows-app.yml` workflows build and test their desktop app after a relevant push to `main`, daily, and on manual dispatch. They do not run on PRs or merge-queue entries. Each uploads a workflow artifact; release assets are built by `release.yml`. Headless CI does not exercise a real Accessibility or UI Automation editing session. See [platform coverage](docs/PLATFORMS.md).
