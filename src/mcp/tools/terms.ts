/**
 * Reading and editing the lexicon itself: normalizing a transcript,
 * adding/removing/listing terms, exporting, and the two lookup helpers a model
 * reaches for when a dictated word looks garbled.
 */
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ALIASES,
  TERM_CATEGORIES,
  TERM_SCOPES,
  addTerm,
  computeStats,
  diffSummary,
  exportLexicon,
  learnCorrection,
  normalize,
  recordHits,
  removeAlias,
  removeTerm,
  resolveExportFormat,
  suggestAliases,
  suggestCanonicalFor,
} from '../../core/index.js';
import type { Term, TermScope } from '../../core/index.js';
import { filePathsInUse, guarded, log, nonBlank, skippedProjectFields, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { errorMessage } from '../../util/errors.js';

/**
 * Every name `export_lexicon` accepts: the formats plus the aliases the CLI
 * and the HTTP API already take (`wispr-flow` -> `wispr`). An enum, not a free
 * string, so a client that validates against the schema still sees the list.
 */
const EXPORT_FORMAT_NAMES = [...EXPORT_FORMATS, ...Object.keys(EXPORT_FORMAT_ALIASES)] as [string, ...string[]];

const EXPORT_ALIAS_NOTE = Object.entries(EXPORT_FORMAT_ALIASES)
  .map(([alias, format]) => `'${alias}' means '${format}'`)
  .join(', ');

/** Case-insensitive canonical lookup, matching how the store compares canonicals. */
function holds(terms: readonly Term[] | undefined, canonical: string): boolean {
  const key = canonical.trim().toLowerCase();
  return (terms ?? []).some((t) => t.canonical.trim().toLowerCase() === key);
}

export const registerTermTools: ToolRegistrar = (server, ctx) => {
  // `ctx.cwd` is read on every call: it follows the client's MCP roots once they arrive.
  const { load } = ctx;

  /**
   * After remove_term found nothing: where the term does live, so the agent
   * can retry with the right scope instead of reporting it gone. Only says
   * whether the name the agent passed is present; never returns the
   * contents of an untrusted project file.
   */
  async function whereElse(
    canonical: string,
    scope: TermScope | undefined,
  ): Promise<{ foundIn?: TermScope; note: string }> {
    const loaded = await load();
    if (scope === 'global' && holds(loaded.project?.lexicon.terms, canonical)) {
      return {
        foundIn: 'project',
        note: `"${canonical}" is in the project lexicon (${loaded.project?.path}), not the global one; call remove_term again with scope "project"`,
      };
    }
    if (scope === 'global' && loaded.skippedProject && holds(loaded.skippedProject.lexicon.terms, canonical)) {
      return {
        foundIn: 'project',
        note: `"${canonical}" is in the project lexicon (${loaded.skippedProject.path}), which is not trusted; the user must review it and run \`lexicon trust\` before it can be edited`,
      };
    }
    if (scope === 'project' && holds(loaded.global.lexicon.terms, canonical)) {
      return {
        foundIn: 'global',
        note: `"${canonical}" is in the global lexicon (${loaded.global.path}), not the project one; call remove_term again with scope "global"`,
      };
    }
    return { note: `no term "${canonical}" in ${scope ? `the ${scope} lexicon` : 'the global or project lexicon'}; list_terms shows the exact canonical spellings` };
  }
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
        'Returns { output, changed, replacements, summary }; when `changed` is false the text was already correct and you should carry on silently, ' +
        'unless the result also carries `skippedProject`: then this repo has a project lexicon that is not trusted yet, so tell the user once that `lexicon trust` would enable it.',
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
          await recordHits(canonicals, { cwd: ctx.cwd }).catch((err: unknown) =>
            log('recordHits failed:', errorMessage(err)),
          );
        }
        return textResult({
          output: result.output,
          changed: result.changed,
          replacements: result.replacements,
          summary: result.replacements.length > 0 ? diffSummary(result) : '',
          // Without this an unchanged transcript in a repo whose lexicon is not
          // trusted yet looks exactly like one that needed no correction.
          ...skippedProjectFields(loaded),
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
        'exactly as the user writes it. Omit `aliases` on a new term and likely STT misspellings are generated for you, which beats ' +
        'inventing your own; show the user what was generated so they can veto one. On an existing term, omitted aliases add none, ' +
        'so passing only never, phonetic, category or notes changes just that.',
      inputSchema: {
        canonical: z.string().min(1).describe('The correct spelling, exactly as the user wants it written.'),
        aliases: z
          .array(z.string())
          .optional()
          .describe('Spellings STT actually produces for this term. Omit to auto-suggest (new terms only).'),
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
        // Generated aliases only for a term this call creates: adding a never word,
        // phonetic, category or notes to an existing term must not append any.
        const given = (aliases ?? []).length > 0;
        const term: Term = {
          canonical,
          aliases: aliases ?? [],
          source: 'user',
          ...(phonetic !== undefined ? { phonetic } : {}),
          ...(category !== undefined ? { category } : {}),
          ...(notes !== undefined ? { notes } : {}),
          ...(never && never.length > 0 ? { never } : {}),
          ...(scope !== undefined ? { scope } : {}),
        };
        const saved = await addTerm(term, {
          cwd: ctx.cwd,
          ...(scope !== undefined ? { scope } : {}),
          ...(given ? {} : { defaultAliases: suggestAliases(canonical) }),
        });
        return textResult({ term: saved.term, path: saved.file.path, created: saved.created });
      }),
  );

  server.registerTool(
    'remove_term',
    {
      title: 'Remove a lexicon term or one of its aliases',
      description:
        "Delete a term from the user's lexicon by canonical spelling (case-insensitive), or, with `alias`, drop just that one " +
        'alias from the term and keep the rest of it. ' +
        'WHEN TO CALL: only when the user asks for a name to be forgotten or for one wrong correction to stop (pass `alias` for ' +
        "that), or after they accepted a 'stale' suggestion from suggest_terms. Never tidy the lexicon on your own initiative. " +
        'WHAT IT CHANGES: removes that one term (or alias), and the corrections it was making stop happening. ' +
        'There is no undo through this server. ' +
        'WHAT IT WILL NOT DO: it does not touch any other term and will not remove a term you cannot ' +
        'name exactly -- use list_terms first if you are unsure which canonical the user means. ' +
        'A term that is not found is not an error: the result has `removed: false`, and when the term lives in the other ' +
        'lexicon file than the `scope` you asked for, `foundIn` and `note` say which scope to pass instead. With `alias`, an ' +
        'unknown term or an alias the term does not have is an error.',
      inputSchema: {
        canonical: nonBlank(),
        alias: nonBlank()
          .optional()
          .describe('Remove only this alias (case-insensitive) from the term instead of the whole term.'),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe(
            "Which lexicon file to remove it from. Omitted: the project file first, then global (with `alias`, every file whose copy of the term has it).",
          ),
      },
    },
    async ({ canonical, alias, scope }) =>
      guarded(async () => {
        const opts = { cwd: ctx.cwd, ...(scope !== undefined ? { scope } : {}) };
        if (alias !== undefined) {
          const result = await removeAlias(canonical, alias, opts);
          return textResult({
            canonical: result.term.canonical,
            alias,
            removed: true,
            aliases: result.term.aliases,
            paths: result.files.map((f) => f.path),
          });
        }
        const removed = await removeTerm(canonical, opts);
        if (removed) return textResult({ canonical, removed });
        return textResult({ canonical, removed, ...(await whereElse(canonical, scope)) });
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
          ...skippedProjectFields(loaded),
        });
      }),
  );

  server.registerTool(
    'export_lexicon',
    {
      title: 'Export the lexicon',
      description:
        "Export the merged lexicon in a format for another tool: 'claude-md' (markdown for CLAUDE.md / system prompts), 'markdown', 'text', 'wispr', 'superwhisper', 'whisper-prompt', 'openai', 'macos', 'espanso', 'deepgram', 'assemblyai', 'azure', 'google', 'csv', or raw 'json'. " +
        `Aliases: ${EXPORT_ALIAS_NOTE}.`,
      inputSchema: {
        format: z.enum(EXPORT_FORMAT_NAMES),
        categories: z.array(z.enum(TERM_CATEGORIES)).optional().describe('Only include these categories.'),
        limit: z.number().int().positive().optional().describe('Cap the number of terms exported.'),
      },
    },
    async ({ format, categories, limit }) =>
      guarded(async () => {
        const resolved = resolveExportFormat(format);
        if (!resolved) throw new Error(`unknown export format "${format}" (one of: ${EXPORT_FORMATS.join(', ')})`);
        const loaded = await load();
        const exported = exportLexicon(loaded.merged, resolved, {
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
        const learned = await learnCorrection({ heard, meant }, { cwd: ctx.cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({
          term: learned.term,
          path: learned.file.path,
          created: learned.created,
          aliasAdded: learned.aliasAdded,
          summary: learned.aliasAdded
            ? `"${heard}" -> "${learned.term.canonical}" saved`
            : heard.trim().toLowerCase() === learned.term.canonical.toLowerCase()
              ? `"${learned.term.canonical}" is already the canonical spelling; "${heard}" is corrected to it`
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
        heard: nonBlank().describe('The suspicious word or phrase as it appeared in the transcript.'),
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
