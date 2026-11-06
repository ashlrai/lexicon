# Harvest marker catalog

The TODO-style marker strings configured in [`src/core/harvest.ts`](../src/core/harvest.ts#L133) are:

| Marker |
| --- |
| `TODO` |
| `FIXME` |
| `NOTE` |
| `HACK` |
| `XXX` |

These literals appear together at the end of `GENERIC_IDENTIFIERS`, a set of
identifiers considered too generic to teach an STT engine. They are part of
that set, not a separate marker configuration. The set is consulted when
filtering source identifiers and README prose candidates; it is not a task
comment parser. Other generic identifiers are also in the set.

For the scanner behavior and its limits, see [harvest-markers.md](harvest-markers.md)
and [harvest-marker-boundaries.md](harvest-marker-boundaries.md). For examples,
see [harvest-marker-examples.md](harvest-marker-examples.md).
