/**
 * Mining new terms: scanning the repo for names worth adding, proposing
 * what the lexicon should learn next, and applying one of those proposals.
 */
import { z } from 'zod';
import {
  TERM_CATEGORIES,
  TERM_SCOPES,
  addTerm,
  harvestRepo,
  isProjectTrustError,
  loadLexicon,
  loadVoiceHistory,
  removeTerm,
  suggestAliases,
  suggestTerms,
  termHolders,
} from '../../core/index.js';
import type { Term, VoiceHistoryEntry } from '../../core/index.js';
import { errorMessage } from '../../util/errors.js';
import { HARVEST_ROOTS_ENV, SUGGESTION_KINDS, containedPath, guarded, log, nonBlank, shellWord, textResult } from '../shared.js';
import { cliCommand } from '../../util/cli-hint.js';
import type { ToolRegistrar } from '../shared.js';

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
        "WHAT IT CHANGES: nothing unless `add: true`, which writes the candidates into the repo's .lexicon.yaml but does not trust it: " +
        'the file applies only after the user reviews it and runs ' + cliCommand('trust') + ', so show the candidate list and get a yes first, then relay `nextStep`. ' +
        `\`path\` must be inside the server directory, its git root, a client root or ${HARVEST_ROOTS_ENV}; anything else is refused. ` +
        'WHAT IT WILL NOT DO: it does not touch the global lexicon, and it does not pull file contents into the conversation -- ' +
        'candidates come back as names, categories and counts.',
      inputSchema: {
        path: z.string().optional().describe(`Repository root. Defaults to the server working directory. Must be inside it, its git root, a client root or ${HARVEST_ROOTS_ENV}.`),
        limit: z.number().int().positive().optional().describe('Max candidates to return (default 50).'),
        minCount: z.number().int().positive().optional().describe('Minimum occurrences for a candidate (default 2).'),
        add: z.boolean().optional().describe('When true, add every candidate to the project lexicon, left untrusted for the user to review.'),
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
        if (add) {
          for (const c of candidates) {
            try {
              // Write into the harvested repo's own project lexicon, not the
              // server cwd, and never trust it: a model chose these names,
              // and trusting a project file is the user's call (lexicon trust).
              const saved = await addTerm(
                {
                  canonical: c.canonical,
                  aliases: c.suggestedAliases,
                  category: c.category,
                  source: c.source,
                  scope: 'project',
                },
                { cwd: root, scope: 'project', leaveUntrusted: true },
              );
              written = saved.file.path;
              added += 1;
            } catch (err) {
              // Every remaining candidate would fail the same way; surface it
              // once as the tool error instead of N identical failure rows.
              if (isProjectTrustError(err)) throw err;
              failures.push({ canonical: c.canonical, error: errorMessage(err) });
            }
          }
        }
        const payload = {
          root,
          candidates,
          count: candidates.length,
          ...(add ? { added, failures } : {}),
          ...(written !== undefined
            ? {
                path: written,
                trusted: false,
                nextStep:
                  `${added} name(s) were written to ${written}, which is not trusted, so they do not apply yet. ` +
                  `Ask the user to review the file and run ${cliCommand('trust')} in a terminal in that repo (it previews the file first), ` +
                  'or call trust_project with action "trust", which asks them directly.',
              }
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
        "and `scope` and `path`: the lexicon file applying it would write (where the term lives, or the global file for a new term). Name that file when you present a suggestion.",
      inputSchema: {
        cwd: z.string().optional().describe(`Repository to scan for evidence. Defaults to the server working directory. Must be inside it, its git root, a client root or ${HARVEST_ROOTS_ENV}.`),
        limit: z.number().int().positive().optional().describe('Max suggestions to return.'),
      },
    },
    async ({ cwd: cwdArg, limit }) =>
      guarded(async () => {
        const root = cwdArg ? containedPath(ctx, cwdArg, (dir) => `suggest --cwd ${shellWord(dir)}`) : ctx.cwd;
        const loaded = await loadLexicon({ cwd: root });
        const history: VoiceHistoryEntry[] = await loadVoiceHistory(loaded.global.path).catch((err: unknown) => {
          log('loadVoiceHistory failed:', errorMessage(err));
          return [];
        });
        const suggestions = await suggestTerms({ loaded, history, cwd: root, ...(limit !== undefined ? { limit } : {}) });
        return textResult(suggestions);
      }),
  );

  server.registerTool(
    'apply_suggestion',
    {
      title: 'Apply one suggestion',
      description:
        "Apply a suggestion returned by suggest_terms after the user accepted it: 'alias' merges the alias into the term, 'term' adds the term (aliases auto-suggested when none given), " +
        "'never' records the word as never-rewrite on the term, 'stale' removes the term from one lexicon file (the suggestion's `scope`, else project first); " +
        'when the term also has a copy in the other file the result lists it in `stillIn` and that copy keeps correcting until removed with its own scope. ' +
        'Pass the suggestion object back as received.',
      inputSchema: {
        suggestion: z.object({
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
        }),
        scope: z
          .enum(TERM_SCOPES)
          .optional()
          .describe(
            "Where to write: 'global' or 'project'. Omitted: where the term already lives for 'alias' and 'never', else 'global'. An 'alias' or 'never' scope must name a file that holds the term; one that does not is refused, as it would create a copy.",
          ),
      },
    },
    async ({ suggestion, scope }) =>
      guarded(async () => {
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
          const current = await load();
          const existing = current.merged.terms.find((t) => t.canonical.trim().toLowerCase() === key);
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
          const holders = termHolders(current, canonical);
          if (target !== undefined && target !== existing.scope && !holders.some((h) => h.scope === target)) {
            const where = holders.map((h) => `${h.scope} lexicon (${h.path})`).join(' and ') || `${existing.scope} lexicon`;
            throw new Error(
              `"${existing.canonical}" is in the ${where}, not the ${target} one, so this ${kind === 'alias' ? 'alias' : 'never word'} would create a copy of the term there; nothing was written. ` +
                `Call apply_suggestion again without scope to write it where the term lives, or add_term with scope "${target}" if the user wants a separate ${target} copy.`,
            );
          }
          target ??= existing.scope;
        }
        const storeOpts = { cwd: ctx.cwd, ...(target !== undefined ? { scope: target } : {}) };
        if (kind === 'stale') {
          // removeTerm edits one file (the project one first without a scope).
          // A term with a copy in both files keeps firing from the other copy,
          // so name every file still holding it rather than report it gone.
          const before = termHolders(await load(), canonical);
          const removed = await removeTerm(canonical, storeOpts);
          const after = termHolders(await load(), canonical);
          const from = before.find((b) => !after.some((a) => a.path === b.path));
          const stillIn = after.length > 0 ? { stillIn: after } : {};
          const head = removed ? `removed "${canonical}"${from ? ` from ${from.path}` : ''}` : `"${canonical}" was not in the ${target ?? 'global or project'} lexicon`;
          const tail = after
            .map((h) => `; it is still in the ${h.scope} lexicon (${h.path}): ask the user, then call apply_suggestion again with scope "${h.scope}" to remove that copy too`)
            .join('');
          return textResult({ kind, canonical, removed, ...(from ? { path: from.path } : {}), ...stillIn, summary: head + tail });
        }
        if ((kind === 'alias' || kind === 'never') && !alias) throw new Error(`a "${kind}" suggestion needs an alias`);
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
        const saved = await addTerm(term, storeOpts);
        const summary =
          kind === 'alias'
            ? `"${alias}" -> "${saved.term.canonical}" saved`
            : kind === 'never'
              ? `"${alias}" will never be rewritten to "${saved.term.canonical}"`
              : `added "${saved.term.canonical}" (${saved.term.aliases.length} alias${saved.term.aliases.length === 1 ? '' : 'es'})`;
        return textResult({ kind, canonical: saved.term.canonical, term: saved.term, path: saved.file.path, created: saved.created, summary });
      }),
  );
};
