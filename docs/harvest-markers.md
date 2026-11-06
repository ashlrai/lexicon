# Harvesting and TODO-style markers

The repository harvester looks for candidate names, not task comments. In
[`src/core/harvest.ts`](../src/core/harvest.ts), the generic identifier set
contains the exact uppercase strings `TODO`, `FIXME`, `NOTE`, `HACK`, and
`XXX`. These are excluded as generic identifiers. The set lookup is
case-sensitive; it is not a case-insensitive marker parser.

In practice, the source identifier scanner requires a PascalCase token with a
lowercase or digit run followed by another capital, and at least five
characters. The README prose scanner uses a different capitalization pattern
and stoplists. Neither scanner treats
an all-uppercase marker as a candidate. Lowercase `todo` also does not match
either capitalization pattern. `Todo` and `Note` are additionally in the
README stoplist.

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

The scanner does not remove a whole comment or line because it contains a
marker. It also scans dot-TLD brands separately and harvests names from other
sources, such as manifests and git authors; the generic identifier set is not
a global ban on those strings. Source-only identifiers are omitted by default
unless `symbols: true` is requested or another source provides external
evidence. Candidate counts, the limit, and other filters also affect the final
results. See [GROWING.md](GROWING.md) for the harvest workflow.
For one source example per marker, see
[harvest-marker-examples.md](harvest-marker-examples.md).
For the marker list and source links, see
[harvest-marker-reference.md](harvest-marker-reference.md).
For case behavior in source and README prose, see
[harvest-marker-case-behavior.md](harvest-marker-case-behavior.md).
For a concise list of the configured strings, see
[harvest-marker-catalog.md](harvest-marker-catalog.md).
