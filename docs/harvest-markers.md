# Harvesting and TODO-style markers

The repository harvester looks for candidate names, not task comments. In
[`src/core/harvest.ts`](../src/core/harvest.ts), the
[generic identifier set](../src/core/harvest.ts#L69) (`GENERIC_IDENTIFIERS`,
identifiers considered too generic to teach an STT engine) ends with these
exact uppercase TODO-style literals:

| Marker | Source |
| --- | --- |
| `TODO` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `FIXME` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `NOTE` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `HACK` | [Generic identifier set](../src/core/harvest.ts#L133) |
| `XXX` | [Generic identifier set](../src/core/harvest.ts#L133) |

They are part of that set, not a separate marker configuration, and the set
holds other generic identifiers too. Its lookup compares the whole candidate
with exact casing; it is not a case-insensitive marker parser or a substring
filter, so a marker-like substring does not reject a whole identifier.

In practice, the source identifier scanner requires a PascalCase token with a
lowercase or digit run followed by another capital, and at least five
characters. The README prose scanner uses a different capitalization pattern
and stoplists, and also consults the generic identifier set. Neither scanner
treats an all-uppercase marker as a candidate, so the standalone literals
never reach the set lookup through the source scanner. Lowercase `todo` also
does not match either capitalization pattern. `Todo` and `Note` are
additionally in the README stoplist.

For example, with `symbols: true`, `git: false`, and the default minimum count
of two, consider a source file containing these lines:

```ts
// TODO: QuasarWidget
// TODO: QuasarWidget
// ToDo: revisit this
// ToDo: revisit this
// FixMe: revisit this
// FixMe: revisit this
```

| Text | Result |
|---|---|
| `TODO` | Not a candidate: it does not match the PascalCase pattern. |
| `ToDo` | Not a source identifier candidate: it is only four characters. In README prose, it can be a candidate if it meets the prose and count rules. |
| `FixMe` | A candidate: it matches the source pattern and is not an exact uppercase entry in the generic set. |
| `QuasarWidget` | A candidate with count two, even though it follows a marker in a comment. |

In README prose, `Mastodon` is a non-match for the marker exclusion: the
`TODO` letters inside the name do not exclude it. It can be a candidate when
the README rules and count threshold are met.

The scanner reads raw source text, including comments and strings, and does
not remove a whole comment or line because it contains a marker. It also
scans dot-TLD brands separately and harvests names from other sources, such as
manifests, directory names and git authors; the generic identifier set is not
a global ban on those strings. Source-only identifiers are omitted by default
unless `symbols: true` is requested or another source provides external
evidence. Candidate counts, the limit, and other filters also affect the final
results. See [GROWING.md](GROWING.md) for the harvest workflow.
For one source example per marker, see
[harvest-marker-examples.md](harvest-marker-examples.md).
For case behavior in source and README prose, see
[harvest-marker-case-behavior.md](harvest-marker-case-behavior.md).
For matching boundaries, see
[harvest-marker-boundaries.md](harvest-marker-boundaries.md) and the tested
[harvest-marker-boundary-examples.md](harvest-marker-boundary-examples.md).
