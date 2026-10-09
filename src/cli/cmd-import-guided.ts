/**
 * `lexicon import --guided`: the vocabulary import wizard. "Where do your
 * proper nouns live?" Each source the user checks is harvested for candidate
 * terms, which are approved one screen at a time before anything is written,
 * exactly like the repo harvest review. Nothing is read until the user opts
 * that source in, and every source's checklist line states what it reads:
 * the wizard never touches contacts, calendars or GitHub on a default.
 *
 * Non-interactive use is explicit on purpose: `--yes` requires `--sources`
 * (reading someone's address book because a flag defaulted that way would be
 * the opposite of this command's privacy posture), and `--dry-run` previews
 * the candidates without writing.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import {
  IMPLEMENTED_IMPORT_SOURCES,
  TERM_CATEGORIES,
  applyImportCandidates,
  emptyLexicon,
  getImportSource,
  harvestImportSources,
  isTrusted,
  listImportSources,
  resolveImportSourceDeps,
  resolvePaths,
} from '../core/index.js';
import type {
  HarvestCandidate,
  VocabImportSource,
  ImportSourceDeps,
  ImportSourceId,
  TermCategory,
} from '../core/index.js';
import { ProjectTrustError } from '../core/index.js';
import { bold, dim, fail, line, plural, resolveCwd, safe, safeLines } from './io.js';
import type { CommonOptions, IO } from './io.js';
import { askKey, createPrompter, isInteractive, splitList } from './prompt.js';
import type { Prompter } from './prompt.js';

export interface ImportGuidedOptions extends CommonOptions {
  /** Set by --guided on the import command: run the wizard instead of reading a file. */
  guided?: boolean;
  /** Comma-separated source ids (contacts, calendar, github). Default: every available source. */
  sources?: string;
  /** Max candidates to review. Default 50. */
  limit?: string;
  /** Print the candidates without writing. */
  dryRun?: boolean;
  /** Write to the project lexicon instead of the global one. */
  project?: boolean;
  /** Take every default without prompting; requires --sources. */
  yes?: boolean;
  /** Treat <dir> as the home directory (mainly for tests). */
  home?: string;
  /** Print the result as JSON (a preview unless --yes --sources are also passed). */
  json?: boolean;
  /** Override the global lexicon path (mainly for tests). */
  globalPath?: string;
}

export interface ImportGuidedDeps extends ImportSourceDeps {
  createPrompter?: () => Prompter;
  isInteractive?: () => boolean;
}

export interface ImportGuidedReport {
  sources: { id: ImportSourceId; label: string; available: boolean; reason?: string; chosen: boolean }[];
  candidates: { canonical: string; category: TermCategory; source: string; aliases: string[]; evidence: string[]; count: number; accepted?: boolean }[];
  dryRun: boolean;
  added: number;
  merged: number;
  skipped: number;
  path?: string;
}

const REVIEW_KEYS = ['y', 'n', 'e', 'c', 'a', 'q'] as const;

function parseSourceList(value: string | undefined): ImportSourceId[] {
  if (value === undefined) return [...IMPLEMENTED_IMPORT_SOURCES];
  const ids = splitList(value).map((s) => s.toLowerCase());
  // getImportSource throws on an unknown id with the expected list.
  return ids.map((id) => getImportSource(id).id);
}

function showImportCandidate(io: IO, c: HarvestCandidate, index: number, total: number): void {
  line(io, `${dim(`[${index + 1}/${total}]`)} ${bold(safe(c.canonical))}  ${dim(`${c.category}, seen ${c.count}x, from ${c.source}`)}`);
  line(io, `  evidence: ${c.evidence.length > 0 ? safe(c.evidence.slice(0, 3).join(', ')) : dim('(none)')}`);
  line(io, `  aliases:  ${c.suggestedAliases.length > 0 ? safe(c.suggestedAliases.join(', ')) : dim('(none)')}`);
}

async function askCategory(prompter: Prompter, def: TermCategory): Promise<TermCategory> {
  for (;;) {
    const answer = (await prompter.ask(`  category (${TERM_CATEGORIES.join('|')})`, { default: def })).trim().toLowerCase();
    if ((TERM_CATEGORIES as readonly string[]).includes(answer)) return answer as TermCategory;
  }
}

function sourceDeps(opts: ImportGuidedOptions, deps: ImportGuidedDeps): Required<ImportSourceDeps> {
  const home = opts.home ? opts.home : (deps.home ?? os.homedir());
  return resolveImportSourceDeps({ ...deps, home });
}

/**
 * The testable handler behind `lexicon import --guided`. Returns the exit
 * code; the report is printed as JSON under `opts.json`.
 */
export async function runImportGuided(
  opts: ImportGuidedOptions,
  io: IO,
  deps: ImportGuidedDeps = {},
): Promise<number> {
  const cwd = resolveCwd(opts);
  const storeOpts = { cwd, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) };
  const sdeps = sourceDeps(opts, deps);
  let wanted: ImportSourceId[];
  try {
    wanted = parseSourceList(opts.sources);
  } catch (err) {
    return fail(io, err);
  }
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : 50;
  if (!Number.isInteger(limit) || limit < 0) {
    io.stderr(`lexicon: --limit must be a non-negative integer, got "${safe(opts.limit ?? '')}"\n`);
    return 1;
  }

  // Availability first, so the checklist only offers what can actually run.
  const sources: VocabImportSource[] = listImportSources();
  const availability = new Map<ImportSourceId, { available: boolean; reason?: string }>();
  for (const s of sources) availability.set(s.id, await s.checkAvailable(sdeps));

  const report: ImportGuidedReport = {
    sources: sources.map((s) => ({
      id: s.id,
      label: s.label,
      available: availability.get(s.id)?.available ?? false,
      ...(availability.get(s.id)?.reason ? { reason: availability.get(s.id)?.reason } : {}),
      chosen: false,
    })),
    candidates: [],
    dryRun: false,
    added: 0,
    merged: 0,
    skipped: 0,
  };

  const interactive = !opts.yes && !opts.json && (deps.isInteractive ?? isInteractive)();
  if (!interactive && !opts.yes && !opts.dryRun && !opts.json) {
    io.stderr('lexicon: not a terminal. Pass --sources <list> with --yes to import non-interactively, or --dry-run to preview the candidates.\n');
    return 1;
  }
  if (opts.yes && opts.sources === undefined && !opts.dryRun && !opts.json) {
    // The privacy posture, stated as a flag rule: reading contacts, calendars
    // or GitHub because a default said so would be exactly the access this
    // command promises to ask about first.
    io.stderr('lexicon: --yes needs --sources <list> (contacts, calendar, github): the wizard never reads your address book, calendars or GitHub on a default.\n');
    return 1;
  }

  const implemented = sources.filter((s) => s.implemented);
  const unavailableChosen = wanted.filter((id) => !(availability.get(id)?.available ?? false));
  for (const id of unavailableChosen) {
    const s = implemented.find((x) => x.id === id) ?? sources.find((x) => x.id === id);
    const reason = availability.get(id)?.reason ?? 'unavailable';
    if (!opts.json) line(io, dim(`${s?.label ?? id}: skipped (${reason})`));
  }
  let chosen = wanted.filter((id) => availability.get(id)?.available ?? false);

  if (interactive) {
    if (!opts.json) {
      for (const s of sources.filter((x) => !x.implemented)) {
        line(io, dim(`${s.label}: ${availability.get(s.id)?.reason ?? 'not supported yet'}`));
      }
    }
    const offer = implemented.filter((s) => availability.get(s.id)?.available);
    if (offer.length === 0) {
      io.stderr('lexicon: no import source is available on this machine (need macOS Contacts/Calendar, or gh auth login).\n');
      return 1;
    }
    const prompter = deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout }));
    const p = prompter();
    try {
      line(io, bold('Where do your proper nouns live?'));
      for (const s of offer) line(io, dim(`   ${s.label}: ${s.privacy}`));
      line(io);
      const picked = await p.choose(
        'sources to import from',
        offer.map((s) => ({ label: `${s.label}`, value: s.id })),
        { multi: true },
      );
      chosen = picked;
      report.sources.forEach((r) => { r.chosen = chosen.includes(r.id); });
      if (chosen.length === 0) {
        line(io, dim('nothing chosen; nothing imported.'));
        return 0;
      }
    } finally {
      if (!deps.createPrompter) p.close();
    }
  } else {
    report.sources.forEach((r) => { r.chosen = chosen.includes(r.id); });
  }

  if (chosen.length === 0) {
    if (!opts.json) line(io, dim('no usable import source selected; nothing imported.'));
    else io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const scope = opts.project ? 'project' : 'global';
  // Check the trust gate up front so the user is not asked twenty questions
  // only to have the first write refused.
  if (opts.project && !opts.dryRun) {
    const projectPath = resolvePaths({ cwd }).project;
    if (projectPath && existsSync(projectPath)) {
      const status = await isTrusted({ path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true }, { cwd });
      if (status !== 'trusted') {
        io.stderr(`lexicon: ${safeLines(new ProjectTrustError(projectPath, status).message)}\n`);
        return 1;
      }
    }
  }

  const candidates = await harvestImportSources(chosen, sdeps, { limit });
  report.candidates = candidates.map((c) => ({
    canonical: c.canonical,
    category: c.category,
    source: c.source,
    aliases: c.suggestedAliases,
    evidence: c.evidence,
    count: c.count,
  }));

  const dryRun = (opts.dryRun ?? false) || Boolean(opts.json && !opts.yes);
  report.dryRun = dryRun;
  if (candidates.length === 0) {
    if (opts.json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else line(io, dim('no candidates found in the chosen sources.'));
    return 0;
  }

  if (dryRun) {
    if (opts.json) {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      line(io, bold(`dry run: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} (nothing written)`));
      candidates.forEach((c, i) => showImportCandidate(io, c, i, candidates.length));
    }
    return 0;
  }

  // Approve-each screen, the same y/n/e/c/a/q shape as the repo harvest review.
  const work: HarvestCandidate[] = candidates.map((c) => ({ ...c, suggestedAliases: [...c.suggestedAliases] }));
  const accepted: HarvestCandidate[] = [];
  let skipped = 0;
  if (interactive) {
    const prompter = deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout }));
    const p = prompter();
    try {
      line(io, `${bold(`${work.length} candidate${work.length === 1 ? '' : 's'}`)} ${dim('from your sources. y adds, n skips, e edits aliases, c changes the category, a adds all remaining, q quits.')}`);
      line(io);
      let addAll = false;
      let quit = false;
      for (let i = 0; i < work.length && !quit; i += 1) {
        const c = work[i];
        if (addAll) {
          accepted.push(c);
          continue;
        }
        showImportCandidate(io, c, i, work.length);
        let decided = false;
        while (!decided) {
          const key = await askKey(p, `  add? ${dim('[y/n/e/c/a/q]')}`, REVIEW_KEYS, 'y');
          switch (key) {
            case 'y':
              accepted.push(c);
              decided = true;
              break;
            case 'n':
              skipped += 1;
              decided = true;
              break;
            case 'e': {
              const answer = await p.ask('  aliases (comma-separated, replaces the suggestions)', {
                default: c.suggestedAliases.join(', '),
              });
              c.suggestedAliases = splitList(answer).filter((a) => a.toLowerCase() !== c.canonical.toLowerCase());
              line(io, `  aliases:  ${c.suggestedAliases.length > 0 ? safe(c.suggestedAliases.join(', ')) : dim('(none)')}`);
              break;
            }
            case 'c':
              c.category = await askCategory(p, c.category);
              line(io, `  category: ${c.category}`);
              break;
            case 'a':
              addAll = true;
              accepted.push(c);
              decided = true;
              break;
            case 'q':
              quit = true;
              skipped += work.length - i;
              decided = true;
              break;
            default:
              break;
          }
        }
      }
    } finally {
      if (!deps.createPrompter) p.close();
    }
  } else {
    // --yes with --sources: every candidate is accepted, because the user
    // named the sources explicitly.
    accepted.push(...work);
  }

  let result;
  try {
    result = await applyImportCandidates(accepted, { ...storeOpts, scope });
  } catch (err) {
    return fail(io, err);
  }
  report.added = result.added;
  report.merged = result.merged;
  report.skipped = skipped + result.skipped;
  if (result.path) report.path = result.path;
  report.candidates.forEach((c) => {
    c.accepted = accepted.some((a) => a.canonical.toLowerCase() === c.canonical.toLowerCase());
  });

  if (opts.json) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    line(io);
    line(io, `imported ${plural(result.added + result.merged, 'term')} (${result.added} new, ${result.merged} merged, ${report.skipped} skipped)${result.path ? ` into ${safe(result.path)}` : ''}`);
  }
  return 0;
}
