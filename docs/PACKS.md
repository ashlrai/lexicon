# Starter packs

Four curated term files ship with the package, in [`packs/`](../packs). They are the words a new user would otherwise type by hand on day one: 176 terms and 376 aliases across developer tooling, AI, business and dictation apps.

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

`lexicon setup` offers the packs as a checklist with `developer`, `ai` and `voice-tools` checked and `business` offered unchecked, because most of it is acronyms that speech-to-text already gets right. `--packs a,b` or `--no-packs` decides it without a prompt; under `--yes` nothing is installed unless you pass `--packs`, because a pack is a hundred-odd global terms.

Your agent can do the same: the MCP tool `list_packs` reports the packs and which are installed.

## How install and remove behave

A pack is a plain lexicon file plus `name`, `title` and `description`. Its terms are added by the same merge rules as `lexicon add`, tagged `source: pack`, so a term you already have keeps your spelling, your aliases and your source, and only gains the pack's aliases. Installing twice is a no-op. The names of the installed packs are recorded in `settings.packs` of the file they went into; [LEXICON-FILE.md](LEXICON-FILE.md#settings) is the schema for that.

`lexicon pack remove <name>` removes that pack's terms from the file, except the ones you have edited since: a term with recorded hits, extra aliases or its own [`never`](LEXICON-FILE.md#never) list stays and is reported as `kept`. For a project file the hit count comes from your own `hits.json` rather than from the committed file, so a pack term you use every day is kept even though the file shows no hits for it.

Project-scope installs go through the [trust gate](TRUST.md) like every other write.

## How the aliases were chosen

Aliases are what speech-to-text engines actually write for these names, not guesses at what they might. Where the real-audio benchmark recorded a spelling it is in the pack ("cuban eats" for Kubernetes, "and Tropic" for Anthropic, "Olima" for Ollama, "whisper flow" for Wispr Flow); the rest are the plausible splits and phoneme swaps from the synthetic corpus ("dock her", "engine x", "post gress").

One rule decides the hard cases: **an ordinary English word is never an alias on its own.** Vercel is left without "vessel", Deel without "deal", Brex without "bricks", and Claude without "cloud", because "the cloud" and "close the deal" are sentences people say. `SaaS -> sass` is the single exception, and it carries `never: [sauce]` so the term cannot eat the other one. Twenty-two terms across the four packs carry a `never` list for the same reason.

This is the same precision rule the benchmark measures: zero of 95 clean synthetic sentences and zero of 72 clean spoken sentences were changed. See [BENCHMARK.md](BENCHMARK.md).

## Community packs

The four above are curated and ship with the package. Everything else lives in community registries: an index file anyone can host (a YAML file in a git repo is enough), listing packs as `<author>/<name>`. `registry/index.example.yaml` in this repo documents the index format.

```bash
lexicon pack search cardiology --registry https://example.com/packs/index.yaml
lexicon pack add example/cardiology --registry https://example.com/packs/index.yaml
lexicon pack add example/cardiology@2 --registry ./packs/index.yaml  # pin a version
lexicon pack update --registry https://example.com/packs/index.yaml  # re-check every installed community pack
lexicon pack remove example/cardiology                               # no --registry needed; the pack file is cached
lexicon pack validate ./my-pack.yaml                                 # the publish bar, before you list it
```

A community pack installs through the same merge rules as the vendored four, with three extra guarantees, because installed terms reach model context on every hooked prompt:

- **Checksums pinned at install.** The index carries a sha256 of each pack file; the download is verified before it is read, and the checksum is pinned in `<global-lexicon-dir>/registry/registry.json`. `pack update` re-checks it.
- **Preview before the first write.** `pack add <author>/<name>` shows the whole term list and asks (default no; `--yes` off a terminal). Updates are re-approved one by one, never silent.
- **The ordinary-word guard, enforced.** `lexicon pack validate` runs the publish bar: schema, author present, and no canonical or alias that is an everyday English word. Run it in CI on the pack's own repo.

Updates key on checksum, not on the display version: when the pack file changes, its checksum changes and `pack update` offers the new file, showing every incoming term field, including notes, phonetic spellings, case sensitivity and aliases, along with changed content, added terms and terms the new file drops (dropped terms are reported, never deleted from your lexicon). A pack pinned with `@version` is never moved by `pack update`.

Over MCP, `list_packs` takes the same `registry` parameter, and `add_pack` takes a community ref: without `confirm: true` it returns the term-list preview and writes nothing; confirmation also requires the returned `previewDigest` for the same destination and all approved term fields. Changed content or metadata is refused, and installation uses the exact reviewed bytes.

Project community packs keep separate pins and caches for each canonical project file. Pass `--project` to `pack list`, `pack add`, `pack update` and `pack remove` to operate on that project's installation. Global packs and other projects keep their own records. Metadata without a verified scope/target is refused; inspect and explicitly migrate or remove old metadata before reinstalling.

`pack update --json` previews without writing unless `--yes` is also given. Installation rolls back lexicon and cache changes if publishing its registry metadata fails.

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
3. Add an entry to your index: `author`, `name`, `title`, `description`, `version` (a display string), `terms`/`aliases` counts, `checksum` (`shasum -a 256 <file>`), `url` (absolute `https://`/`file://`, or relative to the index).
4. Host the index and the pack files anywhere a URL reaches. Point users at `lexicon pack search --registry <your index>`.

## See also

- [GROWING.md](GROWING.md) covers the other three ways terms get in: your repo, your corrections, your voice history.
- [LEXICON-FILE.md](LEXICON-FILE.md) is the schema a pack file follows.
- [BENCHMARK.md](BENCHMARK.md) has the precision numbers the alias rule above is written against.

Back to [the docs index](README.md).
