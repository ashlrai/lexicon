# Harvest marker examples

The repository harvester's generic identifier set in
[`harvest.ts`](../src/core/harvest.ts) contains these five uppercase markers:
`TODO`, `FIXME`, `NOTE`, `HACK`, and `XXX`. It does not parse task comments or
assign special meaning to the text after a marker. The set uses an exact,
case-sensitive lookup, not a case-insensitive or substring match.

For example, put the following in `markers.ts` in an otherwise empty directory
and harvest it with `git: false`, `symbols: true`, and `minCount: 1`:

```ts
// TODO: QuasarWidget
// FIXME: NebulaWidget
// NOTE: CometWidget
// HACK: PulsarWidget
// XXX: OrbitWidget
// FixMe: review this
// todo: review this
```

| Source text | Identifier scan result |
| --- | --- |
| `TODO: QuasarWidget` | `QuasarWidget` is proposed once; `TODO` is not proposed. |
| `FIXME: NebulaWidget` | `NebulaWidget` is proposed once; `FIXME` is not proposed. |
| `NOTE: CometWidget` | `CometWidget` is proposed once; `NOTE` is not proposed. |
| `HACK: PulsarWidget` | `PulsarWidget` is proposed once; `HACK` is not proposed. |
| `XXX: OrbitWidget` | `OrbitWidget` is proposed once; `XXX` is not proposed. |
| `FixMe` | Proposed once: it matches the source identifier pattern and is not the exact set entry `FIXME`. |
| `todo` | Not proposed: lowercase text does not match the source identifier pattern. |

The uppercase markers themselves fail the source scanner's PascalCase pattern
before the generic set is checked. A colon leaves a word boundary, so the
following identifier is scanned normally, even in a comment. The example uses
`minCount: 1` to show single occurrences; the default is two. Source-only
identifiers are omitted by default unless `symbols: true` is set or another
source supplies external evidence. Limits and other filters can also affect the
final list.

README prose uses a separate capitalization pattern and stoplists; it does not
make marker matching case-insensitive. For instance, `FixMe` can be proposed
as a README brand when the prose and count rules are met. Dot-TLD scanning is
separate too: `TODO.AI` can be proposed as a brand even though `TODO` alone is
not proposed by the source identifier scanner. See
[harvest-markers.md](harvest-markers.md) and
[harvest-marker-boundaries.md](harvest-marker-boundaries.md) for more cases.
