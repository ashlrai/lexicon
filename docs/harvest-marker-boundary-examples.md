# Harvest marker boundary examples

The source identifier scanner in [harvest.ts](../src/core/harvest.ts) scans raw
text with `\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b`, then applies length and
generic-identifier filters. Its word boundaries use ASCII letters, digits,
and underscore as word characters. Markers do not suppress a line, and their
uppercase spellings do not themselves match the PascalCase pattern.

Each row below is the entire contents of a separate `markers.ts` in an
otherwise empty directory. The results are source identifier candidates with
`git: false`, `packages: false`, `symbols: true`, and `minCount: 1`.
`None` means no identifier candidate; it does not mean that the text was
recognized as a task marker. The table is checked against `harvestRepo`.

| Source text | Identifier candidates | Why |
| --- | --- | --- |
| `// TODO: QuasarWidget` | `QuasarWidget` | The colon and space leave a boundary. |
| `// FIXME: NebulaWidget` | `NebulaWidget` | A different marker also leaves the following name available. |
| `// TODO` | None | The all-uppercase marker fails the PascalCase pattern. |
| `// FIXME` | None | The all-uppercase marker fails the same pattern. |
| `// TodoWidget` | `TodoWidget` | A marker-like prefix is not an exact generic identifier. |
| `// QuasarFIXME` | `QuasarFIXME` | A marker-like suffix does not exclude the whole identifier. |
| `// TODOQuasarWidget` | None | There is no word boundary between the marker and the name. |
| `// FIXME: _NebulaWidget` | None | Underscore is a word character, so it blocks the starting boundary. |
| `// TODO: 2QuasarWidget` | None | A digit also blocks the starting boundary. |
| `// FIXME: NebulaWidget_` | None | Underscore blocks the ending boundary. |
| `// TODO: éQuasarWidget` | `QuasarWidget` | The accented letter is not an ASCII word character. |
| `"FIXME: -NebulaWidget"` | `NebulaWidget` | A hyphen leaves a boundary; strings are scanned too. |

The generic set includes the exact, case-sensitive strings `TODO`, `FIXME`,
`NOTE`, `HACK`, and `XXX`, but it is not a substring filter. The examples
above concern source identifiers: README prose, dot-TLD brands, manifests,
and git authors have separate extraction rules. In normal use the default
minimum count is two, and source-only identifiers need `symbols: true` unless
another source supplies external evidence. Candidate limits and other filters
can also change the final results. See [harvest-marker-boundaries.md](harvest-marker-boundaries.md)
for the broader rules.
