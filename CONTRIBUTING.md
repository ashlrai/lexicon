# Contributing

Small, well-scoped pull requests are the easiest kind to merge here. A new starter pack, one exporter, one importer, one harvester source, one matcher guard.

## Good first issues

If you want a concrete place to start, the [`good first issue`](https://github.com/ashlrai/lexicon/labels/good%20first%20issue) label is kept stocked with work that is genuinely self-contained: each issue names the files to touch and how to check the result. The recipes below cover the four most common shapes.

The lowest-effort contribution of all needs no code: if speech-to-text mangles a public name and the lexicon does not catch it, open a [misheard term issue](https://github.com/ashlrai/lexicon/issues/new?template=misheard_term.yml) with the canonical spelling and what your STT engine actually wrote. Real transcripts are worth more than guesses, and they feed both the starter packs and the benchmark corpus.

Good shapes for a first PR:

| Shape | Recipe | Roughly |
|---|---|---|
| A term pack for a profession the packs do not cover (law, medicine, finance, design) | [docs/PACKS.md](docs/PACKS.md#adding-a-pack) | One YAML file plus one test |
| An export format for another dictation app or STT engine | [Adding an exporter](#adding-an-exporter) | Three files plus a test |
| An import format for a dictionary the tool cannot read yet | [Adding an importer](#adding-an-importer) | Three files plus a test |
| A harvester source (a new manifest type, a new identifier convention) | [Adding a harvester source](#adding-a-harvester-source) | One function plus a fixture |
| A term the matcher gets wrong | A failing case in `tests/normalize.test.ts`, then the guard in `src/core/matcher.ts` | One test plus one guard |

Before you start: say so on the issue so two people do not write the same exporter. If nothing on the list fits, open an issue describing the correction that went wrong, with the output of `lexicon normalize --diff "<what STT wrote>"`.

## Setup

```bash
git clone https://github.com/ashlrai/lexicon
cd lexicon
npm install
npm run build
npm test
```

Node 20 or newer. `npm run dev` rebuilds on change. `npm run typecheck` runs `tsc --noEmit`.

## The committed plugin bundles

`plugin/mcp-server.mjs` and `plugin/hook.mjs` are what the Claude Code plugin runs (`.mcp.json`, `hooks/hooks.json`). They are single-file esbuild bundles of `src/mcp/server.ts` and `src/hooks/user-prompt-submit.ts` with every dependency inlined, because `claude plugin install` clones the repo without `npm install` or a build. They are committed on purpose.

Run `npm run build:bundle` before committing any change that the MCP server or the hook can reach (almost everything under `src/core`, `src/mcp`, `src/hooks`, or a dependency bump) and commit the regenerated files. CI runs `npm run check:bundle`, which rebuilds and fails on any diff under `plugin/`. `dist/` (the tsc output for the npm package and library types) stays untracked.

To try the CLI from a checkout:

```bash
npm link
lexicon doctor
```

## Build commands

```bash
npm install
npm run build           # tsc -> dist/
npm run build:bundle    # esbuild -> plugin/mcp-server.mjs + plugin/hook.mjs (commit these)
npm run check:bundle    # rebuild and fail if plugin/ differs from the checked-in files (CI runs this)
npm run typecheck       # tsc --noEmit
npm test                # unit + integration + e2e (vitest)
npm run test:e2e        # only tests/e2e.test.ts: the real CLI, hook and MCP server as subprocesses
npm run bench           # synthetic accuracy benchmark (see bench/README.md)
npm run bench:audio     # real-audio benchmark through whisper.cpp
npm run docs:cli        # regenerate docs/CLI.md from every command's --help
npm run build:extension # extension/dist, extension/dist-firefox and the two zips
npm run build:site      # the demo site (site/dist), including install.sh
npm run check:links     # every relative link in README.md and docs/ resolves
npm run check:facts     # every number the docs state (tool/command/format/pack/stoplist counts) matches the code
```

CI runs `npm run typecheck`, `npm run build`, `npm run check:bundle`, `npm test`, a CLI/hook/MCP smoke test and `npm run build:extension` on Node 20, 22 and 24. A separate `docs` job runs `npm run check:links`, `npm run check:facts` and a `docs/CLI.md` drift check once.

`check:facts` derives the real numbers rather than trusting the prose: it asks the built MCP server for its tools, resources and prompts over stdio, parses `lexicon --help` for the command count, and reads `EXPORT_FORMATS`, `IMPORT_FORMATS`, `packs/*.yaml` and `STOPLIST`. It then scans the markdown, the landing page and the manifests for a contradicting claim. A line whose number it misreads can opt out with a trailing `check-facts:ignore` comment; `node scripts/check-facts.mjs --list` prints the ground truth.

Manual stdio check of the MCP server: `node dist/mcp/server.js`. Interactive check: `npx @modelcontextprotocol/inspector node dist/mcp/server.js`.

## Repo layout

```text
src/util/        the bottom layer, imported directly by every other one: errors, json, which, atomic, package, xdg
src/core/        the library: types, schema, store, trust, matcher (+ matcher/), stoplist, normalize, suggest, suggestTerms, harvest, learn, stats, packs, demo, exporters/, importers/
src/cli/         the `lexicon` command (commander wiring in index.ts, handlers in commands.ts and cmd-*.ts, prompt.ts for interactive input, the setup wizard in setup/)
src/mcp/         the stdio MCP server (`lexicon-mcp`)
src/hooks/       the Claude Code SessionStart and UserPromptSubmit hook
src/daemon/      the clipboard watcher and its per-platform backends
src/serve/       the local HTTP API (`lexicon serve`)
src/voice/       ffmpeg + whisper.cpp push-to-talk (`lexicon voice`)
plugin/          committed esbuild bundles of the MCP server and hook that the plugin runs
packs/           the starter term packs (developer, ai, business, voice-tools)
extension/       the browser extension (Manifest V3; built into extension/dist and dist-firefox)
web/             the Next.js marketing site for lexicon.ashlr.ai (web/lib/generated holds a browser bundle of src/core)
apps/macos/      LexiconBar, the SwiftPM menu bar app
packaging/       the Homebrew formula
site/            the demo site published to GitHub Pages, plus install.sh
tests/           vitest; one file per module, e2e.test.ts for whole-journey subprocess tests, fixtures/fake-repo for harvest
bench/           accuracy benchmark corpora and runners (synthetic and audio)
examples/        example lexicon, client configs, library and STT pipeline examples
scripts/         build-bundle, build-extension, build-macos-app, build-site, check-links, gen-cli-docs, install.sh
docs/            architecture, research, benchmark, quickstart, the module contract, per-feature guides and the generated CLI reference
skills/ commands/ hooks/ .claude-plugin/ .mcp.json   what makes the repo a Claude Code plugin
```

Module layout and design decisions are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the per-module API is in [docs/CONTRACT.md](docs/CONTRACT.md). Releases are described in [docs/RELEASING.md](docs/RELEASING.md).

## Tests

Vitest. Tests live under `tests/`, one file per module:

```text
tests/
  schema.test.ts      normalize.test.ts   harvest.test.ts     mcp.test.ts       trust.test.ts
  store.test.ts       suggest.test.ts     exporters.test.ts   hook.test.ts      learn.test.ts
  matcher.test.ts     cli.test.ts         importers.test.ts   install.test.ts   stats.test.ts
  daemon.test.ts      review.test.ts      serve.test.ts       voice.test.ts     setup.test.ts
  suggest-terms.test.ts                   extension.test.ts (jsdom; skipped on Node 20)
  e2e.test.ts (real CLI/hook/MCP as subprocesses)
  fixtures/fake-repo/ a small repo (package.json, README.md, src/, scripts/, node_modules/) for harvest tests
bench/bench.test.ts   accuracy regression guard over the benchmark corpus (npx vitest run bench)
```

`npm test` runs them once; `npm run test:watch` watches. `npm run bench` prints the accuracy report as markdown and writes `bench/results.json`; `docs/BENCHMARK.md` is updated by hand from that report. See `bench/README.md`.

Matcher and normalize tests use inline fixtures. Store, trust, CLI and hook tests use a temp directory and `LEXICON_PATH` so they never touch a real config. The daemon test injects read/write functions instead of touching the clipboard. Interactive commands (`harvest --add`, `add -i`, `review`, `edit`, `setup`, `suggest --apply`) take a `Prompter` or an editor spawner as a parameter, so the tests script the answers. The voice, serve and setup tests inject `exec`, `spawn` and filesystem probes through their `*Deps` parameters and never touch a microphone, a port on a real config or the machine's client configs.

### End-to-end journeys

`tests/e2e.test.ts` is the only suite that does not mock anything: it spawns the real CLI (`node --import tsx src/cli/index.ts`), the hook and the MCP server as subprocesses against a throwaway HOME under `os.tmpdir()` (`HOME`, `XDG_CONFIG_HOME` and `LEXICON_PATH` all point there) and a temp git repo passed with `--cwd`. It covers the user journey end to end: init, add, list, normalize (args, stdin, `--json`, `--diff`, `--dry-run`, `--min-confidence`), learn, import, every export format, harvest, the trust flow, stats, path, doctor, install, the hook's `additionalContext`, and a JSON-RPC handshake with the MCP server over stdio. The daemon is skipped so the suite runs on CI without a clipboard.

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

A pack for a profession the four shipped packs do not cover is the most useful thing a newcomer can add. The full recipe, including the one rule that decides the hard cases (never make an ordinary English word an alias on its own), is in [docs/PACKS.md](docs/PACKS.md#adding-a-pack).

## Adding an exporter

1. Create `src/core/exporters/<format>.ts` exporting one function:

   ```ts
   import type { ExportOptions, Lexicon } from '../types.js';

   export function exportMyFormat(lexicon: Lexicon, opts: ExportOptions = {}): string {
     // respect opts.categories and opts.limit
   }
   ```

2. Add the format name to the `ExportFormat` union in `src/core/types.ts`.
3. Register it in `src/core/exporters/index.ts`: add it to `EXPORT_FORMATS`, add a `description` and `ext` entry to `EXPORT_FORMAT_INFO`, and add it to the `EXPORTERS` map that `exportLexicon()` dispatches through. Use `sortByImportance()` from `shared.ts` so term order matches the other exporters.
4. Add a test in `tests/exporters.test.ts` with a small lexicon and an exact expected string. Cover `categories` and `limit`.
5. Add the format to `EXPORT_FORMAT_VALUES` in `src/mcp/server.ts` (the build fails until you do) and to the `export_lexicon` description.
6. Add a row to the export table in `docs/EXPORTS.md`, the format lists in `commands/lexicon.md` and `skills/lexicon/SKILL.md`, the exporters line in `docs/CONTRACT.md` and `EXPORT_CONTENT_TYPES` in `src/serve/server.ts` if the extension is new. Update the format count wherever it is stated ("fifteen"), including `README.md`.

The CLI (`lexicon export` with no format) picks up new formats from `EXPORT_FORMATS` automatically.

## Adding an importer

1. Create `src/core/importers/<format>.ts` exporting `parse<Format>Import(content: string): RawImport` (`rows` plus `skipped` with a 1-based line and a reason) and, when the format can be sniffed, a `looksLike<Format>(content)` predicate. Use `rowFor()` from `shared.ts` and `parseCsv()` from `csv-parse.ts` where they fit. Parsers must be linear-time; the CLI already caps input at 8 MB.
2. Add the name to `ImportFormat` and `IMPORT_FORMATS` in `src/core/importers/index.ts`, describe it in `IMPORT_FORMAT_INFO`, register the parser in `PARSERS`, and add a detection step to `detectImportFormat()` (unambiguous structured markers first, extensions last).
3. Add a test in `tests/importers.test.ts` with an exact fixture, including a malformed row that lands in `skipped`. If the format has an exporter, add a round-trip case.
4. Add a row to the import table in `docs/EXPORTS.md`, update the count in `README.md`, and update the `lexicon import` help text in `src/cli/cmd-import.ts` and `src/cli/index.ts`, then run `npm run docs:cli`. Update the format count wherever it is stated ("seven"); `npm run check:facts` will tell you every place you missed.

## Adding a harvester source

`src/core/harvest.ts` collects `HarvestCandidate[]` from several sources and merges them by canonical.

1. Add a function next to the existing ones (`harvestPackageJson`, `harvestPyproject`, `harvestCargo`, `harvestGoMod`, `pascalCaseIdentifiers`, `readmeProperNouns`, `gitAuthors`). It receives the file text or repo root and records candidates through the shared `bump` callback with `canonical`, `category`, `source`, `evidence` and a count.
2. Add a `TermSource` value in `src/core/types.ts` if none fits (`harvest:repo`, `harvest:git`, `harvest:package` exist).
3. Add an opt-out flag to `HarvestOptions` if the source is slow or noisy, defaulting to on.
4. Call it from `harvestRepo()`. Files come from `walk()`, which already applies the ignore list (`node_modules`, `dist`, `.git`, `vendor`, `build`, plus `HarvestOptions.ignore`), the 512KB file cap and the 5000 file cap.
5. Filter through `HARVEST_STOPLIST` and `isGenericIdentifier()` before returning. Suggested aliases come from `safeSuggest()`.
6. Extend `tests/fixtures/fake-repo/` and add a case to `tests/harvest.test.ts`.

## Pull requests

Keep them small. One exporter, one importer, one harvester, one matcher change per PR. Include the test. Add a bullet to `CHANGELOG.md` under the `(unreleased)` heading at the top (Added, Changed, Security or Internal). Rebuild the plugin bundles (`npm run build:bundle`) when the change is reachable from the MCP server or the hook, and commit them. Run `npm run docs:cli` after touching a command or flag, and `npm run check:links` after moving or renaming a doc.
