/**
 * Reading and editing the lexicon itself: normalizing a transcript,
 * adding/removing/listing terms, exporting, and the two lookup helpers a model
 * reaches for when a dictated word looks garbled.
 */
import { z } from 'zod';
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ALIASES,
  MAX_CORRECTION_LENGTH,
  TERM_CATEGORIES,
  TERM_SCOPES,
  addTerm,
  computeStats,
  diffSummary,
  exportLexicon,
  learnCorrection,
  loadMatcherIndex,
  normalizeWithIndex,
  recordHits,
  removeAlias,
  removeTerm,
  resolveExportFormat,
  spellingConflicts,
  suggestAliases,
  suggestCanonicalFor,
  termHolders,
  untrustedAliasHolder,
  untrustedTermHolder,
  isProjectTrustError,
} from '../../core/index.js';
import type { NormalizeIncomplete, NormalizeResult, Term, TermScope } from '../../core/index.js';
import { filePathsInUse, guarded, log, mcpWriteOpts, nonBlank, skippedProjectFields, textResult, untrustedWriteFields } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { errorMessage } from '../../util/errors.js';
import { cliCommand } from '../../util/cli-hint.js';

/**
 * Every name `export_lexicon` accepts: the formats plus the aliases the CLI
 * and the HTTP API already take (`wispr-flow` -> `wispr`). An enum, not a free
 * string, so a client that validates against the schema still sees the list.
 */
const EXPORT_FORMAT_NAMES = [...EXPORT_FORMATS, ...Object.keys(EXPORT_FORMAT_ALIASES)] as [string, ...string[]];

const EXPORT_ALIAS_NOTE = Object.entries(EXPORT_FORMAT_ALIASES)
  .map(([alias, format]) => `'${alias}' means '${format}'`)
  .join(', ');

/**
 * How long one normalize_transcript may spend matching before it stops and
 * returns the corrections found so far: serve's NORMALIZE_BUDGET_MS. The
 * server is one thread, so a long match holds every other tool call.
 */
export const MCP_NORMALIZE_BUDGET_MS = 1_000;

/**
 * Characters of `text` normalize_transcript matches; the rest is returned
 * unchanged. Dictation is a few thousand characters; this is a pasted file.
 */
export const MCP_NORMALIZE_MAX_CHARS = 100_000;

/** How far back from the cap a cut looks for whitespace, so a word is not matched as a fragment. */
const CUT_LOOKBACK_CHARS = 64;

/**
 * Where to cut `text` so at most `max` characters are matched: at the last
 * whitespace within CUT_LOOKBACK_CHARS of the cap (kept on the checked side),
 * never between the halves of a surrogate pair.
 */
export function normalizeCut(text: string, max: number): number {
  if (text.length <= max) return text.length;
  let cut = Math.max(0, max);
  const code = text.charCodeAt(cut - 1);
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  for (let i = cut; i > 0 && i > cut - CUT_LOOKBACK_CHARS; i--) {
    if (/\s/.test(text.charAt(i - 1))) return i;
  }
  return cut;
}

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
        note: `"${canonical}" is in the project lexicon (${loaded.skippedProject.path}), which is not trusted; the user must review it and run ${cliCommand('trust')} before it can be edited`,
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
        `Only the first ${MCP_NORMALIZE_MAX_CHARS} characters are checked and matching stops after ${MCP_NORMALIZE_BUDGET_MS} ms; when either limit is hit the result carries \`incomplete\` { reasons, checkedChars?, totalChars, note } and the unchecked text is returned as it was. ` +
        'Returns { output, changed, replacements, summary }; when `changed` is false the text was already correct and you should carry on silently, ' +
        'unless the result also carries `skippedProject`: then this repo has a project lexicon that is not trusted yet, so tell the user once that ' + cliCommand('trust') + ' would enable it.',
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
        // Cached on disk for a large lexicon (index-cache.json, shared with the
        // hook and serve), so a call does not rebuild the matcher every time.
        const index = await loadMatcherIndex(loaded);
        const cut = normalizeCut(text, ctx.normalizeMaxChars);
        const head = cut < text.length ? text.slice(0, cut) : text;
        const started = Date.now();
        let timedOut = false;
        const matched = normalizeWithIndex(head, index, {
          shouldStop: () => (timedOut ||= Date.now() - started >= ctx.normalizeBudgetMs),
          ...(dryRun !== undefined ? { dryRun } : {}),
          ...(minConfidence !== undefined ? { minConfidence } : {}),
        });
        const tail = text.slice(head.length);
        const result: NormalizeResult = tail
          ? { ...matched, input: text, output: matched.output + tail }
          : matched;
        if (result.changed && !dryRun) {
          const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
          // Best effort: recordHits is contractually non-throwing, but guard anyway so
          // a store hiccup can never turn a successful normalize into an error.
          await recordHits(canonicals, { cwd: ctx.cwd }).catch((err: unknown) =>
            log('recordHits failed:', errorMessage(err)),
          );
        }
        const reasons: NormalizeIncomplete['reasons'] = [...(tail ? (['length'] as const) : []), ...(timedOut ? (['time'] as const) : [])];
        const notes = [
          ...(tail ? [`Only the first ${head.length} of ${text.length} characters were checked; the rest is returned unchanged.`] : []),
          ...(timedOut ? [`Matching stopped at the ${ctx.normalizeBudgetMs} ms budget; later text may still hold uncorrected names.`] : []),
        ];
        const incomplete: NormalizeIncomplete | undefined =
          reasons.length > 0
            ? {
                reasons,
                ...(tail ? { checkedChars: head.length } : {}),
                totalChars: text.length,
                note: `${notes.join(' ')} Call again with the unchecked part, in smaller pieces, if it matters.`,
              }
            : undefined;
        return textResult({
          output: result.output,
          changed: result.changed,
          replacements: result.replacements,
          summary: result.replacements.length > 0 ? diffSummary(result) : '',
          ...(incomplete ? { incomplete } : {}),
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
        'only gains the new aliases. A project file that is not trusted yet is written but left untrusted (the result says `trusted: false`): ' +
        'relay `nextStep`, since the term applies only after the user runs ' + cliCommand('trust') + '. ' +
        'WHAT IT WILL NOT DO: it installs nothing, touches no other term, and does not guess the canonical -- pass the spelling ' +
        'exactly as the user writes it. Omit `aliases` on a new term and likely STT misspellings are generated for you, which beats ' +
        'inventing your own; show the user what was generated so they can veto one. On an existing term, omitted aliases add none, ' +
        'so passing only never, phonetic, category or notes changes just that. When another term already holds one of the aliases, ' +
        'the result carries `conflicts` (each { canonical, scope, as, spelling }) and a `note` with the remove_term call; it never edits that term.',
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
        const writeOpts = await mcpWriteOpts(ctx);
        const saved = await addTerm(term, {
          cwd: ctx.cwd,
          ...(scope !== undefined ? { scope } : {}),
          ...(given ? {} : { defaultAliases: suggestAliases(canonical) }),
          ...writeOpts,
        });
        const untrusted = writeOpts.leaveUntrusted === true && saved.file.scope === 'project';
        // Merged into a term an untrusted file already had: that copy is the
        // file's content, so only what this call wrote is shown.
        const shown = untrusted && !saved.created ? term : saved.term;
        // An alias another term already holds may keep being corrected to that
        // term; say so, as learn_correction does, instead of reporting success.
        const conflicts = spellingConflicts((await load()).merged, shown.aliases, shown.canonical);
        const note = conflicts
          .map((c) =>
            c.as === 'alias'
              ? `${JSON.stringify(c.spelling)} is also an alias of ${JSON.stringify(c.canonical)} (${c.scope}), so it may still be corrected to that; ` +
                `if the user agrees, call remove_term with canonical ${JSON.stringify(c.canonical)}, alias ${JSON.stringify(c.spelling)}, scope "${c.scope}".`
              : `${JSON.stringify(c.spelling)} is its own term (${c.scope}), so it may still be kept as written.`,
          )
          .join(' ');
        return textResult({
          term: shown,
          path: saved.file.path,
          created: saved.created,
          ...(conflicts.length > 0 ? { conflicts, note } : {}),
          ...(untrusted ? untrustedWriteFields(saved.file.path, JSON.stringify(shown.canonical)) : {}),
        });
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
        'Without `alias` it edits one lexicon file; when the term also has a copy in the other file, the result lists it in `stillIn` ' +
        '(each { scope, path }) with a `note`, and that copy keeps correcting until removed with its own scope. ' +
        'When the untrusted project lexicon also has the term (with `alias`: when its copy of the term holds that alias), the result carries `untrustedProject` { path, trust } and a `note`: ' +
        'that file is never edited here, and its copy corrects again once the user trusts it. ' +
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
          let result: Awaited<ReturnType<typeof removeAlias>>;
          try {
            result = await removeAlias(canonical, alias, opts);
          } catch (err) {
            // Without a scope the untrusted project copy comes first and is
            // refused; say that the global copy is still editable on its own.
            const global = termHolders(await load(), canonical).find((h) => h.scope === 'global');
            if (!isProjectTrustError(err) || !global) throw err;
            throw new Error(`${errorMessage(err)}. The global lexicon (${global.path}) also has "${canonical}"; call remove_term with alias and scope "global" to remove the alias from that copy only.`);
          }
          // The skipped project file's copy of the term may hold the alias too:
          // it is never edited, and it corrects again once trusted. Path only.
          const untrustedProject = untrustedAliasHolder(await load(), canonical, alias);
          return textResult({
            canonical: result.term.canonical,
            alias,
            removed: true,
            aliases: result.term.aliases,
            paths: result.files.map((f) => f.path),
            ...(untrustedProject
              ? {
                  untrustedProject,
                  note:
                    `"${alias}" is also an alias of "${result.term.canonical}" in the project lexicon (${untrustedProject.path}), which is ${untrustedProject.trust === 'changed' ? 'changed since it was trusted' : 'not trusted'}, ` +
                    'so it was neither loaded nor edited; that copy corrects again once the user runs ' + cliCommand('trust') + ', so tell them to review the file first.',
                }
              : {}),
          });
        }
        // removeTerm edits one file (the project one first without a scope). A
        // term with a copy in both files keeps correcting from the other copy,
        // so name it rather than let `removed: true` read as gone.
        const before = termHolders(await load(), canonical);
        let removed: boolean;
        try {
          removed = await removeTerm(canonical, opts);
        } catch (err) {
          // Without a scope the untrusted project copy comes first and is
          // refused; say that the global copy is still removable on its own.
          const global = before.find((h) => h.scope === 'global');
          if (!isProjectTrustError(err) || !global) throw err;
          throw new Error(`${errorMessage(err)}. The global lexicon (${global.path}) also has "${canonical}"; call remove_term with scope "global" to remove only that copy.`);
        }
        if (!removed) return textResult({ canonical, removed, ...(await whereElse(canonical, scope)) });
        const loadedAfter = await load();
        const after = termHolders(loadedAfter, canonical);
        const from = before.find((b) => !after.some((a) => a.path === b.path));
        // A copy in the skipped (untrusted) project file is not loaded and is
        // never edited, but it wins the merge once the user trusts the file.
        // Path and trust only: none of that file's contents are reported.
        const untrustedProject = untrustedTermHolder(loadedAfter, canonical);
        if (after.length === 0 && !untrustedProject) return textResult({ canonical, removed, ...(from ? { path: from.path } : {}) });
        const notes = after.map(
          (h) =>
            `"${canonical}" is still in the ${h.scope} lexicon (${h.path}) and keeps correcting from there; ` +
            `if the user wants it gone too, call remove_term again with scope "${h.scope}".`,
        );
        if (untrustedProject) {
          notes.push(
            `"${canonical}" is also in the project lexicon (${untrustedProject.path}), which is ${untrustedProject.trust === 'changed' ? 'changed since it was trusted' : 'not trusted'}, ` +
              'so it was neither loaded nor edited; that copy corrects again once the user runs ' + cliCommand('trust') + ', so tell them to review the file first.',
          );
        }
        return textResult({
          canonical,
          removed,
          ...(from ? { path: from.path } : {}),
          ...(after.length > 0 ? { stillIn: after } : {}),
          ...(untrustedProject ? { untrustedProject } : {}),
          note: notes.join(' '),
        });
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
        'WHAT IT CHANGES: adds `heard` as an alias of `meant`, creating the term if it is new (a new term also gets generated STT misspellings; ' +
        'the result\'s `term.aliases` lists them, so tell the user). A case-only correction ("ashlr" should be "Ashlr") adds no alias: it recases ' +
        'the term\'s canonical, or creates the term spelled that way. One term; nothing else is touched. ' +
        'With scope project and a project file that is not trusted yet, the file is written but left untrusted (`trusted: false`): relay `nextStep`. ' +
        'WHAT IT WILL NOT DO: it does not rewrite the message you already sent, and it cannot help if you hand it a whole phrase -- ' +
        'pass only the misspelled name as `heard`, not the sentence around it, and it never edits another term: when one already claims `heard` ' +
        'the result carries `conflict` { canonical, scope, as, spelling } and the summary says what to call; when an untrusted project lexicon also claims it, `untrustedProject` { path, trust } (path only, never its contents). Then get on with what the user actually asked for.',
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
        const writeOpts = await mcpWriteOpts(ctx);
        const learned = await learnCorrection({ heard, meant }, { cwd: ctx.cwd, ...(scope !== undefined ? { scope } : {}), ...writeOpts });
        const untrusted = writeOpts.leaveUntrusted === true && learned.file.scope === 'project';
        // Merged into a term an untrusted file already had: show only what this
        // call supplied or wrote. Not even the file's canonical: it matched
        // `meant` ignoring case, so its own capitalisation would be a read of
        // the untrusted file.
        const heardText = heard.trim().replace(/\s+/g, ' ');
        const meantText = meant.trim().replace(/\s+/g, ' ');
        const caseOnly = heardText.toLowerCase() === meantText.toLowerCase();
        const term =
          untrusted && !learned.created ? { canonical: meantText, aliases: learned.aliasAdded && !caseOnly ? [heardText] : [] } : learned.term;
        const saved = learned.aliasAdded
          ? `"${heard}" -> "${term.canonical}" saved`
          : heard.trim().toLowerCase() === term.canonical.toLowerCase()
            ? `"${term.canonical}" is already the canonical spelling; "${heard}" is corrected to it`
            : `"${heard}" was already an alias of "${term.canonical}"`;
        const { conflict, untrustedProject } = learned;
        // The other term is never edited here; the agent gets what it needs to
        // ask the user and fix it with remove_term.
        const conflictNote = !conflict
          ? ''
          : conflict.as === 'alias'
            ? `, but "${conflict.spelling}" is also an alias of "${conflict.canonical}" (${conflict.scope}), so it may still be corrected to that. ` +
              // JSON literals: a `"` in a spelling must not blur where an argument ends.
              `If the user agrees, call remove_term with canonical ${JSON.stringify(conflict.canonical)}, alias ${JSON.stringify(conflict.spelling)}, scope "${conflict.scope}".`
            : `, but "${conflict.spelling}" is its own term (${conflict.scope}), so it may still be kept as written. ` +
              `If the user never means "${conflict.canonical}", remove that term with remove_term.`;
        // Path only: the untrusted file's terms never reach the agent.
        const untrustedNote = !untrustedProject
          ? ''
          : ` The project lexicon ${untrustedProject.path} is ${untrustedProject.trust === 'changed' ? 'changed since it was trusted' : 'not trusted'}, so it was not loaded, ` +
            `and another term in it also claims "${heard}": once it is trusted that term wins over this correction. ` +
            'Tell the user; they can review the file with trust_project status, or ' + cliCommand('trust') + ', which previews it first. Do not open it with Read or cat.';
        const pending = untrusted ? untrustedWriteFields(learned.file.path, 'It') : undefined;
        return textResult({
          term,
          path: learned.file.path,
          created: learned.created,
          aliasAdded: learned.aliasAdded,
          ...(conflict ? { conflict } : {}),
          ...(untrustedProject ? { untrustedProject } : {}),
          ...(pending ?? {}),
          summary: saved + conflictNote + untrustedNote + (pending ? ` ${pending.nextStep}` : ''),
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
        'offer to add it with add_term, unless the result carries `skippedProject`: then the name may be in the untrusted project lexicon, so tell the user ' + cliCommand('trust') + ' would enable it.',
      inputSchema: {
        heard: nonBlank().describe(
          `The suspicious word or phrase as it appeared in the transcript, at most ${MAX_CORRECTION_LENGTH} characters.`,
        ),
      },
    },
    async ({ heard }) =>
      guarded(async () => {
        // Scoring is linear in this length for every alias, and learn_correction
        // could not save a longer `heard` anyway.
        if (heard.trim().replace(/\s+/g, ' ').length > MAX_CORRECTION_LENGTH) {
          throw new Error(
            `heard must be at most ${MAX_CORRECTION_LENGTH} characters: pass only the garbled word or name, not the sentence around it`,
          );
        }
        const loaded = await load();
        const suggestions = suggestCanonicalFor(heard, loaded.merged).map((s) => ({
          canonical: s.term.canonical,
          confidence: Number(s.confidence.toFixed(3)),
          aliases: s.term.aliases,
          ...(s.term.category !== undefined ? { category: s.term.category } : {}),
        }));
        // No suggestion in a repo whose project lexicon was skipped may only
        // mean the name is in that file; say so (path only), as list_terms does.
        return textResult({ heard, suggestions, ...skippedProjectFields(loaded) });
      }),
  );

  server.registerTool(
    'lexicon_stats',
    {
      title: 'Lexicon usage statistics',
      description:
        'Counts of terms and aliases, total hits, the most-used terms, terms that never fired, and a per-file breakdown of the merged lexicon. ' +
        '`neverHit` lists at most the first 20 terms that never fired; `neverHitCount` is how many there are in all. ' +
        'An untrusted project .lexicon.yaml is not counted; when one was skipped, `skippedProject` and `note` say so (path only).',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const loaded = await load();
        // Otherwise the counts silently leave out the repo's own terms.
        return textResult({ ...computeStats(loaded), ...skippedProjectFields(loaded) });
      }),
  );

  // ------------------------------------------- setup, install, trust, import
};
