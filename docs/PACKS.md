# Starter packs

Four curated term files ship with the package, in [`packs/`](../packs). They are the words a new user would otherwise type by hand on day one: 155 terms and 349 aliases across developer tooling, AI, business and dictation apps.

```bash
lexicon pack list                    # what exists, and which you have
lexicon pack show developer          # the terms and aliases in one pack
lexicon pack add developer ai        # install into the global lexicon
lexicon pack add developer --project # install into .lexicon.yaml instead
lexicon pack remove business         # take one back out
```

| Pack | Terms | Aliases | What is in it |
|---|---|---|---|
| `developer` | 70 | 184 | Infrastructure, languages, frameworks, hosting and the everyday SaaS a software team says out loud (Kubernetes, PostgreSQL, Nginx, Hetzner, Vercel, pnpm) |
| `ai` | 36 | 86 | Labs, models, frameworks, coding agents and the vocabulary of working with LLMs (Anthropic, Claude Code, Ollama, LangChain, RAG) |
| `business` | 35 | 58 | Metrics, acronyms, fundraising terms and the SaaS a founder talks to every day (SaaS, ARR, cap table, Rippling) |
| `voice-tools` | 14 | 21 | Dictation apps, speech models and meeting recorders (Wispr Flow, Superwhisper, whisper.cpp, Granola) |

`lexicon setup` offers the packs as a checklist with `developer`, `ai` and `voice-tools` checked and `business` offered unchecked, because most of it is acronyms that speech-to-text already gets right. `--packs a,b` or `--no-packs` decides it without a prompt; under `--yes` nothing is installed unless you pass `--packs`, because a pack is a hundred-odd global terms.

Your agent can do the same: the MCP tool `list_packs` reports the packs and which are installed.

## How install and remove behave

A pack is a plain lexicon file plus `name`, `title` and `description`. Its terms are added with `addTerm` and `source: pack`, so a term you already have keeps your spelling, your aliases and your source, and only gains the pack's aliases. Installing twice is a no-op. The names of the installed packs are recorded in `settings.packs` of the file they went into.

`lexicon pack remove <name>` removes that pack's terms from the file, except the ones you have edited since: a term with recorded hits, extra aliases or its own never-words stays and is reported as `kept`.

Project-scope installs go through the [trust gate](TRUST.md) like every other write.

## How the aliases were chosen

Aliases are what speech-to-text engines actually write for these names, not guesses at what they might. Where the real-audio benchmark recorded a spelling it is in the pack ("cuban eats" for Kubernetes, "and Tropic" for Anthropic, "Olima" for Ollama, "whisper flow" for Wispr Flow); the rest are the plausible splits and phoneme swaps from the synthetic corpus ("dock her", "engine x", "post gress").

One rule decides the hard cases: **an ordinary English word is never an alias on its own.** Vercel is left without "vessel", Deel without "deal", Brex without "bricks", and Claude without "cloud", because "the cloud" and "close the deal" are sentences people say. `SaaS -> sass` is the single exception, and it carries `never: [sauce]` so the term cannot eat the other one. Twenty-two terms across the four packs carry a `never` list for the same reason.

This is the same precision rule the benchmark measures: zero of 95 clean synthetic sentences and zero of 72 clean spoken sentences were changed. See [BENCHMARK.md](BENCHMARK.md).

## Adding a pack

A new pack is one file and one test.

1. Write `packs/<name>.yaml`. It needs `name` (lowercase letters, digits and dashes), `title`, `description`, `version: 1` and `terms`. The schema is the same as [the lexicon file](LEXICON-FILE.md), so `lexicon export json` from a real lexicon is a fine starting point.
2. Give every term a `category` and real aliases. Leave an alias out rather than ship one that is an ordinary word; add `never` when a term sounds like one.
3. Add a case to `tests/packs.test.ts` asserting the term count and at least one alias that must be there.
4. `lexicon pack show <name>` and `lexicon normalize` a sentence that uses three of its terms.

Pack files are read from the package's `packs/` directory only, and the name is validated before any path is built, so a name arriving from the local API or an MCP call can never escape that directory.
