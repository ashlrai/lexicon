# Schema alias count boundary

`LIMITS.aliases` is 64 ([caps.ts](../src/core/caps.ts)). `buildTerm` applies it
to each term's `aliases` and `never` lists through `WordList`/`OptionalWordList`
in [schema.ts](../src/core/schema.ts); `buildSettings` applies the same 64 to
`settings.packs` and a separate `LIMITS.protectedWords` (1000) to
`settings.protectedWords`. Every list counts on its own.
[schema-collection-limits.md](schema-collection-limits.md) covers the shared
counting rules; this page covers what the boundary itself reports.

## At and over the cap

64 cleaned entries pass; a 65th fails with `too_big` at the list's own path:

```text
terms[0].aliases: at most 64 aliases per term
terms[0].never: at most 64 never words per term
settings.protectedWords: at most 1000 protected words
```

`settings.packs` produces the matching line: `settings.packs: at most 64 packs`. <!-- check-facts:ignore (the literal schema message, not a starter pack count) -->

Entries that strip and trim to nothing are removed before the count, so a raw
list longer than 64 can still pass. Entries are not deduplicated.

## What a violation masks

Once the cleaned list is over the cap, the count error is the only issue
reported for that list, so a 65th alias that is also over `LIMITS.word` or
holds a control character still produces just the `at most 64` line. A
non-string entry never reaches the count: it fails the earlier
`z.array(z.string())` stage and reports `invalid_type` at its own index, for
example `aliases[64]`, with no count error beside it. Inside the cap the same
entry reports only its own problem.

Over-cap lists report independently: a file whose `aliases`, `never` and
`settings.packs` lists are all too long produces one `too_big` issue per list.
A count error does not hide errors in other fields, and a bad field does not
hide a count error. The caps also compose with the per-entry ones: a term
with an 80-character canonical, 64 aliases of 80 characters each, 64 `never`
words of 80 characters each and 200-character `phonetic` and `notes` fields
is valid.
