# First run

What happens if you follow the README on a Linux VM that already has Node,
and what an agent hits when there is no terminal. Measured 2026-10-26.
Comparable-tool numbers are in [BENCHMARKS.md](BENCHMARKS.md). The machine
is the one described there: Ubuntu 24.04.5, Node v22.23.4, npm 10.9.9.

The README command is:

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
```

npm serves `@ashlr/lexicon` 0.5.4. This source tree is 0.5.6. The install
path below is 0.5.4, because that is what the script installs. Flags that
exist only in this tree are called out as source.

## Timed path

| step | result |
| --- | --- |
| `curl ... \| sh`, stdin is not a TTY | 2.977 s, exit 0. Prints `node v22.23.4 ok`, installs `@ashlr/lexicon@0.5.4` (`added 100 packages in 2s`), then `no terminal to ask the setup questions on; run: lexicon setup` |
| `npm install -g @ashlr/lexicon@0.5.4` again, empty prefix, empty cache | 2.45 s, 100 packages. Peak RSS of npm: 179,276 kB. This is the install without the script's version lookup |
| `lexicon setup --yes`, blank `HOME`, current directory is not a git repo, published 0.5.4 | 0.21 s, exit 0, peak RSS 91,376 kB. Creates `~/.config/lexicon/lexicon.yaml`. `termsAdded` is empty. The demo prints `can you check whether the Ashler migration landed yet` corrected to `can you check whether the Ashlr.AI migration landed yet`, and says the built-in example was used |
| the same setup a second time | exit 0, `termsAdded` still empty |
| `lexicon setup` with stdin closed, no `--yes` | exit 0. Prints `(no terminal: taking the defaults, as with --yes)` and the same seven steps |

Node was already installed. The 2.977 s figure does not include installing
Node. A machine that still has to fetch Node is outside this measurement.

The first printed correction is the setup demo, 0.21 s after the binary is
on `PATH`. Added to the 2.977 s install, that is under 60 s, which was the
target for one-command install and a first useful result.

An `npx` run that executed `normalize` and printed `ping Ashlr.AI about the Kubernetes migration`
finished in 2.799 s, including npm's "new major version" notice on stderr
and the built-in-example note.

## What the docs said, and what the command did

1. The README "How it works" block, and the same shape of example in
   [MATCHING.md](MATCHING.md), told a reader to run
   `lexicon normalize --diff "deploy to head sner with cuban eatties"` and
   expect `head sner` to become `Hetzner` (alias 1.00) and `cuban eatties` to
   become `Kubernetes` (phonetic). On a blank home, published 0.5.4 and this
   source both print `No changes` for that sentence. The built-in example
   (`src/core/demo.ts`, `DEMO_LEXICON`) is Ashlr.AI, Kubernetes, PostgreSQL,
   Pydantic and SaaS. Hetzner is not in it. `cuban eatties` is not an alias
   of Kubernetes. `cooper netties` is: the alias in the example is
   `Cooper Nettie's`, and it matches as an alias at 1.00, not as a phonetic
   guess. This PR changes both doc blocks to a sentence the command actually
   corrects, and a test now runs those sentences (`tests/demo.test.ts`).

   The sentence that works with no lexicon, measured on this source and on
   0.5.4:

   ```text
   ask ashler to deploy kuber netties with post gressql
   -> ask Ashlr.AI to deploy Kubernetes with PostgreSQL
   "ashler" -> "Ashlr.AI" (alias, 1.00)
   "kuber netties" -> "Kubernetes" (phonetic, 0.88)
   "post gressql" -> "PostgreSQL" (phonetic, 0.88)
   ```

   stderr also prints two notice lines: there are no terms yet, this is the
   built-in example, and nothing was written. Those lines are the product
   working as designed. The old doc block did not mention them, so the first
   stderr did not look like the README.

2. `examples/lexicon.example.yaml` does contain Hetzner with alias
   `head sner`. Pointing `LEXICON_PATH` at that file and running the old
   MATCHING.md sentence does not match the doc either. Measured on this
   source: `head sner` is an alias at 1.00, `cooper netties` is an alias at
   1.00 (not phonetic 0.85), and `kubernetees` is fuzzy at 0.91. The updated
   MATCHING.md example uses the built-in lexicon so a reader with no file
   can paste it.

3. The installer, when `node` is missing or older than 20, told Linux users
   `sudo apt install nodejs npm`. On this Ubuntu 24.04.5 image,
   `apt-cache policy nodejs` shows candidate `18.19.1+dfsg-6ubuntu5` and
   nothing newer. The script would then reject that Node
   (`Node 20+ is required`). The nvm line was already the next paragraph.
   This PR changes the Linux hint in `scripts/install.sh` so it says Ubuntu's
   apt package is often too old (24.04's candidate is 18.19.1) and points at
   nvm first. The live URL `https://ashlrai.github.io/lexicon/install.sh` is
   a copy of that file produced by `npm run build:site`. It still has the
   old hint until that site is deployed. This PR does not deploy it.

4. Running `normalize` with the current directory inside this repo prints
   `lexicon: untrusted project lexicon skipped: /workspace/.lexicon.yaml (run: lexicon trust)`
   on stderr (measured with published 0.5.4). The project file is not merged
   until `lexicon trust`. That is the trust gate, and the message names the
   next command. It is surprising if the first command you paste is run from
   a checkout of this repository rather than from your own project.

5. `lexicon setup` inside this repository seeds a company term `Ashlr`, from
   the package scope `@ashlr/lexicon` (`suggestCompany` in
   `src/cli/setup/detect.ts`). The demo then shows `Ashler` corrected to
   `Ashlr`, not to `Ashlr.AI`. From a directory that is not a git checkout
   of a scoped package, no company is seeded and the demo uses the built-in
   example (`Ashler` to `Ashlr.AI`). The README install does not tell you to
   run it inside this repo. Recorded because a contributor following the
   README from a checkout sees the weaker demo.

6. When npm's global prefix is not writable, the script exits 1. Measured:
   `EACCES` creating `/usr/lib/node_modules`, with Node v22.23.4. The script
   already prints the npm permissions doc and the `sudo sh` fallback, and it
   says setup must then be run as the user. That path is doing what it says.

7. Published 0.5.4 `lexicon doctor --json` and `lexicon doctor --fix` both
   exit 1 with `error: unknown option`. This source has both flags, and the
   README says the fix mode is not in the npm package yet. Anyone whose
   first binary came from the install script is on 0.5.4 until a release.

## Agent use

Audited on this source (`node dist/cli/index.js`, version 0.5.6) unless the
row says 0.5.4. No TTY: stdin closed or piped.

### Non-interactive

- `lexicon setup` with no TTY takes the defaults and says so, exit 0. It
  does not prompt. `--dry-run` writes nothing and prints the plan as JSON
  when `--json` is set. `--yes` is the explicit form of the same defaults.
- `lexicon trust` on a TTY asks, and the default answer is no. Off a TTY it
  does not ask: it prints the preview and pins the file. That is written
  down in `src/cli/cmd-trust.ts` as intentional, so a script that already
  runs `lexicon trust` keeps working. The MCP tool `trust_project` does not
  do this. It asks the user with an elicitation the agent cannot answer.
  An agent that shells out to `lexicon trust` with no TTY therefore pins a
  project file the MCP tool would have left for the user.
- `lexicon install` without `--apply` prints the config and writes nothing.
  `--apply` is the write. `--json` exists on this source. On 0.5.4,
  `lexicon install cursor --json` exits 1 with `unknown option '--json'`.
- `lexicon add`, `remove`, `learn`, `init`, and `pack add` of a built-in
  pack write on the first successful call. They do not prompt when the
  arguments are complete. A second `add` of the same aliases is a merge, not
  a duplicate term (measured on 0.5.4: the second call printed `merged`).

### `--json` and errors

On this source, a missing argument and an unknown command print the human
line on stderr and one JSON document on stdout, exit 1:

```json
{ "ok": false, "error": "missing required argument 'canonical'", "nextStep": "see the usage: lexicon add --help" }
```

```json
{ "ok": false, "error": "unknown command 'nope'", "nextStep": "see the usage: lexicon --help" }
```

`normalize --json` on a sentence the example corrects returns `input`,
`output`, `replacements` (with `reason` and `confidence`) and `changed`.

`--json` is on `init`, `add`, `remove`, `list`, `normalize`, `harvest`,
`export`, `path`, `doctor`, `import`, `install`, `uninstall`, `trust`,
`untrust`, `learn`, `stats`, `pending`, `serve`, `voice`, `setup`,
`suggest`, `review` and `edit`. It is not on `mcp`, `hook`, `daemon` or
`pack` itself (`pack add` has its own `--json`). `mcp` and `hook` are
protocol streams, not document commands.

On published 0.5.4, `add --json`, `init --json`, `doctor --json` and
`install --json` all exit 1 with `unknown option '--json'`. An agent that
installs from the README and then passes `--json` to those commands will
fail until it is on this tree or a later release. `normalize --json` and
`setup --json` do work on 0.5.4 (measured).

### `--dry-run` and other write gates

| writes | how a no-op run is spelled |
| --- | --- |
| `setup`, `import`, `uninstall`, `daemon`, `normalize` | `--dry-run` (`normalize --dry-run` prints the summary and leaves stdout as the input) |
| `install`, `suggest`, `doctor --fix` | preview is the default. The write is `--apply` (`doctor` also needs `--fix`; `--apply` alone is refused) |
| `pack add` of a community pack, `pack update` | preview, then a prompt. `--yes` accepts it, and off a TTY `--yes` is required for the community preview |
| `init`, `add`, `remove`, `learn`, `untrust`, `edit`, `review`, `harvest` with the add switch, `pack add` of a built-in pack | no `--dry-run`. They write |

`normalize` is not a file write. Its `--dry-run` skips applying replacements
to stdout.

### MCP schemas

`src/mcp/server.ts` wraps every tool's `inputSchema` in `z.object(...).strict()`
(`strictInput`) before `registerTool`. Prompts go through `strictPromptArgs`.
`tests/mcp-workflows.test.ts` lists the tools and expects
`additionalProperties: false` on every one, and it checks that an undeclared
key is refused by name (`Unrecognized key: "alias"` on `add_term`,
`Unrecognized key: "txt"` on `normalize_transcript`) rather than dropped.
That is the stable shape: unknown keys fail the call, declared keys still
work (`normalize_transcript` with `text`, `dryRun`, `minConfidence`).

Tool handlers are written to return `{ isError: true }` instead of throwing,
so a failure is a tool result. stdout is the protocol stream. Diagnostics
go to stderr.

## Fixes in this PR

- README and [MATCHING.md](MATCHING.md) examples match the built-in lexicon,
  including the "no terms yet" notice. A test locks the two sentences.
- `scripts/install.sh` no longer tells Linux users to `apt install nodejs`
  first. Ubuntu 24.04's package is Node 18.19.1, and the installer requires
  Node 20. The hint points at nvm, and mentions `dnf` and NodeSource for
  other distributions.
- This page and [BENCHMARKS.md](BENCHMARKS.md). The docs index links both.

No version bump, no workflow change, no new CI job. `src/cli/index.ts` and
`src/mcp/server.ts` were not edited. Another change is already aimed at
startup lazy-loading in those files.

## Follow-ups

Ranked by how much of the product they touch. "Small" is one module and its
tests. "Medium" crosses several commands. "Large" is a new surface.

1. **Small.** Put Hetzner back into `DEMO_LEXICON` if the empty-lexicon demo
   should correct `head sner`. It was removed on purpose (the demo is a
   miniature, and the example file is not in the published tarball). Doing
   it means updating the test added here and every doc that pastes a
   first-run sentence. Not done in this PR because the current five terms
   already demonstrate alias, phonetic and fuzzy.

2. **Small.** When `lexicon setup` guesses a company from a scoped package
   name, `@ashlr/lexicon` becomes `Ashlr`, and the demo corrects `Ashler` to
   `Ashlr`. A dotted brand (`Ashlr.AI`) would make the in-repo first run
   show the spelling the rest of the docs use. Needs a rule that does not
   invent dots for scopes that never had them, plus the setup tests.

3. **Medium.** `--dry-run` on `add`, `remove`, `learn`, `init`, `untrust`
   and built-in `pack add`, with the same `{ ok, plan }` shape `setup` uses.
   Today an agent can preview `setup`, `import`, `install` and `doctor --fix`,
   and cannot preview `add`. Each command needs its own plan and a test that
   the file is unchanged.

4. **Medium, and a behavior change.** Off a TTY, `lexicon trust` pins the
   project file without a yes. The file header says this is so existing
   scripts keep working, and that `--yes` would not make an unattended run
   safer because the caller could pass the flag. The MCP tool already
   refuses to decide. If the CLI should match the MCP tool for agents,
   off-TTY trust would exit 2 until `--yes`, and every script that trusts
   today would need the flag. That is why it is not in this PR.

5. **Medium, already in progress elsewhere.** One run of
   `node scripts/bench/startup.mjs` on this VM spent 157.0 ms p50 and
   83,440 kB to print `--version`. A normalize of three terms on that same
   run was 170.5 ms p50. Almost all of that is process startup.
   Lazy-loading the CLI and MCP entry points is a separate change. Those
   two files were left alone here. The command and the sample sizes are in
   [scripts/bench/README.md](../scripts/bench/README.md).

6. **Large.** A system-wide expander in the espanso sense (a resident
   process, any focused text field, no agent in the loop) is a different
   product from the CLI. `lexicon daemon` is the start of it and was not
   part of this measurement. espanso's list command was 15.9 ms p50 and
   34,016 kB. Closing that gap is the resident process, not another
   Node cold start.

7. **Release, out of scope here.** The README install puts 0.5.4 on `PATH`.
   `doctor --fix`, `doctor --json`, `add --json`, `install --json`,
   `uninstall` and `pending` are in this tree and not in that package. No
   version bump in this PR.
