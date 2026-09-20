/**
 * Reading and editing the lexicon itself: normalizing a transcript,
 * adding/removing/listing terms, exporting, and the two lookup helpers a model
 * reaches for when a dictated word looks garbled.
 */
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  TERM_CATEGORIES,
  TERM_SCOPES,
  addTerm,
  computeStats,
  diffSummary,
  exportLexicon,
  learnCorrection,
  normalize,
  recordHits,
  removeTerm,
  suggestAliases,
  suggestCanonicalFor,
} from '../../core/index.js';
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
        "Fix the proper nouns speech-to-text got wrong, using this user's personal lexicon of names, brands, acronyms and identifiers. " +
        'WHEN TO CALL: on any user message that looks dictated, before you act on it. Signs a message was dictated: run-on sentences with ' +
        "little punctuation, spoken filler ('um', 'so yeah'), homophone errors, no code or paths, or a capitalized word that is nearly a " +
        "real name but not quite ('Ashler', \"Cooper Nettie's\", 'pie dentic'). One garbled proper noun is reason enough. You do not need " +
        'the user to say they dictated it, and you do not need permission: this reads a file the user wrote and returns text. ' +
        'WHAT IT CHANGES: nothing the user can see. It does not edit their message, any file, or the lexicon; it only bumps a per-term hit ' +
        'counter. Use the `output` field as the message you act on, and mention the correction only if it changes what you are about to do. ' +
        'WHAT IT WILL NOT DO: it never rewrites text inside code blocks, inline code, file paths, URLs or emails, and it never invents a ' +
        'term that is not in the lexicon. If a word still looks garbled after this, call suggest_canonical rather than guessing. ' +
        'Returns { output, changed, replacements, summary }; when `changed` is false the text was already correct and you should carry on silently.',
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
        "Teach the lexicon a name, so dictation is corrected to it from now on. " +
        'WHEN TO CALL: when the user names something they want spelled a particular way, or during setup for each extra name they give ' +
        'you. For the one specific case of the user correcting a spelling that came out wrong, prefer learn_correction: it finds the ' +
        'right term for you. Do not add a name the user did not ask you to remember. ' +
        "WHAT IT CHANGES: writes one term to the user's lexicon file (global by default, or the repo's .lexicon.yaml with " +
        "scope: 'project'). It merges rather than clobbers: an existing term with the same canonical keeps its own spelling and " +
        'only gains the new aliases. ' +
        'WHAT IT WILL NOT DO: it installs nothing, touches no other term, and does not guess the canonical -- pass the spelling ' +
        'exactly as the user writes it. Omit `aliases` and likely STT misspellings are generated for you, which beats inventing ' +
        'your own; show the user what was generated so they can veto one.',
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
      description:
        "Delete a term from the user's lexicon by canonical spelling (case-insensitive). " +
        'WHEN TO CALL: only when the user asks for a name to be forgotten, or after they accepted a ' +
        "'stale' suggestion from suggest_terms. Never tidy the lexicon on your own initiative. " +
        'WHAT IT CHANGES: removes that one term, and the corrections it was making stop happening. ' +
        'There is no undo through this server. ' +
        'WHAT IT WILL NOT DO: it does not touch any other term and will not remove a term you cannot ' +
        'name exactly -- use list_terms first if you are unsure which canonical the user means.',
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
        "List the user's lexicon terms, global and project merged. Optional case-insensitive substring filter over canonical " +
        'spellings and aliases, plus a category filter. ' +
        'WHEN TO CALL: to show the user what is already known, to check whether a name is covered before adding it, or to find the ' +
        'exact canonical another tool needs. Read-only and safe to call unprompted; filter rather than listing everything. ' +
        'WHAT IT CHANGES: nothing. ' +
        'WHAT IT WILL NOT DO: it does not include an untrusted project .lexicon.yaml -- if one was skipped the result says so in ' +
        '`note`, and trust_project is how the user reviews it.',
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
        'Record that the user corrected a spelling: they meant `meant`, but the transcript or you wrote `heard`. ' +
        "WHEN TO CALL: the moment the user corrects a name -- \"it's Ashlr.AI not Ashler\", \"I said Hetzner\", or they simply " +
        'retype a name you got wrong. Call it while you reply. Do not ask permission for this one: it is the user\'s own correction ' +
        'being written down, and asking every time is the irritating version of this product. ' +
        'WHAT IT CHANGES: adds `heard` as an alias of `meant`, creating the term if it is new. One term; nothing else is touched. ' +
        'WHAT IT WILL NOT DO: it does not rewrite the message you already sent, and it cannot help if you hand it a whole phrase -- ' +
        'pass only the misspelled name as `heard`, not the sentence around it. Then get on with what the user actually asked for.',
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
        'Look up what a garbled word was probably meant to be. ' +
        'WHEN TO CALL: when normalize_transcript left a suspicious proper noun alone. It only matches above a confidence threshold, ' +
        'so a badly mangled name gets through unchanged; call this before guessing, and before asking the user an open question. ' +
        'WHAT IT CHANGES: nothing. It only reads the lexicon. ' +
        'WHAT IT WILL NOT DO: it will not decide for you. It returns ranked { canonical, confidence, aliases } candidates: above ' +
        "about 0.8 use the canonical and mention it in passing, below that ask \"did you mean X?\" and call learn_correction once " +
        'the user confirms, so the next transcript needs no asking. No suggestions means the name is simply not in the lexicon yet: ' +
        'offer to add it with add_term.',
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
