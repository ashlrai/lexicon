# The lexicon file

Where your terms live on disk, what a term may contain, and every setting that changes how it is matched.

Two files, merged at load time.

| Scope | Path |
|---|---|
| Global | `$LEXICON_PATH`, else `$XDG_CONFIG_HOME/lexicon/lexicon.yaml`, else `~/.config/lexicon/lexicon.yaml` |
| Project | `.lexicon.yaml`, found by walking up from the current directory to the git root |

Project wins when both define the same canonical (case-insensitive). Aliases from both are unioned. Run `lexicon path` to see which files are in play. Commit `.lexicon.yaml` to share a team vocabulary; each teammate approves it once with `lexicon trust` (see [TRUST.md](TRUST.md)).

The config directory also holds `trust.json`, `serve.json` (local API token), `voice/history.jsonl` and `models/` (whisper models). Nothing else is written outside it except what you ask for (`--out`, exports from `lexicon setup`, client config files under `--apply`).

A full annotated example is in [examples/lexicon.example.yaml](../examples/lexicon.example.yaml). The short version:

```yaml
version: 1
terms:
  - canonical: Ashlr.AI
    aliases: [Ashler, Ashlar, Ashler AI, Ashley our AI]
    phonetic: ASH-ler
    category: brand
    notes: my company; never write Ashlar
  - canonical: SaaS
    aliases: [sass]
    category: acronym
    never: [sauce]
settings:
  minConfidence: 0.82
  phonetic: true
  fuzzy: true
  skipCode: true
  protectedWords: []
```

## Per term

`canonical`, `aliases`, optional `phonetic`, `category` (`brand`, `person`, `product`, `acronym`, `identifier`, `place`, `other`), `notes`, `never`, `caseSensitive`. The tool also records `source`, `createdAt` and `hits`.

### `never`

`never` is a per-term list of words that must not be rewritten to that canonical even when they sound alike. It is how `SaaS` avoids eating every "sauce" in your prompt while still catching "sass".

## Settings

| Key | Default | Meaning |
|---|---|---|
| `minConfidence` | `0.82` | Minimum confidence a phonetic or fuzzy match needs before it is applied. Exact aliases are always 1.0 |
| `phonetic` | `true` | Enable double metaphone matching |
| `fuzzy` | `true` | Enable edit-distance matching |
| `protectedWords` | `[]` | Words no term may ever replace. Merged with the built-in stoplist |
| `skipCode` | `true` | Leave `code spans`, fenced blocks, URLs, emails and paths alone |

`settings.packs` records which [starter packs](PACKS.md) were installed into that file.

## Editing it

`lexicon edit` opens the global file (`--project` for `.lexicon.yaml`) in `$VISUAL` / `$EDITOR` and validates it when the editor exits, reporting any schema error with the path so your edits are never lost. A trusted project file is re-pinned after the edit.

Parsing is defensive: fields are length-capped and stripped of zero-width and bidi characters, and oversized files are refused. The limits and the reasoning are in [TRUST.md](TRUST.md#the-rest-of-the-hardening).

## See also

- [TRUST.md](TRUST.md) explains why the project file is off until you approve it.
- [MATCHING.md](MATCHING.md) covers how the file is applied to text, and what each setting does to the matcher.
- [ARCHITECTURE.md](ARCHITECTURE.md) shows the module that reads and writes it.

Back to [the docs index](README.md).
