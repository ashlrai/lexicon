# Contributing

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
6. Add a row to the export table in `README.md`, the format lists in `commands/lexicon.md` and `skills/lexicon/SKILL.md`, the exporters line in `CONTRACT.md` and `EXPORT_CONTENT_TYPES` in `src/serve/server.ts` if the extension is new. Update the format count wherever it is stated ("fifteen").

The CLI (`lexicon export` with no format) picks up new formats from `EXPORT_FORMATS` automatically.

## Adding an importer

1. Create `src/core/importers/<format>.ts` exporting `parse<Format>Import(content: string): RawImport` (`rows` plus `skipped` with a 1-based line and a reason) and, when the format can be sniffed, a `looksLike<Format>(content)` predicate. Use `rowFor()` from `shared.ts` and `parseCsv()` from `csv-parse.ts` where they fit. Parsers must be linear-time; the CLI already caps input at 8 MB.
2. Add the name to `ImportFormat` and `IMPORT_FORMATS` in `src/core/importers/index.ts`, describe it in `IMPORT_FORMAT_INFO`, register the parser in `PARSERS`, and add a detection step to `detectImportFormat()` (unambiguous structured markers first, extensions last).
3. Add a test in `tests/importers.test.ts` with an exact fixture, including a malformed row that lands in `skipped`. If the format has an exporter, add a round-trip case.
4. Add a row to the import table in `README.md` and update the `lexicon import` help text in `src/cli/cmd-import.ts` and `src/cli/index.ts`, then run `npm run docs:cli`. Update the format count wherever it is stated ("seven").

## Adding a harvester source

`src/core/harvest.ts` collects `HarvestCandidate[]` from several sources and merges them by canonical.

1. Add a function next to the existing ones (`harvestPackageJson`, `harvestPyproject`, `harvestCargo`, `harvestGoMod`, `pascalCaseIdentifiers`, `readmeProperNouns`, `gitAuthors`). It receives the file text or repo root and records candidates through the shared `bump` callback with `canonical`, `category`, `source`, `evidence` and a count.
2. Add a `TermSource` value in `src/core/types.ts` if none fits (`harvest:repo`, `harvest:git`, `harvest:package` exist).
3. Add an opt-out flag to `HarvestOptions` if the source is slow or noisy, defaulting to on.
4. Call it from `harvestRepo()`. Files come from `walk()`, which already applies the ignore list (`node_modules`, `dist`, `.git`, `vendor`, `build`, plus `HarvestOptions.ignore`), the 512KB file cap and the 5000 file cap.
5. Filter through `HARVEST_STOPLIST` and `isGenericIdentifier()` before returning. Suggested aliases come from `safeSuggest()`.
6. Extend `tests/fixtures/fake-repo/` and add a case to `tests/harvest.test.ts`.

## Pull requests

Keep them small. One exporter, one importer, one harvester, one matcher change per PR. Include the test. Add a bullet to `CHANGELOG.md` under the `(unreleased)` heading at the top (Added, Changed, Security or Internal). Rebuild the plugin bundles (`npm run build:bundle`) when the change is reachable from the MCP server or the hook, and commit them. Run `npm run docs:cli` after touching a command or flag.
