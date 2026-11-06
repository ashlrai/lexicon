# Harvest marker boundaries

The repository harvester lists the literals `TODO`, `FIXME`, `NOTE`, `HACK`,
and `XXX` in its generic identifier set in [harvest.ts](../src/core/harvest.ts).
The set lookup is case-sensitive and compares the entire extracted candidate;
it is not a substring, prefix, or case-insensitive marker match.

For source files, the harvester scans raw text for PascalCase identifiers with
`\b[A-Z][a-z0-9]+[A-Z][a-zA-Z0-9]*\b`, then requires at least five characters
and two uppercase letters and filters generic identifiers. JavaScript's `\b`
here is a transition between an ASCII word character (`A-Z`, `a-z`, `0-9`,
`_`) and a non-word character or the edge of the text. The standalone uppercase
marker literals do not match this PascalCase pattern: its first uppercase
letter must be followed by a lowercase letter or digit before another uppercase
letter. The generic set still contains the exact literals; it does not exclude
an identifier merely because the identifier contains one of them.

| Source text | Identifier scan result |
| --- | --- |
| `// TODO: QuasarWidget` | `TODO` is not an identifier match; `QuasarWidget` is. |
| `TodoWidget`, `QuasarTODO` | Both match; neither is an exact generic marker. |
| `xQuasarWidget`, `_QuasarWidget`, `2QuasarWidget` | No separate `QuasarWidget` match: the preceding ASCII word character prevents a boundary. |
| `éQuasarWidget`, `-QuasarWidget` | `QuasarWidget` has a boundary before it and can match. |

This is a text scan, not a comment parser: a marker does not suppress the rest
of its line, and matching names in comments and strings are scanned too. A
source-only identifier is proposed only with `symbols: true`, unless another
source supplies external evidence; the usual count and limit rules still apply.

README proper-noun scanning is separate. It tokenizes prose, applies its own
capitalization and stoplist rules, and uses the same exact generic set, not a
marker substring filter. For example, `Mastodon` is not rejected because it
contains `todo` in a different case. Other sources, including manifest names,
project directory names and git authors, have their own extraction rules; the
generic identifier set is not a global ban on those names. Dot-TLD brands are
also scanned separately in source and Markdown.
