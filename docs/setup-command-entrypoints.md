# Setup command entrypoints

This is a map for maintainers tracing guided onboarding. The detailed behavior and types are in [CONTRACT.md](CONTRACT.md); [CLI.md](CLI.md) is the generated user-facing flag reference. The source paths below are relative to the repository root.

## CLI registration and dispatch

1. The `lexicon` package bin points to `dist/cli/index.js`, built from `src/cli/index.ts`. Except for its early version and fast-read paths, it loads `src/cli/run.ts`.
2. `run.ts` calls `buildProgram(io)` in `src/cli/program.ts`, installs the global `--cwd` validation hook, and parses argv with Commander. `buildProgram` calls `registerSetupCommands(program, io)`.
3. `registerSetupCommands`, defined in `src/cli/program.ts` and re-exported by `src/cli/cmd-setup.ts`, registers `setup`, its options and an action. Registration does not execute setup. The action dynamically imports `runSetupCli` only when invoked.
4. `runSetupCli` in `src/cli/cmd-setup.ts` forwards the global `cwd` and options to `runSetup`, converts thrown errors into a JSON error when requested, and sets the process exit code on failure. The general CLI dispatcher handles other thrown errors.

The registered setup options are:

```text
--yes --clients --company --person --phonetic --app --export-dir
--harvest --packs --no-packs --no-harvest --serve --no-serve
--dry-run --reseed --home --json
```

`-y` is the short form of `--yes`; `--cwd` belongs to the parent command. See the generated reference for option arguments and defaults.

## Shared execution

`runSetup(opts, io, deps?)` in `src/cli/cmd-setup.ts` is the testable execution entrypoint for both surfaces. It validates options before any step, chooses whether to prompt, creates the context, and runs the following functions in order from `src/cli/setup/steps.ts`:

| Step | Function | Role |
|---|---|---|
| Global lexicon | `stepLexicon` | Initialize the global file if needed and seed names. |
| Starter packs | `stepPacks` | Select and install packs. |
| Repo harvest | `stepHarvest` | Find repo names and optionally add them to the project lexicon. |
| Agent clients | `stepClients` | Detect and install into selected clients. |
| Local API | `stepServe` | Optionally install the login service. |
| Dictation app | `stepExport` | Optionally export terms for an app. |
| Does it work? | `stepDemo` | Demonstrate a correction. |

The steps reuse existing initialization, installation, harvest and export functions. `src/cli/setup/types.ts` defines options, results and injectable dependencies; `src/cli/setup/detect.ts` handles validation and detection. `cmd-setup.ts` is the facade that re-exports the documented setup types and helpers.

`dryRun` suppresses writes and prompts and returns a `SetupPlan`; otherwise the handler returns a `SetupSummary`. Both return a code, and JSON mode prints the corresponding result. A client or service failure returns code 1 after the other steps run. A closed prompt or thrown step stops later steps and reports what was already done; a thrown step during a dry run propagates. `SetupDeps` allows tests to replace machine-dependent probes and installers.

## MCP registration and dispatch

`createServer` in `src/mcp/server.ts` walks `TOOL_REGISTRARS` from `src/mcp/tools/index.ts`. That list includes `registerSetupTools` in `src/mcp/tools/setup.ts`, which registers `setup_lexicon` along with other setup and health tools. Its guarded handler validates names, dynamically imports `runSetup`, translates tool arguments into non-interactive options, and returns the plan or summary as a tool result.

The MCP tool previews by default (`dryRun: true`); `apply: true` runs the setup after the user agrees to the plan. Omitted clients and packs install none, and harvest and the login service require explicit opt-in. MCP harvest leaves a newly created, untrusted or changed project lexicon untrusted for the user to review; an already trusted project remains trusted. A failed apply is marked as an MCP error. CLI defaults and prompts differ, so callers should use the contract for the chosen surface rather than assume the two interfaces have identical defaults.
