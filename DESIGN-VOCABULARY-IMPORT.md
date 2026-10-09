# Design proposal: guided vocabulary import

**Status:** implemented (MVP) in `src/core/import-sources.ts`, `src/cli/cmd-import-guided.ts` (`lexicon import --guided`) and the MCP `import_vocabulary` tool. The decisions below are the ones this section asked Mason for; they are recorded here so a future change knows what it is revisiting.

## The gap

`lexicon setup` seeds the lexicon three ways today: the user's name and
company (typed in), the four starter packs (checklist), and the current repo
(harvest). That covers day one. But most people's proper nouns live
elsewhere: the colleagues they email, the clients on their calendar, the
repos in their GitHub orgs, the channels in their Slack workspace. Every one
of those is a list of names STT will garble, and today each one is typed by
hand or not captured at all.

## The proposal

A guided import step, either inside `lexicon setup` or as
`lexicon import --guided`: "Where do your proper nouns live?" The wizard
lists sources, the user checks the ones they want, and each source yields
candidate terms the user approves one screen at a time before anything is
written. Candidate sources:

- Contacts / address book (names of people)
- Calendar (event titles and attendee names: clients, projects)
- GitHub (org members, repo names the user touches)
- Email correspondents (names from recent threads)
- Slack / Discord workspace (member and channel names)

Each candidate arrives as `canonical` plus the aliases STT is likely to
produce for it (the same mis-transcription proposer `add_term` already uses
when aliases are omitted), with a `source: import:<name>` tag so the user can
later see where a term came from and `lexicon pack remove`-style cleanup is
possible.

## What touches this repo

- `src/core/harvest.ts`: new harvester sources beside the repo harvester.
  Each source is a function from credentials-or-local-access to candidate
  terms, with no writes.
- `src/cli/cmd-setup.ts` or a new `cmd-import.ts` flow: the checklist UI and
  the approve-each screen. The existing `Prompter` seam (tests script answers)
  already supports this interaction shape.
- MCP: extend `setup_lexicon` or add `import_vocabulary { sources, apply? }`,
  following the preview-before-write rule the other setup tools follow.

## Decisions made (MVP)

1. **Sources and order.** contacts, calendar, github, in that order. Email and Slack are listed in the wizard as known-but-unimplemented with the reason stated, rather than silently omitted.
2. **Privacy posture.** Local-first only: macOS Contacts and Calendar are read from their on-disk databases, GitHub through the user's existing `gh` login. No new OAuth, no new network calls beyond the source's own API. `--yes` requires an explicit `--sources` list: the wizard never reads an address book on a default. Email/Slack stay out until the OAuth conversation happens.
3. **Dedup and merge.** Candidates merge case-insensitively across sources (higher count wins a spelling conflict, the loser survives as an alias); writes go through `addTerm`, so an existing term keeps its spelling and only gains aliases. New terms are stamped `source: import:<name>`; merged terms keep the source they had.
4. **Scope.** Vocabulary-shaped only: sources are inputs to term candidates, never a CRM. Alias policy is the cautious harvest one, with GitHub handles keeping single-word aliases (they are dictated as words, unlike code symbols).

**Open for later:** email/Slack sources (needs the OAuth conversation); folding the wizard into `lexicon setup` as an optional step; per-source cleanup (`pack remove`-style by `import:<name>`).
