# Examples

Runnable copies of the snippets the docs describe, written against
<!-- fresh:begin pin:npm -->`npm i -g @ashlr/lexicon@0.5.12`<!-- fresh:end -->.
npm `latest` matches; confirm with `npm view @ashlr/lexicon version` before you pin an older tag.

- `lexicon.example.yaml` - a commented starter lexicon: canonical spellings, the
  aliases speech-to-text produces, and the optional `phonetic`, `category`,
  `notes` and `never` fields.
- `library-usage.ts` - `@ashlr/lexicon` as a library: load, correct, extend,
  harvest, export. Runs from a checkout with `node --import tsx examples/library-usage.ts`.
- `stt-pipeline.ts` - the same calls embedded in a speech-to-text pipeline:
  normalize between transcription and the model.
- `mcp-config.json` - the stdio server block for a client that reads JSON config.
- `claude-settings.hook.json` - the SessionStart and UserPromptSubmit hook
  registration for Claude Code's `settings.json`.

## Architecture starter pack

The building-design pack proposed for [issue #4](https://github.com/ashlrai/lexicon/issues/4)
ships as the opt-in `architecture` pack (12 terms, 24 aliases: Archicad, BIM,
clerestory, rainscreen and related modeling tools). Install it with
`lexicon pack add architecture`, or offer it unchecked in `lexicon setup`.
See [docs/PACKS.md](../docs/PACKS.md) for the full roster and how to contribute
another pack.
