/**
 * Mining new terms: scanning the repo for names worth adding, proposing
 * what the lexicon should learn next, and applying one of those proposals.
 */
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import {
  SUGGEST_DEFAULT_LIMIT,
  TERM_CATEGORIES,
  TERM_SCOPES,
  addTerm,
  addTerms,
  defaultProjectPath,
  harvestRepo,
  isProjectTrustError,
  loadLexicon,
  loadVoiceHistory,
  removeTerm,
  resolvePaths,
  suggestAliases,
  suggestTerms,
  termHolders,
} from '../../core/index.js';
import type { LexiconFile, LoadedLexicon, Term, TermScope, VoiceHistoryEntry } from '../../core/index.js';
import { errorMessage } from '../../util/errors.js';
import { HARVEST_ROOTS_ENV, SUGGESTION_KINDS, containedPath, guarded, log, mcpWriteOpts, nonBlank, shellWord, textResult, untrustedWriteFields } from '../shared.js';
import { cliCommand } from '../../util/cli-hint.js';
import type { ToolRegistrar } from '../shared.js';

/** The most suggestions one apply_suggestion call takes in `suggestions`. */
const APPLY_SUGGESTIONS_MAX = 100;

const suggestionSchema = z.object({
  kind: z.enum(SUGGESTION_KINDS),
  canonical: nonBlank(),
  alias: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  category: z.enum(TERM_CATEGORIES).optional(),
  reason: z.string().optional(),
  confidence: z.number().optional(),
  evidence: z.array(z.string()).optional(),
  count: z.number().optional(),
  scope: z.enum(TERM_SCOPES).optional(),
  path: z.string().optional(),
});

function aliasCount(n: number): string {
  return `${n} alias${n === 1 ? '' : 'es'}`;
}


/**
 * Why `suggest_terms` found nothing, and what produces suggestions: the
 * second text block of an empty result.
 */
function emptySuggestionsNote(historyEntries: number): string {
  const history =
    historyEntries === 0
      ? `there is no voice history yet (only ${cliCommand('voice')} push-to-talk records one)`
      : `the ${historyEntries} ${historyEntries === 1 ? 'dictation in the voice history holds' : 'dictations in the voice history hold'} no new garble or name`;
  return (
    `No suggestions: ${history}, no term is stale yet, and the repo gave no name the lexicon lacks. ` +
    'Suggestions come from dictations recorded in the voice history, from terms that never fire, and from the repo. ' +
    'Tell the user, and offer add_term for a name they know is misheard; call suggest_terms again after they have dictated for a while.'
  );
}
export const registerHarvestTools: ToolRegistrar = (server, ctx) => {
  // `ctx.cwd` is read on every call: it follows the client's MCP roots once they arrive.
  const { load } = ctx;
  server.registerTool(
    'harvest_repo',
    {
      title: 'Harvest names from a repository',
      description:
        'Scan a repository for proper nouns an STT engine is likely to mangle: package and dependency names, git authors, README brands, the project directory. ' +
        'Only names the repo says somewhere other than its own source are proposed: a class that exists nowhere but code is something the user types, not something they say, and adding it teaches the lexicon to rewrite ordinary dictation. ' +
        'WHEN TO CALL: when you are in a repo with no .lexicon.yaml and the user dictates about it, or when they ask what this project ' +
        'would add. Call it without `add` first -- that is a read-only preview. ' +
        "WHAT IT CHANGES: nothing unless `add: true`, which writes the candidates into the repo's .lexicon.yaml. Show the candidate list and get a yes first. " +
        'A file the user already trusted stays trusted; a new, untrusted or changed one is not trusted by the write (`trusted: false`) and applies only after the user reviews it and runs ' + cliCommand('trust') + ': relay `nextStep`. ' +
        `\`path\` must be inside the server directory, its git root, a client root or ${HARVEST_ROOTS_ENV}; anything else is refused. ` +
        'WHAT IT WILL NOT DO: it does not touch the global lexicon, and it does not pull file contents into the conversation -- ' +
        'candidates come back as names, categories and counts: { root, candidates: [{ canonical, category, source, evidence, count, suggestedAliases }], count }, ' +
        'where `evidence` names where a name was seen (a file path, "git log", "package.json#name"), never the text around it, and `suggestedAliases` is often empty on purpose (an identifier gets none). ' +
        'With `add: true` the result adds `added`, `failures` and `path`, and is an error when no candidate could be written.',
      inputSchema: {
        path: z.string().optional().describe(`Repository root. Defaults to the server working directory. Must be inside it, its git root, a client root or ${HARVEST_ROOTS_ENV}.`),
        limit: z.number().int().positive().optional().describe('Max candidates to return (default 50).'),
        minCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Minimum occurrences for a name found only in file text (default 2). The directory name, git authors, package names and dot-TLD brands (Ashlr.AI) are proposed at any count.'),
        add: z.boolean().optional().describe('When true, add every candidate to the project lexicon. A file that is not trusted yet is left untrusted for the user to review.'),
      },
    },
    async ({ path, limit, minCount, add }) =>
      guarded(async () => {
        const root = path ? containedPath(ctx, path, (dir) => `harvest ${shellWord(dir)}`) : ctx.cwd;
        const candidates = await harvestRepo(root, {
          ...(limit !== undefined ? { limit } : {}),
          ...(minCount !== undefined ? { minCount } : {}),
        });
        let added = 0;
        let written: string | undefined;
        const failures: Array<{ canonical: string; error: string }> = [];
        // Write into the harvested repo's own project lexicon, not the server
        // cwd. A model chose these names, so a new, untrusted or changed file
        // is never trusted by the write (trusting it is the user's call:
        // lexicon trust); a file the user already trusted takes them and stays
        // trusted, as for every other MCP write.
        const writeOpts = add ? await mcpWriteOpts({ cwd: root }) : {};
        if (add && candidates.length > 0) {
          const terms: Term[] = candidates.map((c) => ({
            canonical: c.canonical,
            aliases: c.suggestedAliases,
            category: c.category,
            source: c.source,
            scope: 'project',
          }));
          const opts = { cwd: root, scope: 'project' as const, ...writeOpts };
          try {
            // One read and one write for the whole list: one addTerm per
            // candidate re-parsed the growing file on every write, so the
            // default 50 names took seconds.
            const saved = await addTerms(terms, opts);
            written = saved.file.path;
            added = saved.results.length;
          } catch (err) {
            // Every candidate would fail the same way; surface it once as the
            // tool error instead of N identical failure rows.
            if (isProjectTrustError(err)) throw err;
            // The batch wrote nothing. Retry one by one so the candidates that
            // can be written are, and each failure names its own candidate.
            for (const term of terms) {
              try {
                const saved = await addTerm(term, opts);
                written = saved.file.path;
                added += 1;
              } catch (inner) {
                if (isProjectTrustError(inner)) throw inner;
                failures.push({ canonical: term.canonical, error: errorMessage(inner) });
              }
            }
          }
        }
        const payload = {
          root,
          candidates,
          count: candidates.length,
          ...(add ? { added, failures } : {}),
          ...(written !== undefined
            ? { path: written, ...(writeOpts.leaveUntrusted ? untrustedWriteFields(written, `${added} name(s)`, true) : {}) }
            : {}),
          ...(failures.length > 0
            ? { note: `${failures.length} of ${candidates.length} candidates were not added (first: ${failures[0]?.error}); see failures` }
            : {}),
        };
        // Every write failed: nothing was added, so this is not a success the
        // agent should report as "added" (the payload still lists the reasons).
        if (add && added === 0 && failures.length > 0) return { ...textResult(payload), isError: true };
        return textResult(payload);
      }),
  );

  server.registerTool(
    'suggest_terms',
    {
      title: 'Propose lexicon improvements',
      description:
        "Propose new aliases, terms and never-words from the user's voice history, usage and repo. " +
        'Call weekly or when the user asks how to improve corrections; present them and apply accepted ones with apply_suggestion (or add_term). ' +
        "Each suggestion has kind 'alias' (a misspelling to add to an existing term), 'term' (a new name), 'never' (a word wrongly rewritten), or 'stale' (a term that never fires), plus reason, confidence and evidence, " +
        "and `scope` and `path`: the lexicon file applying it would write (where the term lives, or the global file for a new term). Name that file when you present a suggestion. " +
        'The result is a bare JSON array, best first. An empty array comes with a second text block saying why (no voice history yet, or nothing new in it) and what produces suggestions: relay it.',
      inputSchema: {
        cwd: z.string().optional().describe(`Repository to scan for evidence. Defaults to the server working directory. Must be inside it, its git root, a client root or ${HARVEST_ROOTS_ENV}.`),
        limit: z.number().int().positive().optional().describe(`Max suggestions to return (default ${SUGGEST_DEFAULT_LIMIT}).`),
      },
    },
    async ({ cwd: cwdArg, limit }) =>
      guarded(async () => {
        const root = cwdArg ? containedPath(ctx, cwdArg, (dir) => `suggest --cwd ${shellWord(dir)}`) : ctx.cwd;
        // suggestTerms reads the merged files only (merged, global, project),
        // so a skipped project file is never parsed.
        const loaded = await loadLexicon({ cwd: root, parseSkipped: false });
        const history: VoiceHistoryEntry[] = await loadVoiceHistory(loaded.global.path).catch((err: unknown) => {
          log('loadVoiceHistory failed:', errorMessage(err));
          return [];
        });
        const suggestions = await suggestTerms({ loaded, history, cwd: root, ...(limit !== undefined ? { limit } : {}) });
        const result = textResult(suggestions);
        // The result is a bare array by contract (docs/MCP.md, the tests), so an
        // empty one gets its reason as a second text block rather than a field.
        if (suggestions.length === 0) result.content.push({ type: 'text', text: emptySuggestionsNote(history.length) });
        return result;
      }),
  );

  server.registerTool(
    'apply_suggestion',
    {
      title: 'Apply suggestions',
      description:
        "Apply a suggestion returned by suggest_terms after the user accepted it: 'alias' merges the alias into the term, 'term' adds the term (aliases auto-suggested when none given), " +
        "'never' records the word as never-rewrite on the term, 'stale' removes the term from one lexicon file (the suggestion's `scope`, else project first); " +
        'when the term also has a copy in the other file the result lists it in `stillIn` and that copy keeps correcting until removed with its own scope. ' +
        "Pass the suggestion object back as received; one whose `path` is another repo's project lexicon (suggest_terms with `cwd`) is refused, since this server writes only its own. " +
        'When the user accepted several, pass them all at once in `suggestions` instead of `suggestion` (one call, one write per lexicon file): ' +
        'they are applied in order, the result lists each applied one in `applied` (the single-suggestion result plus its `index`) and each refused one in `failures` (`index`, `kind`, `canonical`, `error`), and a refused one does not stop the rest. ' +
        'A project file that is not trusted yet is written but left untrusted (`trusted: false`): relay `nextStep`.',
      inputSchema: {
        suggestion: suggestionSchema.optional().describe('One suggestion, as suggest_terms returned it. Pass this or `suggestions`, not both.'),
        suggestions: z
          .array(suggestionSchema)
          .min(1)
          .max(APPLY_SUGGESTIONS_MAX)
          .optional()
          .describe(`1 to ${APPLY_SUGGESTIONS_MAX} suggestions, as suggest_terms returned them, applied in order. Pass this or \`suggestion\`, not both.`),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe(
            "Where to write: 'global' or 'project'. Omitted: where the term already lives for 'alias' and 'never', else 'global'. An 'alias' or 'never' scope must name a file that holds the term; one that does not is refused, as it would create a copy. Applies to every entry of `suggestions`.",
          ),
      },
    },
    async ({ suggestion, suggestions, scope }) =>
      guarded(async () => {
        if ((suggestion === undefined) === (suggestions === undefined)) {
          throw new Error(
            suggestion === undefined
              ? 'pass the accepted suggestion in `suggestion`, or several in `suggestions`; nothing was written'
              : 'pass either `suggestion` or `suggestions`, not both; nothing was written',
          );
        }
        if (suggestion !== undefined) {
          const p = await prepareSuggestion(suggestion, scope, load);
          if (p.kind === 'stale') return textResult(await applyStale(p, load));
          const writeOpts = await mcpWriteOpts(ctx);
          return textResult(describeAdd(p, await addTerm(p.term, { ...p.storeOpts, ...writeOpts }), writeOpts));
        }
        return applyMany(suggestions ?? [], scope);
      }),
  );

  type Suggestion = z.infer<typeof suggestionSchema>;
  type PreparedStale = { kind: 'stale'; canonical: string; target: TermScope | undefined; storeOpts: StoreWriteOpts };
  type PreparedAdd = { kind: 'alias' | 'never' | 'term'; alias: string | undefined; term: Term; storeOpts: StoreWriteOpts };
  type StoreWriteOpts = { cwd: string; scope?: TermScope };

  /** Checks one suggestion and works out what it writes where; throws, writing nothing, when it is refused. */
  async function prepareSuggestion(suggestion: Suggestion, scope: TermScope | undefined, current: () => Promise<LoadedLexicon>): Promise<PreparedStale | PreparedAdd> {
    const { kind, canonical } = suggestion;
    const alias = suggestion.alias?.trim();
    // An alias or never word goes where the term lives, as `lexicon suggest`
    // does: a global copy of a project term loses the merge, so it would
    // never fire. An explicit scope must name a file that holds the term.
    let target = scope ?? suggestion.scope;
    if (kind === 'alias' || kind === 'never') {
      // Both edit an existing term. When it is gone (removed since
      // suggest_terms ran, or only in a skipped project file) addTerm
      // used to create a new term holding just this word, reported as
      // "saved": a term the user never asked for.
      const key = canonical.trim().toLowerCase();
      const loaded = await current();
      const existing = loaded.merged.terms.find((t) => t.canonical.trim().toLowerCase() === key);
      if (!existing) {
        throw new Error(
          `no term "${canonical}" in the lexicon, so there is nothing to add this ${kind === 'alias' ? 'alias' : 'never word'} to (it may have been removed since suggest_terms ran); ` +
            'nothing was written. Call suggest_terms again, or add_term if the user wants the term created.',
        );
      }
      // A scope that names a file without the term (an explicit `scope`,
      // or a suggestion's own from before the term moved) made addTerm
      // create a copy there holding only this word. A project copy wins
      // the merge, so the global term's never words, category and notes
      // stopped applying; a global copy leaked the term into every repo.
      const holders = termHolders(loaded, canonical);
      if (target !== undefined && target !== existing.scope && !holders.some((h) => h.scope === target)) {
        const where = holders.map((h) => `${h.scope} lexicon (${h.path})`).join(' and ') || `${existing.scope} lexicon`;
        throw new Error(
          `"${existing.canonical}" is in the ${where}, not the ${target} one, so this ${kind === 'alias' ? 'alias' : 'never word'} would create a copy of the term there; nothing was written. ` +
            `Call apply_suggestion again without scope to write it where the term lives, or add_term with scope "${target}" if the user wants a separate ${target} copy.`,
        );
      }
      target ??= existing.scope;
    }
    // suggest_terms with `cwd` reads another repo, and its suggestions name
    // that repo's project file in `path`; this server writes only its own
    // project file, so applying one there edited a file the agent never
    // named to the user (or created a copy of the term in it).
    if (target === 'project' && suggestion.path !== undefined) {
      const here = resolvePaths({ cwd: ctx.cwd }).project ?? defaultProjectPath(ctx.cwd);
      if (resolve(suggestion.path) !== resolve(here)) {
        throw new Error(
          `this suggestion is for the project lexicon ${suggestion.path}, but this server writes the project lexicon at ${here}; nothing was written. ` +
            `The user can apply it in that repo with ${cliCommand(`suggest --cwd ${shellWord(dirname(suggestion.path))} --apply`)}, or call apply_suggestion with scope "global" if they want it in the global lexicon instead.`,
        );
      }
    }
    const storeOpts: StoreWriteOpts = { cwd: ctx.cwd, ...(target !== undefined ? { scope: target } : {}) };
    if (kind === 'stale') return { kind, canonical, target, storeOpts };
    if (kind === 'alias' && !alias) throw new Error('an "alias" suggestion needs an alias');
    if (kind === 'never' && !alias) throw new Error('a "never" suggestion needs an alias (the word to keep as written)');
    const listed = suggestion.aliases?.map((a) => a.trim()).filter((a) => a !== '') ?? [];
    const aliases = kind === 'never' ? [] : kind === 'alias' && alias ? [alias] : listed.length > 0 ? listed : alias ? [alias] : suggestAliases(canonical);
    const term: Term = {
      canonical,
      aliases,
      source: 'user',
      ...(kind === 'term' && suggestion.category !== undefined ? { category: suggestion.category } : {}),
      ...(kind === 'never' && alias ? { never: [alias] } : {}),
      ...(target !== undefined ? { scope: target } : {}),
    };
    return { kind, alias, term, storeOpts };
  }

  /** Removes a stale term from one file and names every file still holding it. */
  async function applyStale(p: PreparedStale, current: () => Promise<LoadedLexicon>): Promise<Record<string, unknown>> {
    const { kind, canonical, target } = p;
    // removeTerm edits one file (the project one first without a scope).
    // A term with a copy in both files keeps firing from the other copy,
    // so name every file still holding it rather than report it gone.
    const before = termHolders(await current(), canonical);
    const removed = await removeTerm(canonical, p.storeOpts);
    const after = termHolders(await load(), canonical);
    const from = before.find((b) => !after.some((a) => a.path === b.path));
    const stillIn = after.length > 0 ? { stillIn: after } : {};
    const head = removed ? `removed "${canonical}"${from ? ` from ${from.path}` : ''}` : `"${canonical}" was not in the ${target ?? 'global or project'} lexicon`;
    const tail = after
      .map((h) => `; it is still in the ${h.scope} lexicon (${h.path}): ask the user, then call apply_suggestion again with scope "${h.scope}" to remove that copy too`)
      .join('');
    return { kind, canonical, removed, ...(from ? { path: from.path } : {}), ...stillIn, summary: head + tail };
  }

  /** The result of one written alias, never or term suggestion. */
  function describeAdd(p: PreparedAdd, saved: { file: LexiconFile; term: Term; created: boolean }, writeOpts: { leaveUntrusted?: true }): Record<string, unknown> {
    const { kind, alias, term } = p;
    const untrusted = writeOpts.leaveUntrusted === true && saved.file.scope === 'project';
    // Merged into a term an untrusted file already had: show only what this call wrote.
    const shown = untrusted && !saved.created ? term : saved.term;
    const pending = untrusted ? untrustedWriteFields(saved.file.path, 'It') : undefined;
    const summary =
      (kind === 'alias'
        ? `"${alias}" -> "${shown.canonical}" saved`
        : kind === 'never'
          ? `"${alias}" will never be rewritten to "${shown.canonical}"`
          : saved.created
            ? `added "${shown.canonical}" (${aliasCount(shown.aliases.length)})`
            : // A 'term' whose canonical the lexicon already had merges into it; an
              // untrusted file's copy is not read back, so it has no count then.
              `merged into the existing "${shown.canonical}"${untrusted ? '' : ` (${aliasCount(shown.aliases.length)} now)`}`) +
      (pending ? `. ${pending.nextStep}` : '');
    // A copy, so a later merge into the same term in one batch cannot change a result already built.
    return { kind, canonical: shown.canonical, term: structuredClone(shown), path: saved.file.path, created: saved.created, ...(pending ?? {}), summary };
  }

  /**
   * `suggestions`: every add bound for the same file in a run of consecutive
   * suggestions is one addTerms call (one read and one write of that file);
   * a stale removal, or an add for the other file, ends the run, so the
   * writes keep the suggestions' order. A refused suggestion is a failure row
   * and the rest still apply.
   */
  async function applyMany(list: readonly Suggestion[], scope: TermScope | undefined) {
    const writeOpts = await mcpWriteOpts(ctx);
    const applied: Array<Record<string, unknown> & { index: number }> = [];
    const failures: Array<{ index: number; kind: Suggestion['kind']; canonical: string; error: string }> = [];
    const fail = (index: number, s: Suggestion, err: unknown) => failures.push({ index, kind: s.kind, canonical: s.canonical, error: errorMessage(err) });
    // One load for the checks until something is written.
    let cached: LoadedLexicon | undefined;
    const current = async (): Promise<LoadedLexicon> => (cached ??= await load());
    let run: Array<{ index: number; s: Suggestion; p: PreparedAdd }> = [];

    const flush = async (): Promise<void> => {
      if (run.length === 0) return;
      const batch = run;
      run = [];
      cached = undefined;
      const opts = { ...batch[0]!.p.storeOpts, ...writeOpts };
      try {
        const saved = await addTerms(
          batch.map((b) => b.p.term),
          opts,
        );
        batch.forEach((b, i) => {
          const r = saved.results[i]!;
          applied.push({ index: b.index, ...describeAdd(b.p, { file: saved.file, term: r.term, created: r.created }, writeOpts) });
        });
      } catch {
        // The batch wrote nothing. Retry one by one so the suggestions that
        // can be written are, and each failure names its own suggestion.
        for (const b of batch) {
          try {
            applied.push({ index: b.index, ...describeAdd(b.p, await addTerm(b.p.term, opts), writeOpts) });
          } catch (err) {
            fail(b.index, b.s, err);
          }
        }
      }
    };

    for (const [index, s] of list.entries()) {
      try {
        // An alias or never word for a term only an earlier suggestion of
        // this call adds must see that term, so write the run first.
        const key = s.canonical.trim().toLowerCase();
        const sameTerm = (t: Term): boolean => t.canonical.trim().toLowerCase() === key;
        if ((s.kind === 'alias' || s.kind === 'never') && run.some((b) => sameTerm(b.p.term)) && !(await current()).merged.terms.some(sameTerm)) {
          await flush();
        }
        const p = await prepareSuggestion(s, scope, current);
        if (p.kind === 'stale') {
          await flush();
          applied.push({ index, ...(await applyStale(p, current)) });
          cached = undefined;
          continue;
        }
        // No scope writes the global file, as addTerm does.
        const file = (q: PreparedAdd): TermScope => q.storeOpts.scope ?? 'global';
        if (run.length > 0 && file(run[0]!.p) !== file(p)) await flush();
        run.push({ index, s, p });
      } catch (err) {
        fail(index, s, err);
      }
    }
    await flush();
    applied.sort((a, b) => a.index - b.index);
    failures.sort((a, b) => a.index - b.index);
    const summary =
      `applied ${applied.length} of ${list.length} suggestion${list.length === 1 ? '' : 's'}` +
      (failures.length > 0 ? `; ${failures.length} not applied (first: ${failures[0]?.error}); see failures` : '');
    const payload = { count: list.length, applied, failures, summary };
    // Nothing applied: not a success the agent should report as done.
    if (applied.length === 0 && failures.length > 0) return { ...textResult(payload), isError: true };
    return textResult(payload);
  }
};
