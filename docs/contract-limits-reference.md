# Lexicon schema limits

This is a quick reference for the `LIMITS` in the [schema contract](CONTRACT.md#srccoreschemats). The contract is the full module API and also describes character restrictions and validation errors.

| Limit | Maximum | Applies to |
|---|---:|---|
| `word` | 80 Unicode code points per value | Canonical spelling and each alias, `never` word, protected word and pack name |
| `text` | 200 Unicode code points per value | `notes` and `phonetic` |
| `aliases` | 64 entries per list per term | The `aliases` and `never` lists, each counted separately |
| `terms` | 5000 terms per lexicon file | The `terms` list in a global or project file |
| `protectedWords` | 1000 entries per list | `settings.protectedWords` |

String lengths are measured after invisible characters are stripped and the value is trimmed. A Unicode code point can occupy two UTF-16 code units; for example, an emoji can count as one code point. A visible character made of multiple code points counts as more than one. Empty list entries are removed before the list limit is checked.

The schema also uses the `aliases` limit for `settings.packs`: 64 entries per settings list.

The per-file terms limit is separate from the merged view of a global file and a trusted project file. File size and other operational limits are described in the [contract](CONTRACT.md).
