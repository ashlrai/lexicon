# Design proposal: community pack registry

**Status:** proposal only. Nothing here is implemented. Needs Mason's input
before any work starts, especially the hosting call in point 1.

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

## Decisions for Mason

1. **Hosted index or git-based?** This is the fork in the road. The hosted
   index is the better product and the bigger commitment; the git-based
   index ships as a markdown file and a `--registry` flag.
2. **Curation bar.** Who decides a pack is good enough to list: automated
   checks only, or human review? The vendored four keep their curated badge
   either way.
3. **Namespace and squatting.** First-come `<author>/<name>` needs a dispute
   policy the day two cardiology packs appear.
4. **Non-goal check.** The README says no hosted accounts and no sync
   service. A read-only pack index is arguably neither, but it is a service
   with uptime. If that line is load-bearing for the project's positioning,
   the git-based shape is the honest one.
