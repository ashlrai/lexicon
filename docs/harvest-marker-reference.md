# Harvest marker reference

The [generic identifier set](../src/core/harvest.ts#L69) contains these exact
uppercase TODO-style literals:

| Marker | Source |
| --- | --- |
| `TODO` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `FIXME` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `NOTE` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `HACK` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `XXX` | [Generic identifier set](../src/core/harvest.ts#L133) |

The set contains other generic identifiers too. Its lookup compares the whole
candidate with exact casing; these literals are not a case-insensitive or
substring filter. The source scanner first requires a PascalCase identifier,
so the standalone uppercase literals do not match that pattern in the first
place. The harvester scans text, not task comments: a marker does not suppress
the rest of its line. For example, `// TODO: QuasarWidget` can contribute
`QuasarWidget` as an identifier, subject to the normal candidate filters.

Source-only identifiers need `symbols: true` or evidence from another source;
the default minimum count is two. README prose and dot-TLD brands use separate
scanners, and manifest names, directory names and git authors have their own
rules. The generic identifier set is not a global ban on these strings.

See [harvest-markers.md](harvest-markers.md) for the overview,
[harvest-marker-examples.md](harvest-marker-examples.md) for runnable examples,
and [harvest-marker-boundaries.md](harvest-marker-boundaries.md) for matching
boundaries.
