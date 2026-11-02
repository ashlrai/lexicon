# Term capacity reference

How many terms and aliases a lexicon can hold, and how long each piece of text
can be. Counts and lengths are different limits: a count caps how many entries
a list has, a length caps how many characters one entry has. Both must pass.

Sources: [CONTRACT.md](CONTRACT.md) (the `LIMITS` line under `src/core/schema.ts`),
[schema.ts](../src/core/schema.ts) (enforcement) and [caps.ts](../src/core/caps.ts)
(the numbers). Agents can read the same values from `LIMITS` in the core API.

## Count limits (how many)

| What | Max | `LIMITS` key | Enforced in `schema.ts` |
| --- | ---: | --- | --- |
| Terms per lexicon file | 5000 | `terms` | `buildLexicon`, `.max(LIMITS.terms)` |
| Aliases per term | 64 | `aliases` | `buildTerm`, `WordList(LIMITS.aliases, ...)` |
| `never` words per term | 64 | `aliases` | `buildTerm`, `OptionalWordList(LIMITS.aliases, ...)` |
| `settings.packs` entries | 64 | `aliases` | `buildSettings` |
| `settings.protectedWords` entries | 1000 | `protectedWords` | `buildSettings` |

The contract states `terms` 5000, `aliases` 64 (aliases and `never`) and
`protectedWords` 1000. `settings.packs` shares the 64 cap in the schema but is
not named in the contract line.

## Text-length limits (how long)

| What | Max characters | `LIMITS` key | Enforced in `schema.ts` |
| --- | ---: | --- | --- |
| `canonical` | 80 | `word` | `NonEmptyWord` |
| Each alias, `never`, `protectedWords` or `packs` entry | 80 | `word` | `CleanWordList` |
| `notes`, `phonetic` | 200 | `text` | `SafeString(LIMITS.text)` |
| `createdAt` | 64 | none (literal) | `buildTerm` |

Outside the file schema, `MAX_CORRECTION_LENGTH` (60, in `caps.ts`) caps each
side of a `learn_correction` pair. It is a text length, not a count.

## Reading the two together

- A term with 64 aliases of 80 characters each is valid. 65 aliases is not,
  however short they are. One 81-character alias is not, however few there are.
- Lengths are measured after invisible characters are stripped and whitespace
  is trimmed. Empty list entries are dropped before counting; duplicates still
  count.
- Count limits apply per file. A global and a trusted project file each get
  their own 5000 terms.

For the full field-by-field detail, see [schema-limit-reference.md](schema-limit-reference.md).
