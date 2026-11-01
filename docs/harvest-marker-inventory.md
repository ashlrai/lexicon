# Harvest marker inventory

The following uppercase literals are grouped in the
[generic identifier set](../src/core/harvest.ts#L133). They share the same
role: exact, case-sensitive generic identifier entries, rather than separate
instructions to parse or remove task comments.

| Literal |
| --- |
| `TODO` |
| `FIXME` |
| `NOTE` |
| `HACK` |
| `XXX` |

The source identifier scanner matches PascalCase-shaped text first, then
applies length and generic identifier checks. A standalone uppercase literal
above does not match that pattern, so it never reaches the set lookup through
this scanner. The scanner reads raw source text, including comments and
strings; a marker does not discard the rest of a line. For example,
`// TODO: QuasarWidget` can contribute `QuasarWidget`, subject to the usual
candidate filters. A marker-like substring does not cause a whole identifier
to be rejected by this set.

README prose has its own extraction pattern and also consults the generic
identifier set, while manifest names, directory names, git authors and
dot-TLD brands use other extraction paths. These entries are not a global
ban on those spellings. Source-only identifiers normally need `symbols: true`
or evidence from another source, and the default minimum count is two.

See [harvest-marker-boundary-examples.md](harvest-marker-boundary-examples.md)
for tested source examples and [GROWING.md](GROWING.md) for the harvest workflow.
