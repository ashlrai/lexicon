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
