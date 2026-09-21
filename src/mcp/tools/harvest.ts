/**
 * Mining new terms: scanning the repo for names worth adding, proposing
 * what the lexicon should learn next, and applying one of those proposals.
 */
import { resolve } from 'node:path';
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
} from '../../core/index.js';
import type { Term, VoiceHistoryEntry } from '../../core/index.js';
import { errorMessage } from '../../util/errors.js';
import { SUGGESTION_KINDS, guarded, log, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';

export const registerHarvestTools: ToolRegistrar = (server, { cwd, load }) => {
  server.registerTool(
    'harvest_repo',
    {
      title: 'Harvest names from a repository',
      description:
        'Scan a repository for proper nouns an STT engine is likely to mangle: package and dependency names, git authors, README brands, the project directory. ' +
        'Only names the repo says somewhere other than its own source are proposed: a class that exists nowhere but code is something the user types, not something they say, and adding it teaches the lexicon to rewrite ordinary dictation. ' +
        'WHEN TO CALL: when you are in a repo with no .lexicon.yaml and the user dictates about it, or when they ask what this project ' +
        'would add. Call it without `add` first -- that is a read-only preview. ' +
        "WHAT IT CHANGES: nothing unless `add: true`, which writes the candidates into the repo's .lexicon.yaml and trusts that file. " +
        "That is a write inside the user's repository plus a trust decision, so show the candidate list and get a yes first. " +
        'WHAT IT WILL NOT DO: it does not touch the global lexicon, and it does not pull file contents into the conversation -- ' +
        'candidates come back as names, categories and counts.',
      inputSchema: {
        path: z.string().optional().describe('Repository root. Defaults to the server working directory.'),
        limit: z.number().int().positive().optional().describe('Max candidates to return (default 50).'),
        minCount: z.number().int().positive().optional().describe('Minimum occurrences for a candidate (default 2).'),
        add: z.boolean().optional().describe('When true, add every candidate to the project lexicon.'),
      },
    },
    async ({ path, limit, minCount, add }) =>
      guarded(async () => {
        const root = path ? resolve(cwd, path) : cwd;
        const candidates = await harvestRepo(root, {
          ...(limit !== undefined ? { limit } : {}),
          ...(minCount !== undefined ? { minCount } : {}),
        });
        let added = 0;
        const failures: Array<{ canonical: string; error: string }> = [];
        if (add) {
          for (const c of candidates) {
            try {
              // Write into the harvested repo's own project lexicon, not the server cwd.
              await addTerm(
                {
                  canonical: c.canonical,
                  aliases: c.suggestedAliases,
                  category: c.category,
                  source: c.source,
                  scope: 'project',
                },
                { cwd: root, scope: 'project' },
              );
              added += 1;
            } catch (err) {
              // Every remaining candidate would fail the same way; surface it
              // once as the tool error instead of N identical failure rows.
              if (isProjectTrustError(err)) throw err;
              failures.push({ canonical: c.canonical, error: errorMessage(err) });
            }
          }
        }
        return textResult({
          root,
          candidates,
          count: candidates.length,
          ...(add ? { added, failures } : {}),
        });
      }),
  );

  server.registerTool(
    'suggest_terms',
    {
      title: 'Propose lexicon improvements',
      description:
        "Propose new aliases, terms and never-words from the user's voice history, usage and repo. " +
        'Call weekly or when the user asks how to improve corrections; present them and apply accepted ones with apply_suggestion (or add_term). ' +
        "Each suggestion has kind 'alias' (a misspelling to add to an existing term), 'term' (a new name), 'never' (a word wrongly rewritten), or 'stale' (a term that never fires), plus reason, confidence and evidence.",
      inputSchema: {
        cwd: z.string().optional().describe('Repository to scan for evidence. Defaults to the server working directory.'),
        limit: z.number().int().positive().optional().describe('Max suggestions to return.'),
      },
    },
    async ({ cwd: cwdArg, limit }) =>
      guarded(async () => {
        const root = cwdArg ? resolve(cwd, cwdArg) : cwd;
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
        "'never' records the word as never-rewrite on the term, 'stale' removes the term. Pass the suggestion object back as received.",
      inputSchema: {
        suggestion: z.object({
          kind: z.enum(SUGGESTION_KINDS),
          canonical: z.string().min(1),
          alias: z.string().optional(),
          aliases: z.array(z.string()).optional(),
          category: z.enum(TERM_CATEGORIES).optional(),
          reason: z.string().optional(),
          confidence: z.number().optional(),
          evidence: z.array(z.string()).optional(),
          count: z.number().optional(),
        }),
        scope: z.enum(TERM_SCOPES).optional().describe("Where to write: 'global' (default) or 'project'."),
      },
    },
    async ({ suggestion, scope }) =>
      guarded(async () => {
        const { kind, canonical } = suggestion;
        const alias = suggestion.alias?.trim();
        const storeOpts = { cwd, ...(scope !== undefined ? { scope } : {}) };
        if (kind === 'stale') {
          const removed = await removeTerm(canonical, storeOpts);
          return textResult({ kind, canonical, removed, summary: removed ? `removed "${canonical}"` : `"${canonical}" was not in the lexicon` });
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
          ...(scope !== undefined ? { scope } : {}),
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
