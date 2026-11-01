# Harvest marker case behavior

The [generic identifier set](../src/core/harvest.ts) contains `TODO`, `FIXME`,
`NOTE`, `HACK`, and `XXX` in uppercase. Its `Set.has` lookup compares the
whole candidate with exact casing. It does not match other casing or search
for markers inside a candidate. The harvester does not parse task markers or
exclude the rest of a comment containing one.

The following examples assume an otherwise empty directory named `repo`,
`git: false`, and `minCount: 1`. The names and results below are affected by
the scanner's own capitalization rules as well as the generic set.

## Source identifiers

In `markers.ts`:

```ts
// FIXME: QuasarWidget
// FixMe: revisit this
// fixme: revisit this
```

With `symbols: true`, the candidates are `QuasarWidget` and `FixMe`, each
with count one. `FixMe` passes the PascalCase pattern and is not the exact
set entry `FIXME`. `FIXME` and `fixme` are not candidates because neither
matches that pattern; the uppercase spelling does not reach the set lookup.
The comment after `FIXME` is still scanned. Source-only identifiers otherwise
need evidence from another source to be returned.

## README prose

In `README.md`:

```text
We use ToDo and TODO and todo in this project.
```

`ToDo` is proposed as a brand with count one. `TODO` and `todo` do not match
the README capitalization pattern. The mixed-case `ToDo` is neither the exact
uppercase set entry nor the stoplisted word `Todo`. README scanning also
holds sentence-initial words back unless they appear elsewhere in prose, so
the example places `ToDo` after `We use`.

Candidate buckets merge names case-insensitively after extraction; that is
separate from the case-sensitive generic set lookup. The default minimum
count is two, and limits and other filters can affect results. Manifests, git
authors, directory names, and dot-TLD brands use separate extraction paths;
the generic identifier set is not a global ban. See
[harvest-markers.md](harvest-markers.md) for the overview and
[harvest-marker-boundaries.md](harvest-marker-boundaries.md) for boundaries.
