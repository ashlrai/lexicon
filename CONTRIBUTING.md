# Contributing

## Setup

```bash
git clone <repo>
cd lexicon
npm install
npm run build
npm test
```

Node 20 or newer. `npm run dev` rebuilds on change. `npm run typecheck` runs `tsc --noEmit`.

To try the CLI from a checkout:

```bash
npm link
lexicon doctor
```

## Tests

Vitest. Tests live under `tests/`, one file per module:

```text
tests/
  schema.test.ts      normalize.test.ts   harvest.test.ts    mcp.test.ts
  store.test.ts       suggest.test.ts     exporters.test.ts  hook.test.ts
  matcher.test.ts     cli.test.ts         daemon.test.ts
  fixtures/fake-repo/ a small repo (package.json, README.md, src/, scripts/, node_modules/) for harvest tests
```

`npm test` runs them once; `npm run test:watch` watches.

Matcher and normalize tests use inline fixtures. Store, CLI and hook tests use a temp directory and `LEXICON_PATH` so they never touch a real config. The daemon test injects read/write functions instead of touching the clipboard.

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
5. Add a row to the export table in `README.md` and to the format list in `commands/lexicon.md` and `skills/lexicon/SKILL.md`.

The CLI (`lexicon export` with no format), the MCP `export_lexicon` tool and its `format` enum pick up new formats from `EXPORT_FORMATS` automatically.

## Adding a harvester source

`src/core/harvest.ts` collects `HarvestCandidate[]` from several sources and merges them by canonical.

1. Add a function next to the existing ones (`harvestPackageJson`, `harvestPyproject`, `harvestCargo`, `harvestGoMod`, `pascalCaseIdentifiers`, `readmeProperNouns`, `gitAuthors`). It receives the file text or repo root and records candidates through the shared `bump` callback with `canonical`, `category`, `source`, `evidence` and a count.
2. Add a `TermSource` value in `src/core/types.ts` if none fits (`harvest:repo`, `harvest:git`, `harvest:package` exist).
3. Add an opt-out flag to `HarvestOptions` if the source is slow or noisy, defaulting to on.
4. Call it from `harvestRepo()`. Files come from `walk()`, which already applies the ignore list (`node_modules`, `dist`, `.git`, `vendor`, `build`, plus `HarvestOptions.ignore`), the 512KB file cap and the 5000 file cap.
5. Filter through `HARVEST_STOPLIST` and `isGenericIdentifier()` before returning. Suggested aliases come from `safeSuggest()`.
6. Extend `tests/fixtures/fake-repo/` and add a case to `tests/harvest.test.ts`.

## Pull requests

Keep them small. One exporter, one harvester, one matcher change per PR. Include the test. Update `CHANGELOG.md` under an Unreleased heading.
