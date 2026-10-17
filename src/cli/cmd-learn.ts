/**
 * `lexicon learn` and `lexicon stats`: record a spelling correction from the
 * command line (or from a pasted sentence) and report how the lexicon is used.
 * Handlers are exported for tests; registerLearnCommands() only wires commander.
 */
import type { Command } from 'commander';
import { CORRECTION_EXAMPLES, computeStats, learnCorrection, loadLexicon, parseCorrection } from '../core/index.js';
import type { Correction, LexiconStats, TermScope } from '../core/index.js';
import { fail, line, renderTable, resolveCwd, safe, warnSkippedProject } from './io.js';
import type { CommonOptions, IO } from './io.js';

/** On stderr: it follows an error, and stdout must stay parseable under --json. */
function usageHint(io: IO): void {
  io.stderr('usage: lexicon learn <heard> <meant>      e.g. lexicon learn Ashler Ashlr.AI\n');
  io.stderr('       lexicon learn --from "<sentence>"  supported phrasings:\n');
  for (const example of CORRECTION_EXAMPLES) io.stderr(`         ${example}\n`);
}

// ---------------------------------------------------------------------------
// learn
// ---------------------------------------------------------------------------

export interface LearnOptions extends CommonOptions {
  /** Write to the project .lexicon.yaml instead of the global file / the term's current file. */
  project?: boolean;
  /** A natural-language correction to parse instead of positional heard/meant. */
  from?: string;
  json?: boolean;
}

/**
 * Turn CLI words into a Correction. Two words are `<heard> <meant>`; anything
 * else is joined and parsed as a sentence ("Ashler -> Ashlr.AI", "it's X not Y").
 */
export function correctionFromArgs(words: readonly string[], from: string | undefined): Correction | undefined {
  if (from !== undefined) return parseCorrection(from);
  if (words.length === 2) return { heard: words[0], meant: words[1] };
  if (words.length === 0) return undefined;
  return parseCorrection(words.join(' '));
}

export async function runLearn(words: readonly string[], opts: LearnOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const correction = correctionFromArgs(words, opts.from);
  if (!correction) {
    const source = opts.from ?? words.join(' ');
    io.stderr(source ? `lexicon: could not find a correction in "${safe(source)}"\n` : 'lexicon: nothing to learn\n');
    usageHint(io);
    return 1;
  }
  if (!correction.heard) {
    io.stderr(
      `lexicon: "${safe(opts.from ?? words.join(' '))}" names the intended spelling (${safe(correction.meant)}) but not what was heard\n`,
    );
    io.stderr(`run: lexicon learn <heard> ${JSON.stringify(correction.meant)}\n`);
    return 1;
  }

  const scope: TermScope | undefined = opts.project ? 'project' : undefined;
  try {
    const result = await learnCorrection(correction, { cwd, ...(scope !== undefined ? { scope } : {}) });
    if (opts.json) {
      line(io, JSON.stringify({ ...result, heard: correction.heard, meant: correction.meant }, null, 2));
      return 0;
    }
    const what = result.created
      ? 'new term'
      : result.aliasAdded
        ? 'alias added'
        : 'already known';
    line(io, `learned ${safe(correction.heard)} -> ${safe(result.term.canonical)} (${what}) in ${safe(result.file.path)}`);
    line(io, `aliases: ${result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : '(none)'}`);
    const c = result.conflict;
    if (c) {
      line(
        io,
        c.as === 'alias'
          ? `warn: ${safe(c.spelling)} is also an alias of ${safe(c.canonical)} (${c.scope}), so it may still be corrected to that; to drop it: lexicon remove ${JSON.stringify(safe(c.canonical))} --alias ${JSON.stringify(safe(c.spelling))}`
          : `warn: ${safe(c.spelling)} is its own term (${c.scope}), so it may still be kept as written`,
      );
    }
    const u = result.untrustedProject;
    if (u) {
      line(
        io,
        `warn: the ${u.trust === 'changed' ? 'changed' : 'untrusted'} project lexicon ${safe(u.path)} also claims ${safe(correction.heard)} for another term; ` +
          'once trusted it wins over this correction. Review it with: lexicon trust',
      );
    }
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export interface StatsOptions extends CommonOptions {
  json?: boolean;
}

export function renderStats(stats: LexiconStats): string {
  const out: string[] = [];
  out.push(`terms: ${stats.termCount}   aliases: ${stats.aliasCount}   hits: ${stats.totalHits}`);
  const categories = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const sources = Object.entries(stats.bySource)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  if (categories) out.push(`by category: ${categories}`);
  if (sources) out.push(`by source: ${sources}`);
  out.push('');

  out.push('top terms');
  if (stats.topTerms.length === 0) {
    out.push('  (no hits yet. They are counted when normalize_transcript or the hook fixes something)');
  } else {
    out.push(
      renderTable(
        stats.topTerms.map((t) => [t.canonical, String(t.hits)]),
        ['canonical', 'hits'],
      ).trimEnd(),
    );
  }
  out.push('');

  out.push(`never hit (${stats.neverHitCount})`);
  const more = stats.neverHitCount - stats.neverHit.length;
  out.push(stats.neverHit.length > 0 ? `  ${safe(stats.neverHit.join(', '))}${more > 0 ? `, and ${more} more` : ''}` : '  (none)');
  out.push('');

  out.push('files');
  out.push(
    renderTable(stats.files.map((f) => [f.scope, f.path, `${f.terms} term${f.terms === 1 ? '' : 's'}`])).trimEnd(),
  );
  return `${out.join('\n')}\n`;
}

export async function runStats(opts: StatsOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const loaded = await loadLexicon({ cwd });
    // The counts leave a skipped project file out; say so, as lexicon_stats does.
    warnSkippedProject(loaded, io);
    const stats = computeStats(loaded);
    if (opts.json) {
      const skipped = loaded.skippedProject ? { projectTrust: loaded.projectTrust, skippedProject: loaded.skippedProject.path } : {};
      line(io, JSON.stringify({ ...stats, ...skipped }, null, 2));
    } else {
      io.stdout(renderStats(stats));
    }
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

export function registerLearnCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };

  program
    .command('learn')
    .description('record a spelling correction: what STT heard and what you meant')
    .argument('[words...]', '<heard> <meant>, or a sentence like "Ashler -> Ashlr.AI"')
    .option('--from <sentence>', 'parse a natural-language correction, e.g. "it\'s Ashlr.AI not Ashler"')
    .option('--project', 'write to the project lexicon instead of the global one')
    .option('--json', 'print the result as JSON')
    // A bare "->" would otherwise be rejected as an unknown option; let it through
    // as a word so `lexicon learn Ashler -> Ashlr.AI` works without `--`.
    .allowUnknownOption()
    .action(async (words: string[], opts: LearnOptions) => done(await runLearn(words, { ...opts, ...globals() }, io)));

  program
    .command('stats')
    .description('show term/alias counts, most-used terms and terms that never fired')
    .option('--json', 'print the stats as JSON')
    .action(async (opts: StatsOptions) => done(await runStats({ ...opts, ...globals() }, io)));
}
