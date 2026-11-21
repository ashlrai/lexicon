# Design proposal: community pack registry

**Status:** implemented (MVP) in `src/core/registry.ts`, the `lexicon pack` subcommands (`search`, `add <author>/<name>`, `show` and `list` read a `--registry <index>`; `update` and `remove` take one optionally; `validate` checks a local pack file) and the MCP `list_packs` / `add_pack` tools. This page is the design record: the proposal sections are kept as written, the decisions below are the ones this section asked Mason for, and [As built](#as-built) notes where the code differs from the proposal. The user-facing reference is [docs/PACKS.md](docs/PACKS.md#community-packs).

## The gap

Five curated packs shipped with the package when this was proposed (nine do now, in `packs/`). Issue #4 asks for profession
packs (law, medicine, finance, design, academia, construction, real estate),
and the recipe in `docs/PACKS.md` makes writing one a good first issue. But
every pack anyone writes still funnels through this repo's `packs/`
directory and Mason's review. A lawyer's voir-dire pack and a clinician's
metformin pack should not have to wait on one maintainer's merge queue.

## The proposal

A registry where the community publishes packs and users install them by
name: `lexicon pack search cardiology`, `lexicon pack add community/cardiology`.
The shipped packs stay curated and vendored; everything else is addressed
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
- MCP: `list_packs` gains a `registry?` source alongside the vendored packs.
- `docs/PACKS.md`: the publishing recipe, the review bar for community
  packs, and the trust story below.

## The trust problem, stated plainly

Installed pack terms land in the user's lexicon file, which reaches model
context on every hooked prompt. A malicious pack is a prompt-injection
delivery vehicle with a friendly name. So community packs cannot install
like the vendored packs do. Minimum viable trust story:

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

## As built

Where the shipped MVP differs from the proposal above:

- **Checksum lives in the index, not the pack.** The pack file is the vendored schema plus `author` (which `pack validate` requires) and an optional `homepage`. The registry index entry carries `author`, `name`, `title`, `description`, `homepage`, `version`, `terms`, `aliases`, the sha256 `checksum` of the pack file bytes and its `url` ([registry/index.example.yaml](registry/index.example.yaml)).
- **Pins.** `lexicon pack add <author>/<name>@<version>` records a version pin; `pack update` reports a pinned pack as `pinned` and does not move it.
- **Local state.** Pinned checksums and cached pack files live in `registry/registry.json` beside the global lexicon file; project installs keep separate records under `registry/projects/<hash>/`, selected with `--project`.
- **Agents read only registries the user chose.** MCP `list_packs` and `add_pack` refuse a `registry` the user has not registered: one they installed a pack from with the CLI, or one listed in `LEXICON_REGISTRIES` in the MCP server's environment. The CLI's `--registry` is not gated.
- **MCP install is two calls.** `add_pack` with a community ref returns the full term-list preview and writes nothing; installing needs `confirm: true` plus the `previewDigest` from that preview.

**Open for later:** a hosted index if discovery outgrows files; signed packs (author identity beyond the GitHub-shaped `author` field); an MCP `search_packs` tool (currently `list_packs` takes the registry); namespace disputes.
