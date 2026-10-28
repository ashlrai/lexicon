# Starter packs

Five curated term files ship with the package, in [`packs/`](../packs). They are the words a new user would otherwise type by hand on day one: 188 terms and 400 aliases across developer tooling, AI, business, dictation apps and architecture.

```bash
lexicon pack list                    # what exists, and which you have
lexicon pack show developer          # the terms and aliases in one pack
lexicon pack add developer ai        # install into the global lexicon
lexicon pack add developer --project # install into .lexicon.yaml instead
lexicon pack remove business         # take one back out
```

| Pack | Terms | Aliases | What is in it |
|---|---|---|---|
| `developer` | 82 | 199 | Infrastructure, languages, frameworks, hosting and the everyday SaaS a software team says out loud (Kubernetes, PostgreSQL, Nginx, Hetzner, Vercel, pnpm) |
| `ai` | 45 | 99 | Labs, models, frameworks, coding agents and the vocabulary of working with LLMs (Anthropic, Claude Code, Ollama, LangChain, RAG) |
| `business` | 35 | 58 | Metrics, acronyms, fundraising terms and the SaaS a founder talks to every day (SaaS, ARR, cap table, Rippling) |
| `voice-tools` | 14 | 21 | Dictation apps, speech models and meeting recorders (Wispr Flow, Superwhisper, whisper.cpp, Granola) |
| `architecture` | 12 | 24 | CAD and BIM tools, drawing formats and building design acronyms (AutoCAD, Revit, Archicad, DWG, IFC) |

`lexicon pack add architecture` installs the architecture vocabulary. For example, `export the d w g from auto cad for the b i m model` becomes `export the DWG from AutoCAD for the BIM model`. Its aliases cover spelled-out acronyms and plausible split or phonetic spellings, rather than measured audio benchmark results. The pack avoids ordinary-word aliases such as "cad", "revert" and "sketch".

`lexicon setup` offers the packs as a checklist with `developer`, `ai` and `voice-tools` checked and `architecture` and `business` offered unchecked, because most of it is acronyms that speech-to-text already gets right. `--packs a,b` or `--no-packs` decides it without a prompt; under `--yes` nothing is installed unless you pass `--packs`, because a pack is a hundred-odd global terms.

Your agent can do the same: the MCP tool `list_packs` reports the packs and which are installed.

## How install and remove behave

A pack is a plain lexicon file plus `name`, `title` and `description`. Its terms are added by the same merge rules as `lexicon add`, tagged `source: pack`, so a term you already have keeps your spelling, your aliases and your source, and only gains the pack's aliases. Installing twice is a no-op. The names of the installed packs are recorded in `settings.packs` of the file they went into; [LEXICON-FILE.md](LEXICON-FILE.md#settings) is the schema for that.

`lexicon pack remove <name>` removes that pack's terms from the file, except the ones you have edited since: a term with recorded hits, extra aliases or its own [`never`](LEXICON-FILE.md#never) list stays and is reported as `kept`. For a project file the hit count comes from your own `hits.json` rather than from the committed file, so a pack term you use every day is kept even though the file shows no hits for it. A pack that no file lists is reported as not installed and nothing is written (exit 0); `--json` then adds `notInstalled: true` and `summary: "<name> is not installed; nothing was removed"` (`in the project lexicon` with `--project`), as `DELETE /packs/:name` does.

Project-scope installs go through the [trust gate](TRUST.md) like every other write. From MCP (`add_pack` with `scope: 'project'`) a project file that is not trusted yet is written but left untrusted, and the result's `nextStep` asks you to review it and run `lexicon trust`.

## How the aliases were chosen

Aliases are what speech-to-text engines actually write for these names, not guesses at what they might. Where the TTS-audio benchmark recorded a spelling it is in the pack ("cuban eats" for Kubernetes, "and Tropic" for Anthropic, "Olima" for Ollama, "whisper flow" for Wispr Flow); the rest are the plausible splits and phoneme swaps from the synthetic corpus ("dock her", "engine x", "post gress").

One rule decides the hard cases: **an ordinary English word is never an alias on its own.** Vercel is left without "vessel", Deel without "deal", Brex without "bricks", and Claude without "cloud", because "the cloud" and "close the deal" are sentences people say. `SaaS -> sass` is the single exception, and it carries `never: [sauce]` so the term cannot eat the other one. Twenty-five terms across the five packs carry a `never` list for the same reason.

This is the same precision rule the benchmark measures: zero of 95 clean synthetic sentences and zero of 72 clean spoken sentences were changed. See [BENCHMARK.md](BENCHMARK.md).

## Community packs

The five above are curated and ship with the package. Everything else lives in community registries: an index file anyone can host (a YAML file in a git repo is enough), listing packs as `<author>/<name>`. `registry/index.example.yaml` in this repo documents the index format.

```bash
lexicon pack search cardiology --registry https://example.com/packs/index.yaml
lexicon pack add example/cardiology --registry https://example.com/packs/index.yaml
lexicon pack add example/cardiology@2 --registry ./packs/index.yaml  # pin a version
lexicon pack update --registry https://example.com/packs/index.yaml  # re-check every installed community pack
lexicon pack remove example/cardiology                               # no --registry needed; the pack file is cached
lexicon pack validate ./my-pack.yaml                                 # the publish bar, before you list it
```

A community pack installs through the same merge rules as the vendored packs, with three extra guarantees, because installed terms reach model context on every hooked prompt:

- **https only.** An index and its pack files are fetched over `https://` (plain `http://` only from this machine, `localhost` or `127.0.0.1`), a redirect to plain `http://` elsewhere is refused, and every index or pack file over 2 MB is refused. The index is what vouches for each pack's checksum, so over plain http anyone on the path could swap both.
- **Checksums pinned at install.** The index carries a sha256 of each pack file; the download is verified before it is read, and the checksum is pinned in `<global-lexicon-dir>/registry/registry.json`. `pack update` re-checks it.
- **Preview before the first write.** `pack add <author>/<name>` shows the whole term list and asks (default no; `--yes` off a terminal). Off a terminal without `--yes` it writes nothing, prints the full command to run with `--yes` (with your `--registry` and `--project`), and exits 1, as `review` and `suggest --apply` do when they have no terminal to ask on; a no at the question exits 0. With `--json` and no `--yes` it prints that preview and writes nothing. In a list such as `pack add developer example/cardiology`, a community pack that is previewed or declined writes nothing but does not stop the others, and the output reports each pack's outcome (under `--json`, one array in argument order). A pack that fails (unknown, a failed install or fetch) stops the run with exit 1: the output names it (under `--json`, a last `{ ref, ok: false, error, nextStep }` entry, or that object for a single ref), and the packs after it are not attempted or reported. Updates are re-approved one by one, never silent: `pack update` off a terminal without `--yes` reports every pack, writes nothing, names the `--yes` command for each and exits 1.
- **Agents read only registries you chose.** MCP `list_packs` and `add_pack` refuse any `registry` the user has not registered: one a community pack was installed from with the CLI (any scope), or one listed in `LEXICON_REGISTRIES` (comma separated, https URLs or absolute paths) in the MCP server's environment. A model cannot point Lexicon at an arbitrary file or host. The CLI's `--registry` is a human flag and is not gated.
- **The ordinary-word guard, enforced.** `lexicon pack validate` runs the publish bar: schema, author present, and no canonical or alias that is an everyday English word. Run it in CI on the pack's own repo.

Updates key on checksum, not on the display version: when the pack file changes, its checksum changes and `pack update` offers the new file, showing every incoming term field, including notes, phonetic spellings, case sensitivity and aliases, along with changed content, added terms and terms the new file drops (dropped terms are reported, never deleted from your lexicon). A pack pinned with `@version` is never moved by `pack update`.

Over MCP, `list_packs` takes the same `registry` parameter, and `add_pack` takes a community ref: without `confirm: true` it returns the term-list preview and writes nothing; confirmation also requires the returned `previewDigest` for the same destination and all approved term fields. Changed content or metadata is refused, and installation uses the exact reviewed bytes. A vendored starter pack has no preview step: `add_pack` with a vendored name and `registry`, `previewDigest` or `confirm: false` is refused and writes nothing, so a call that asked for a preview never installs.

Whether a pack counts as installed comes from one place: `settings.packs` in the lexicon files (trusted ones only), which `pack list`, `pack search`, MCP `list_packs` and `GET /packs` all read. The registry state file only adds the version and source `pack update` uses. When the two disagree for the listed scope, `pack list` says so on stderr, and `pack list --json` adds `registryMismatch { fileOnly, recordOnly }`: `fileOnly` is a pack the file lists with no registry record (`pack update` will not check it; reinstall it with `pack add`), `recordOnly` a record for a pack the file no longer lists (shown as not installed; `pack remove` clears the record). `communityInstalled` in that JSON is the registry records themselves. `pack search` (warnings and `--json`) and MCP `list_packs` report the same `registryMismatch`, checked across every file the flags come from.

Project community packs keep separate pins and caches for each canonical project file. Pass `--project` to `pack list`, `pack add`, `pack update` and `pack remove` to operate on that project's installation. Global packs and other projects keep their own records. Metadata without a verified scope/target is refused; inspect and explicitly migrate or remove old metadata before reinstalling.

`pack update --json` previews without writing unless `--yes` is also given. Installation and removal restore the dictionary, cache and state if publishing registry metadata fails. Update approval also binds the installation record: a new version pin or registry source requires a fresh preview even when the installed bytes are unchanged.

## Adding a pack to this repo

A new vendored pack is one file and one test.

1. Write `packs/<name>.yaml`. It needs `name` (lowercase letters, digits and dashes), `title`, `description`, `version: 1` and `terms`. The schema is the same as [the lexicon file](LEXICON-FILE.md), so `lexicon export json` from a real lexicon is a fine starting point.
2. Give every term a `category` and real aliases. Leave an alias out rather than ship one that is an ordinary word; add `never` when a term sounds like one.
3. Add a case to `tests/packs.test.ts` asserting the term count and at least one alias that must be there.
4. `lexicon pack show <name>` and `lexicon normalize` a sentence that uses three of its terms.

Pack files are read from the package's `packs/` directory only, and the name is validated before any path is built, so a name arriving from the local API or an MCP call can never escape that directory.

## Publishing a pack

1. Write the pack YAML: the same schema as above, plus `author` (required for community packs) and `homepage`.
2. Run `lexicon pack validate <file>` until it is clean.
3. Add an entry to your index: `author`, `name`, `title`, `description`, `version` (a display string), `terms`/`aliases` counts, `checksum` (`shasum -a 256 <file>`), `url` (absolute `https://`, or relative to the index; an index read from a local path or `file://` may also name an absolute local path or `file://` URL, but an index fetched over `https://` may not, so a remote index can never make `lexicon` read a file on your machine).
4. Host the index and the pack files anywhere a URL reaches. Point users at `lexicon pack search --registry <your index>`.

## See also

- [GROWING.md](GROWING.md) covers the other three ways terms get in: your repo, your corrections, your voice history.
- [LEXICON-FILE.md](LEXICON-FILE.md) is the schema a pack file follows.
- [BENCHMARK.md](BENCHMARK.md) has the precision numbers the alias rule above is written against.

Back to [the docs index](README.md).
