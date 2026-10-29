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
- `hetzner-evaluation.ts` - compare the built-in demo lexicon with a proposed
  Hetzner addition and check a potential false positive.

## Evaluating Hetzner in the built-in demo

The sample YAML already contains Hetzner, but the built-in `DEMO_LEXICON` used
when no lexicon is configured does not. To evaluate adding it, run this from a
checkout after `npm install`:

```bash
node --import tsx examples/hetzner-evaluation.ts
```

The script uses the real normalizer and the current built-in demo settings. It
compares that baseline with an in-memory copy containing the sample YAML's
Hetzner entry: canonical `Hetzner`, aliases `head sner` and `hetsner`, phonetic
hint `HETS-ner`, and category `brand`. It asserts these expected outputs and
exits nonzero on a mismatch; it does not modify any lexicon file.

| Input | Before addition | Expected after addition |
|---|---|---|
| `deploy on head sner` | `deploy on head sner` | `deploy on Hetzner` |
| `deploy on hetsner` | `deploy on hetsner` | `deploy on Hetzner` |
| `the head singer is ready` | `the head singer is ready` | `the head singer is ready` |

The last sentence is a potential false positive: it refers to a singer, not the
hosting provider, and should remain unchanged. These hand-picked examples check
the proposed aliases and one near-sounding phrase; they do not measure accuracy
on real transcripts or establish a false-positive rate.
