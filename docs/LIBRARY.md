# Use as a library

Using `@ashlr/lexicon` as a dependency: for anyone building their own STT pipeline, editor plugin or service rather than using the CLI.

Everything the CLI, MCP server and hooks do is available as plain functions. `normalize()` is pure (text + lexicon in, result out); the store functions read and write the same YAML files the CLI uses.

```bash
npm i @ashlr/lexicon
```

```ts
import { normalize, loadLexicon, addTerm, harvestRepo, exportLexicon } from '@ashlr/lexicon';

// Global ~/.config/lexicon/lexicon.yaml (or $LEXICON_PATH) merged with a trusted
// project .lexicon.yaml found from cwd.
const { merged: lexicon } = await loadLexicon({ cwd: process.cwd() });

const result = normalize('ask ashler to deploy pie dantic', lexicon);
// {
//   input: 'ask ashler to deploy pie dantic',
//   output: 'ask Ashlr.AI to deploy Pydantic',
//   changed: true,
//   replacements: [
//     { start: 4, end: 10, original: 'ashler', replacement: 'Ashlr.AI',
//       canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 },
//     { start: 21, end: 31, original: 'pie dantic', replacement: 'Pydantic',
//       canonical: 'Pydantic', reason: 'alias', confidence: 1 },
//   ],
// }

// Teach it a term (merges aliases into an existing canonical; scope: 'project' writes .lexicon.yaml).
await addTerm({ canonical: 'Deepgram', aliases: ['deep gram'], category: 'product' });

// Mine a codebase for names worth adding, then render the lexicon for another tool.
const candidates = await harvestRepo('/path/to/repo', { limit: 20 });
const whisperPrompt = exportLexicon(lexicon, 'whisper-prompt');
```

## In your own STT pipeline

Between the transcription API and the model. Bias the recognizer first, then fix what it still got wrong.

```ts
import { loadLexicon, normalize, exportLexicon } from '@ashlr/lexicon';

const { merged: lexicon } = await loadLexicon();
const prompt = exportLexicon(lexicon, 'whisper-prompt');          // bias the STT model first
const heard = await transcribe(audio, { prompt });                  // Whisper / Deepgram / etc.
const fixed = normalize(heard, lexicon);                            // then fix what it still got wrong
if (fixed.changed) console.error(fixed.replacements.map((r) => `${r.original} -> ${r.replacement}`));
await llm.send(fixed.output);
```

## Other exports

`parseLexicon(raw)` validates an object you loaded yourself, `diffSummary(result)` renders the replacement list, `suggestAliases(canonical)` guesses likely misspellings, `importLexicon(content, format)` parses another tool's dictionary, `parseCorrection(text)` and `learnCorrection({ heard, meant })` handle corrections, `suggestCanonicalFor(heard, lexicon)` finds the closest terms, `suggestTerms(input)` mines voice history, `computeStats(loaded)` reports usage, and `EXPORT_FORMATS` / `IMPORT_FORMATS` list what `exportLexicon` / `importLexicon` accept. `listPacks()`, `loadPack()`, `installPack()` and `uninstallPack()` cover the [starter packs](PACKS.md).

Types (`Lexicon`, `Term`, `NormalizeResult`, `HarvestCandidate`, `TermSuggestion`, ...) are exported too. The local API is embeddable as `createServer()`, imported from `dist/serve/index.js` and defined in `src/serve/server.ts`; see [LOCAL-API.md](LOCAL-API.md#embedding).

Runnable versions of both snippets: [examples/library-usage.ts](../examples/library-usage.ts) and [examples/stt-pipeline.ts](../examples/stt-pipeline.ts) (`node --import tsx examples/<file>`).

## See also

- [CONTRACT.md](CONTRACT.md) — the exported signature of every module.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the design behind those signatures.
- [MATCHING.md](MATCHING.md) — what `normalize()` does to a sentence, and every guard it applies.
