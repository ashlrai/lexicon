# Design proposal: community pack registry

**Status:** implemented (MVP) in `src/core/registry.ts` and the `lexicon pack` subcommands (`search`, `add <author>/<name>`, `update`, `remove`, `show`, `validate`, all with `--registry`). The decisions below are the ones this section asked Mason for; they are recorded here so a future change knows what it is revisiting.

## The gap

Four curated packs ship with the package. Issue #4 asks for profession
packs (law, medicine, finance, design, academia, construction, real estate),
and the recipe in `docs/PACKS.md` makes writing one a good first issue. But
every pack anyone writes still funnels through this repo's `packs/`
directory and Mason's review. A lawyer's voir-dire pack and a clinician's
metformin pack should not have to wait on one maintainer's merge queue.

## The proposal

A registry where the community publishes packs and users install them by
name: `lexicon pack search cardiology`, `lexicon pack add community/cardiology`.
The shipped four stay curated and vendored; everything else is addressed
`<author>/<name>` and fetched on demand. Two shapes are on the table:

- **Git-based:** a pack is a repo (or a `packs/` directory in one) with a
  manifest; the registry is an index file listing known packs. No new
  service, consistent with the repo's no-hosted-accounts stance, but
  discovery and versioning are DIY.
- **Hosted index:** a small read-only index (name, author, version, checksum,
  download URL) that `lexicon pack search` queries. Easier discovery and
  `lexicon pack update`, but it is a service to run, which the README's
  non-goals currently disclaim.

Either way the pack format does not change: name, title, description,
`version: 1`, terms in the lexicon schema. What changes is distribution and
trust.

## What touches this repo

- Pack format: a `pack.yaml` manifest gains `author`, `homepage` and a
  checksum; `version` becomes meaningful for updates.
- `src/cli/cmd-pack.ts`: `pack search`, `pack add <author>/<name>`,
  `pack update`, and pinning (`lexicon pack add community/cardiology@2`).
- MCP: `list_packs` gains a `registry?` source alongside the vendored four.
- `docs/PACKS.md`: the publishing recipe, the review bar for community
  packs, and the trust story below.

## The trust problem, stated plainly

Installed pack terms land in the user's lexicon file, which reaches model
context on every hooked prompt. A malicious pack is a prompt-injection
delivery vehicle with a friendly name. So community packs cannot install
like the vendored four do. Minimum viable trust story:

- Checksums pinned at install; updates re-approved, never silent.
- Author identity that means something (GitHub identity at least; signatures
  if the hosted index exists).
- The same ordinary-word guard the vendored packs obey, enforced at publish
  time by CI on the pack repo, not just documented.
- Install preview: `pack add` shows the term list before writing, the way
  `trust_project` shows a project file before pinning it.

## Decisions made (MVP)

1. **Git-based.** The registry is an index file, not a service: anyone hosts the YAML anywhere a URL or path reaches. This keeps the README's no-hosted-accounts stance intact; `registry/index.example.yaml` documents the format.
2. **Curation bar.** Automated checks (`lexicon pack validate`: schema, author present, the ordinary-word guard), meant for CI on the pack's own repo. No human review gate; the install-time preview and checksum pinning carry the trust instead.
3. **Namespace.** First-come `<author>/<name>`; no dispute policy yet beyond the checksum binding a ref to exact bytes. Flagged as the first thing to revisit when two cardiology packs appear.
4. **Updates key on checksum, not version.** `version` is a display string; a changed checksum is what makes an update available, and every update is previewed and confirmed, never silent. `@version` pins opt out of `pack update`.

**Open for later:** a hosted index if discovery outgrows files; signed packs (author identity beyond the GitHub-shaped `author` field); an MCP `search_packs` tool (currently `list_packs` takes the registry); namespace disputes.
