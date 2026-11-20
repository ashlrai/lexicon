# Guided setup: contract summary and entrypoints

This page summarizes the current [setup contract](CONTRACT.md#srcclicmd-setupts)
for maintainers and maps where `lexicon setup` and the `setup_lexicon` MCP tool
are registered and run. The contract is the source for exact options, return
shapes and edge cases; [CLI.md](CLI.md) is the generated user-facing flag
reference. This page is not a new specification. The questions at the end are
prompts for future investigation, not commitments or claims that behavior is
missing. Source paths are relative to the repository root.

## Documented responsibilities

`lexicon setup` guides a first run through seven steps and then reports what
happened:

1. **Global lexicon.** Create it if missing and seed a person and company when
   available. Suggestions use Git and package identity; the user can provide
   names explicitly. Existing names are not duplicated, and an established
   lexicon is not reseeded with guessed defaults unless requested.
2. **Starter packs.** Offer a checklist on a terminal. A non-interactive run
   installs no packs unless they are explicitly selected.
3. **Repository harvest.** Offer candidate names from a Git repository and
   exclude names already covered globally. Interactive confirmation defaults to
   no; non-interactive harvest requires an explicit request. A normal CLI write
   uses the project trust gate. The MCP flow can leave a new, untrusted or
   changed project file untrusted and directs the user to review it.
4. **Agent clients.** Detect clients or use the supplied selection, then install
   the chosen integrations and report each result. On a terminal, detected
   clients are preselected; a non-interactive CLI run selects detected clients
   unless a list is supplied. The MCP tool instead installs no clients when its
   list is omitted or empty.
5. **Local API.** Offer a login service on supported platforms. A terminal
   confirmation defaults to yes; a non-interactive run requires an explicit
   request. Report an installation failure or a platform skip.
6. **Dictation app export.** Offer an export for a supported app; the
   non-interactive default is none. Preserve a differing existing export unless
   the user confirms replacement, choosing an available numbered file instead.
7. **Demonstration.** Show a dictated phrase and its correction using the user's
   terms when possible. Otherwise identify the built-in example as an example;
   it is not added to the user's lexicon.

The final card reports the lexicon path, additions, packs, clients, service and
exports, plus a next action. Invalid supplied names and phonetic hints are
refused before any step writes. A closed prompt or a step failure stops the run
and reports completed work and a way to resume. Client and service installation
failures are reported while the remaining steps run, with a failing exit code.

## Preview and agent responsibilities

`lexicon setup --dry-run` writes nothing and asks nothing. Its plan describes the
corresponding real run, including questions, default outcomes, detected clients,
proposed exports and any service blocker. Packs on offer are distinct from packs
the run would actually install. The plan provides a command to apply it. JSON
mode puts the plan or summary on stdout and reports failure through `ok` and the
exit code.

The MCP `setup_lexicon` tool previews by default (`dryRun: true`) and asks the
agent to show the plan before calling it with `apply: true`. Applying installs
only the clients named in the request; an omitted or empty client list installs
nothing, and harvest or the service runs only when explicitly enabled. Applying
does not
implicitly trust a project file: the response names a file needing review and a
separate trust decision, while an already trusted project remains trusted. A
failed apply is marked as an MCP error. The `onboard` prompt asks for exact names
and client choices and ends with a sentence to dictate. See the
[MCP contract](CONTRACT.md) for the tool and prompt details. CLI defaults and
prompts differ, so callers should use the contract for the chosen surface rather
than assume the two interfaces have identical defaults.

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

`createServer` in `src/mcp/server.ts` walks `TOOL_REGISTRARS` from `src/mcp/tools/index.ts`. That list includes `registerSetupTools` in `src/mcp/tools/setup.ts`, which registers `setup_lexicon` along with other setup and health tools. Its guarded handler validates names, dynamically imports `runSetup`, translates tool arguments into non-interactive options, and returns the plan or summary as a tool result. The preview, apply and trust behavior is described under [Preview and agent responsibilities](#preview-and-agent-responsibilities).

## Open questions

These are review questions raised by this summary. The setup contract does not
answer them as product decisions, and they do not change the behavior above.

- How should setup measure whether a user successfully used a correction in a
  real client after the demonstration?
- When client detection finds multiple installations or ambiguous evidence,
  what information would help a user choose the intended integration?
- What recovery guidance best helps users reconcile a partially completed setup
  across clients, service installation and exports?
- What additional accessibility or localization requirements should the guided
  prompts and demonstration meet?
