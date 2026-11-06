/**
 * `lexicon terms` and `lexicon terms add`. `terms` is the `list` table under
 * the name a user looks for ("the terms"); `terms add` is the deterministic
 * add: a canonical plus the spellings it is heard as (--heard), none of
 * `add`'s suggested aliases, prompting or fallbacks, so the same line always
 * produces the same file and the same JSON. Idempotent through addTerm's
 * merge: a second identical run answers `unchanged`.
 */
import { addTerm, unchangedTermNote } from '../core/index.js';
import type { Term, TermScope } from '../core/index.js';
import { dryRunPlan } from './dry-run-plan.js';
import { bold, dim, fail, green, jsonOk, line, refuse, resolveCwd, safe, safeMessage } from './io.js';
import type { CommonOptions, IO } from './io.js';

export interface TermsAddOptions extends CommonOptions {
  /** Spellings STT writes for the term; at least one is required. */
  heard?: string[];
  /** Words that must also appear in the text for this term to apply. */
  context?: string[];
  project?: boolean;
  dryRun?: boolean;
  json?: boolean;
  /** Explicit global lexicon path (test hook, no CLI flag). */
  globalPath?: string;
}

export async function runTermsAdd(canonical: string, opts: TermsAddOptions, io: IO): Promise<number> {
  const trimmed = canonical.trim();
  if (!trimmed) throw new Error('canonical must not be empty');
  const heard = opts.heard ?? [];
  if (heard.length === 0) {
    return refuse(
      io,
      opts.json,
      'terms add needs at least one --heard <alias>',
      'pass the spelling STT writes, e.g. lexicon terms add locus --heard Lucas',
    );
  }
  const cwd = resolveCwd(opts);
  const scope: TermScope = opts.project ? 'project' : 'global';
  // Kept as given: addTerm cleans and dedupes them and refuses a blank one,
  // as MCP add_term and POST /add do.
  const term: Term = { canonical: trimmed, aliases: [...heard] };
  if (opts.context !== undefined && opts.context.length > 0) term.context = [...opts.context];

  try {
    const result = await addTerm(term, {
      scope,
      cwd,
      ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}),
      ...(opts.dryRun === true ? { dryRun: true } : {}),
    });
    const saved = result.term;
    if (opts.json) {
      line(
        io,
        JSON.stringify(
          jsonOk({
            ...dryRunPlan(opts.dryRun),
            term: saved,
            path: result.file.path,
            created: result.created,
            ...(result.unchanged ? { unchanged: true } : {}),
            scope,
          }),
        ),
      );
      return 0;
    }
    if (result.unchanged) {
      line(io, `${unchangedTermNote(safe(saved.canonical))} (${scope}: ${safeMessage(result.file.path)})`);
    } else if (opts.dryRun) {
      line(io, `would ${result.created ? 'create' : 'merge'} ${bold(safe(saved.canonical))} (${scope}) in ${safeMessage(result.file.path)}; nothing was written`);
    } else {
      line(io, `${result.created ? green('created') : green('merged')} ${bold(safe(saved.canonical))} (${scope}) in ${safeMessage(result.file.path)}`);
    }
    line(io, `aliases: ${saved.aliases.length > 0 ? safe(saved.aliases.join(', ')) : dim('(none)')}`);
    if (saved.context !== undefined && saved.context.length > 0) line(io, `context: ${safe(saved.context.join(', '))}`);
    if (scope === 'project' && !opts.dryRun) line(io, dim(`project lexicon trusted at its new content (${safeMessage(result.file.path)})`));
    if (scope === 'project' && opts.dryRun) line(io, dim(`a real run also re-pins the project lexicon's trust (${safeMessage(result.file.path)})`));
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}
