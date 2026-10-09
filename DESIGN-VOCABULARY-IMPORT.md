# Design proposal: guided vocabulary import

**Status:** proposal only. Nothing here is implemented. Needs Mason's input
before any work starts, especially the privacy call in point 4.

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

## Decisions for Mason

1. **Which sources, and in what order?** Contacts and calendar are the
   highest signal for most people; GitHub orgs for developers. Email is the
   richest and the most sensitive.
2. **The privacy posture.** Reading someone's email or contacts to build a
   vocabulary file is exactly the kind of access this repo's docs tell agents
   to ask about first. The wizard must be explicit about what is read, keep
   everything local (no new network calls beyond the source's own API), and
   ideally work from locally synced data (macOS Contacts, `gh` CLI auth)
   before reaching for OAuth scopes.
3. **Dedup and merge policy.** A colleague who is also a GitHub org member
   appears twice. The merge rules from `lexicon pack add` (existing term keeps
   the user's spelling and aliases, gains the new source tag) mostly apply,
   but need a stated rule for conflicting canonicals.
4. **Scope creep check.** This edges toward "Lexicon manages your contacts,"
   which it does not. The proposal stays vocabulary-shaped: sources are
   inputs to term candidates, never a CRM. If a source cannot be framed that
   way, it does not belong.
