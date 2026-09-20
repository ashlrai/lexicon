/**
 * Reading and editing the lexicon itself: normalizing a transcript,
 * adding/removing/listing terms, exporting, and the two lookup helpers a model
 * reaches for when a dictated word looks garbled.
 */
import { z } from 'zod';
import { EXPORT_FORMATS, TERM_CATEGORIES, TERM_SCOPES, addTerm, computeStats, diffSummary, exportLexicon, learnCorrection, normalize, recordHits, removeTerm, suggestAliases, suggestCanonicalFor } from '../../core/index.js';
import type { Term } from '../../core/index.js';
import { filePathsInUse, guarded, log, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { errorMessage } from '../../util/errors.js';

export const registerTermTools: ToolRegistrar = (server, { cwd, load }) => {
  server.registerTool(
    'normalize_transcript',
    {
      title: 'Normalize dictated text',
      description:
        "Rewrite a dictated/transcribed text using the user's personal lexicon (fixes STT misspellings of names, brands, acronyms, identifiers). " +
        'Call this on any user message that came from voice/dictation or contains a word that looks like a garbled proper noun. ' +
        'Returns corrected text and the list of replacements.',
      inputSchema: {
        text: z.string().describe('The dictated or transcribed text to correct.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('When true, report candidate replacements without applying them (output === input).'),
        minConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Override the minimum confidence (0..1) a fuzzy/phonetic match needs. Exact alias matches are always 1.'),
      },
    },
    async ({ text, dryRun, minConfidence }) =>
      guarded(async () => {
        const loaded = await load();
        const result = normalize(text, loaded.merged, {
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });
        if (result.changed && !dryRun) {
          const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
          // Best effort: recordHits is contractually non-throwing, but guard anyway so
          // a store hiccup can never turn a successful normalize into an error.
          await recordHits(canonicals, { cwd }).catch((err: unknown) =>
            log('recordHits failed:', errorMessage(err)),
          );
        }
        return textResult({
          output: result.output,
          changed: result.changed,
          replacements: result.replacements,
          summary: result.replacements.length > 0 ? diffSummary(result) : '',
        });
      }),
  );

  server.registerTool(
    'add_term',
    {
      title: 'Add a lexicon term',
      description:
        "Save a canonical spelling to the user's lexicon so future dictation is corrected to it. " +
        'Use when the user corrects you ("it\'s Ashlr.AI, not Ashler") - pass the misheard spelling as an alias. ' +
        'If aliases are omitted, likely STT misspellings are generated automatically. Merges aliases into an existing term with the same canonical.',
      inputSchema: {
        canonical: z.string().min(1).describe('The correct spelling, exactly as the user wants it written.'),
        aliases: z
          .array(z.string())
          .optional()
          .describe('Spellings STT actually produces for this term. Omit to auto-suggest.'),
        phonetic: z.string().optional().describe('Pronunciation hint, e.g. "ASH-ler".'),
        category: z.enum(TERM_CATEGORIES).optional(),
        notes: z.string().optional().describe('Free text shown to agents, e.g. "my company; never write Ashlar".'),
        never: z
          .array(z.string())
          .optional()
          .describe('Ordinary words that must never be rewritten to this term even if they sound alike, e.g. ["sauce"] for SaaS.'),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe("'global' (default, ~/.config/lexicon) or 'project' (.lexicon.yaml in the current repo)."),
      },
    },
    async ({ canonical, aliases, phonetic, category, notes, never, scope }) =>
      guarded(async () => {
        const resolvedAliases = aliases && aliases.length > 0 ? aliases : suggestAliases(canonical);
        const term: Term = {
          canonical,
          aliases: resolvedAliases,
          source: 'user',
          ...(phonetic !== undefined ? { phonetic } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(never && never.length > 0 ? { never } : {}),
          ...(scope !== undefined ? { scope } : {}),
        };
        const saved = await addTerm(term, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({ term: saved.term, path: saved.file.path, created: saved.created });
      }),
  );

  server.registerTool(
    'remove_term',
    {
      title: 'Remove a lexicon term',
      description: "Delete a term (by canonical spelling, case-insensitive) from the user's lexicon.",
      inputSchema: {
        canonical: z.string().min(1),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe('Which lexicon file to remove it from. Defaults to the store\'s resolution order.'),
      },
    },
    async ({ canonical, scope }) =>
      guarded(async () => {
        const removed = await removeTerm(canonical, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({ canonical, removed });
      }),
  );

  server.registerTool(
    'list_terms',
    {
      title: 'List lexicon terms',
      description:
        "List the user's lexicon terms (global + project merged). Optional case-insensitive substring filter over canonical spellings and aliases, and category filter.",
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring matched against canonical and aliases.'),
        category: z.enum(TERM_CATEGORIES).optional(),
      },
    },
    async ({ query, category }) =>
      guarded(async () => {
        const loaded = await load();
        const needle = query?.trim().toLowerCase();
        const terms = loaded.merged.terms.filter((t) => {
          if (category && t.category !== category) return false;
          if (!needle) return true;
          if (t.canonical.toLowerCase().includes(needle)) return true;
          return t.aliases.some((a) => a.toLowerCase().includes(needle));
        });
        return textResult({
          terms,
          counts: {
            matched: terms.length,
            total: loaded.merged.terms.length,
            global: loaded.global.lexicon.terms.length,
            project: loaded.project?.lexicon.terms.length ?? 0,
          },
          paths: filePathsInUse(loaded),
          ...(loaded.skippedProject
            ? {
                projectTrust: loaded.projectTrust,
                skippedProject: loaded.skippedProject.path,
                note:
                  loaded.projectTrust === 'changed'
                    ? 'The project .lexicon.yaml changed since it was trusted and was not loaded; the user can review it and run `lexicon trust` again.'
                    : 'An untrusted project .lexicon.yaml exists and was not loaded; the user can review it and run `lexicon trust` to enable it.',
              }
            : {}),
        });
      }),
  );

  server.registerTool(
    'export_lexicon',
    {
      title: 'Export the lexicon',
      description:
        "Export the merged lexicon in a format for another tool: 'claude-md' (markdown for CLAUDE.md / system prompts), 'markdown', 'text', 'wispr', 'superwhisper', 'whisper-prompt', 'openai', 'macos', 'espanso', 'deepgram', 'assemblyai', 'azure', 'google', 'csv', or raw 'json'.",
      inputSchema: {
        format: z.enum(EXPORT_FORMATS),
        categories: z.array(z.enum(TERM_CATEGORIES)).optional().describe('Only include these categories.'),
        limit: z.number().int().positive().optional().describe('Cap the number of terms exported.'),
      },
    },
    async ({ format, categories, limit }) =>
      guarded(async () => {
        const loaded = await load();
        const exported = exportLexicon(loaded.merged, format, {
          ...(categories !== undefined ? { categories } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        return textResult(exported);
      }),
  );

  server.registerTool(
    'learn_correction',
    {
      title: 'Learn from a spelling correction',
      description:
        'Record that the user corrected a transcription: they said `meant` but the transcript/agent wrote `heard`. ' +
        "Call this whenever the user says things like 'it's Ashlr.AI not Ashler', 'I said X', or fixes a name you wrote. " +
        'Adds `heard` as an alias so future dictation is corrected automatically.',
      inputSchema: {
        heard: z.string().min(1).describe('The wrong form that was written, e.g. "Ashler".'),
        meant: z.string().min(1).describe('The spelling the user wants, e.g. "Ashlr.AI".'),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe("'global' (default; or wherever the term already lives) or 'project' (.lexicon.yaml in the current repo)."),
      },
    },
    async ({ heard, meant, scope }) =>
      guarded(async () => {
        const learned = await learnCorrection({ heard, meant }, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({
          term: learned.term,
          path: learned.file.path,
          created: learned.created,
          aliasAdded: learned.aliasAdded,
          summary: learned.aliasAdded
            ? `"${heard}" -> "${learned.term.canonical}" saved`
            : `"${heard}" was already an alias of "${learned.term.canonical}"`,
        });
      }),
  );

  server.registerTool(
    'suggest_canonical',
    {
      title: 'Suggest the canonical form of a garbled word',
      description:
        'Given a word that looks like a garbled proper noun and was not corrected by normalize_transcript, ' +
        "return the closest existing lexicon terms so you can ask the user 'did you mean X?'.",
      inputSchema: {
        heard: z.string().min(1).describe('The suspicious word or phrase as it appeared in the transcript.'),
      },
    },
    async ({ heard }) =>
      guarded(async () => {
        const loaded = await load();
        const suggestions = suggestCanonicalFor(heard, loaded.merged).map((s) => ({
          canonical: s.term.canonical,
          confidence: Number(s.confidence.toFixed(3)),
          aliases: s.term.aliases,
          ...(s.term.category !== undefined ? { category: s.term.category } : {}),
        }));
        return textResult({ heard, suggestions });
      }),
  );

  server.registerTool(
    'lexicon_stats',
    {
      title: 'Lexicon usage statistics',
      description:
        'Counts of terms and aliases, total hits, the most-used terms, terms that never fired, and a per-file breakdown of the merged lexicon.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const loaded = await load();
        return textResult(computeStats(loaded));
      }),
  );

  // ------------------------------------------- setup, install, trust, import
};
