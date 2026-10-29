# Examples

Runnable copies of the snippets the docs describe, written against
<!-- fresh:begin pin:npm -->`npm i -g @ashlr/lexicon@0.5.6`<!-- fresh:end -->.

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

## Starter-pack proposal: building architecture

For [issue #4](https://github.com/ashlrai/lexicon/issues/4), a future opt-in
pack could help architects dictating about building design and coordination
software. The built-in packs do not cover this profession. These are candidate
splits, not verified transcript errors; collect real STT examples and review
false positives before shipping a pack. In particular, avoid ordinary English
words as standalone aliases, since explicit aliases override the stoplist.

```yaml
version: 1
terms:
  - canonical: Revit
    category: product
    aliases: [re vit]
  - canonical: Archicad
    category: product
    aliases: [archi cad]
  - canonical: AutoCAD
    category: product
    aliases: [auto cad]
  - canonical: Navisworks
    category: product
    aliases: [navis works]
  - canonical: Enscape
    category: product
    aliases: [en scape]
```

This is a proposal, not an installable built-in pack. To develop it further,
follow the [pack contribution guide](../docs/PACKS.md#adding-a-pack-to-this-repo)
and check candidate aliases against actual dictation and ordinary sentences.
