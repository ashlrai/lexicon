/**
 * `lexicon learn` and `lexicon stats`: record a spelling correction from the
 * command line (or from a pasted sentence) and report how the lexicon is used.
 * Handlers are exported for tests; registerLearnCommands() only wires commander.
 */
import type { Command } from 'commander';
import { CORRECTION_EXAMPLES, compareText, computeStats, conflictNote, emptyStatsNote, learnCorrection, learnUnchangedNote, loadLexicon, parseCorrection } from '../core/index.js';
import type { Correction, LexiconStats, LoadedLexicon, TermScope } from '../core/index.js';
import { conflictLine, fail, jsonOk, line, printJsonError, refuse, renderTable, resolveCwd, safe, safeMessage, shownCommand, shownWord, skippedProjectJson, warnSkippedProject } from './io.js';
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

/**
 * `lexicon learn <word> <meant>` or `lexicon learn <heard> <meant>` with the
 * known words quoted for this platform's shell (shownCommand) and the
 * placeholder left as written. JSON quoting left a `$` or a backtick in a
 * spelling for a POSIX shell to expand, and is not how PowerShell quotes.
 */
function learnCommand(heard: string | undefined, meant: string | undefined): string {
  const head = shownCommand(['lexicon', 'learn', ...(heard !== undefined ? [heard] : [])]);
  return `${heard === undefined ? `${head} <heard>` : head} ${meant === undefined ? '<meant>' : shownWord(meant)}`;
}

/**
 * `lexicon learn Ashler`: the error and next step for a single spelling. The
 * wording matches MCP learn_correction called with `heard` and no `meant`.
 * Exported for tests.
 */
export function oneSpellingRefusal(word: string): [error: string, nextStep: string] {
  const spelling = word.trim().replace(/\s+/g, ' ');
  return [
    `only one spelling was given ("${spelling}"); learn needs the spelling STT wrote and the one you meant, so nothing was learned`,
    `run: ${learnCommand(spelling, undefined)}, where <meant> is the spelling you want`,
  ];
}

/**
 * The refusal for a sentence shaped like a correction whose bare sides do not
 * look or sound alike (`spellingsAlike` false). Exported for tests.
 */
export function unrelatedCorrectionError(heard: string, meant: string): string {
  return `"${heard}" and "${meant}" neither look nor sound alike, so this reads as a change of meaning, not a spelling speech-to-text got wrong; nothing was learned`;
}

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

/** `parseCorrection` of `source` with the loaded lexicon; undefined when it reads nothing or the lexicon will not load. */
async function correctionWithLexicon(source: string, cwd: string): Promise<Correction | undefined> {
  if (parseCorrection(source, { allowUnrelated: true }) === undefined) return undefined;
  try {
    const loaded = await loadLexicon({ cwd, parseSkipped: false });
    return parseCorrection(source, { lexicon: loaded.merged });
  } catch {
    return undefined;
  }
}

/**
 * A word that reads as a command-line option (`--dry-run`, `-n`, `--scope=project`).
 * `learn` allows unknown options so a bare `->` passes as a word, which also let
 * a mistyped or unsupported flag through as the heard spelling: `lexicon learn
 * --dry-run Ashlr.AI` saved `--dry-run` as an alias. No STT spelling starts with
 * a dash followed by a letter; the arrows (`->`, `=>`) do not match.
 */
export function optionLikeWord(words: readonly string[]): string | undefined {
  return words.find((w) => /^--?[\p{L}]/u.test(w));
}

export async function runLearn(words: readonly string[], opts: LearnOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  const option = optionLikeWord(words);
  if (option !== undefined) {
    const error = `unknown option '${option}'; nothing was learned`;
    const nextStep = 'see the usage: lexicon learn --help (learn takes --from, --project and --json)';
    if (opts.json) printJsonError(io, error, nextStep);
    io.stderr(`lexicon: unknown option '${safe(option)}'; nothing was learned\n`);
    io.stderr(`lexicon: ${nextStep}\n`);
    return 1;
  }
  if (opts.from !== undefined && words.length > 0) {
    // Learned from --from alone, the words were dropped without a word, so
    // `lexicon learn Ashler Ashlr.AI --from "..."` never learned Ashler.
    return refuse(
      io,
      opts.json,
      `--from and the words ${shownCommand(words)} were both given; learn takes one correction, so nothing was learned`,
      'pass either <heard> <meant> or --from "<sentence>", not both',
    );
  }
  let correction = correctionFromArgs(words, opts.from);
  if (!correction && (opts.from !== undefined || (words.length > 0 && words.length !== 2))) {
    // A name the lexicon already holds, written by sound ("it's Niamh not
    // Neve" with Niamh a term): parseCorrection takes it with the lexicon.
    correction = await correctionWithLexicon(opts.from ?? words.join(' '), cwd);
  }
  if (!correction && opts.from === undefined && words.length === 1 && words[0].trim() !== '') {
    // One word is one spelling, not a sentence that failed to parse: it said
    // `could not find a correction in "Ashler"` and dumped the whole usage.
    // MCP learn_correction without `meant` names the same missing half.
    const [error, nextStep] = oneSpellingRefusal(words[0]);
    return refuse(io, opts.json, error, nextStep);
  }
  if (!correction) {
    const source = opts.from ?? words.join(' ');
    // The shape of a correction whose two sides neither look nor sound alike
    // ("it's the API not the UI"): say so, and how to learn it on purpose,
    // rather than "could not find a correction" and the usage examples.
    const unrelated = source ? parseCorrection(source, { allowUnrelated: true }) : undefined;
    if (unrelated?.heard) {
      return refuse(io, opts.json, unrelatedCorrectionError(unrelated.heard, unrelated.meant), `if speech-to-text really writes "${unrelated.heard}" for "${unrelated.meant}", run: ${learnCommand(unrelated.heard, unrelated.meant)}`);
    }
    if (opts.json) {
      printJsonError(io, source ? `could not find a correction in "${source}"` : 'nothing to learn', 'run: lexicon learn <heard> <meant>, or lexicon learn --from "<sentence>"');
    }
    io.stderr(source ? `lexicon: could not find a correction in "${safe(source)}"\n` : 'lexicon: nothing to learn\n');
    usageHint(io);
    return 1;
  }
  if (!correction.heard) {
    if (opts.json) {
      printJsonError(
        io,
        `"${opts.from ?? words.join(' ')}" names the intended spelling (${correction.meant}) but not what was heard`,
        `run: ${learnCommand(undefined, correction.meant)}`,
      );
    }
    io.stderr(
      `lexicon: "${safe(opts.from ?? words.join(' '))}" names the intended spelling (${safe(correction.meant)}) but not what was heard\n`,
    );
    io.stderr(`run: ${learnCommand(undefined, correction.meant)}\n`);
    return 1;
  }
  // The same spelling twice: learnCorrection refuses it with only an error, so
  // `--json` left a script without the step every other learn refusal names.
  // Normalized as learnCorrection does (trim, collapse whitespace); the error
  // text is the core's.
  const heardNorm = correction.heard.trim().replace(/\s+/g, ' ');
  const meantNorm = correction.meant.trim().replace(/\s+/g, ' ');
  if (meantNorm && heardNorm === meantNorm) {
    const error = `"${heardNorm}" and "${meantNorm}" are the same spelling; nothing to learn`;
    const nextStep = `run: ${learnCommand(undefined, meantNorm)}, where <heard> is the misspelling STT wrote`;
    if (opts.json) printJsonError(io, error, nextStep);
    io.stderr(`lexicon: ${safe(error)}\n`);
    io.stderr(`lexicon: ${safe(nextStep)}\n`);
    return 1;
  }

  const scope: TermScope | undefined = opts.project ? 'project' : undefined;
  try {
    const result = await learnCorrection(correction, { cwd, ...(scope !== undefined ? { scope } : {}) });
    if (opts.json) {
      // The keys MCP learn_correction returns, plus heard and meant. `file`
      // keeps only its path and scope: the whole file's terms do not belong
      // in a one-correction result.
      // A conflict comes with the `note` naming the scoped remove command, as
      // `add --json` and the MCP summary do.
      // Nothing written (heard was already an alias, or the canonical in
      // another case): `unchanged: true` and the note POST /learn gives, so
      // two false flags are not read as a failure or a merge.
      const { file, ...rest } = result;
      const unchanged = !result.created && !result.aliasAdded;
      const notes = [
        ...(unchanged ? [learnUnchangedNote(correction.heard, result.term.canonical, { meant: correction.meant, scope: file.scope })] : []),
        ...(result.conflict ? [conflictNote([result.conflict])] : []),
      ];
      line(
        io,
        JSON.stringify(
          jsonOk({
            ...rest,
            path: file.path,
            file: { path: file.path, scope: file.scope },
            heard: correction.heard,
            meant: correction.meant,
            ...(unchanged ? { unchanged: true } : {}),
            ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    if (!result.created && !result.aliasAdded) {
      // It said "learned X -> Y (already known)", which reads as a write.
      line(io, `${learnUnchangedNote(safe(correction.heard), safe(result.term.canonical), { meant: safe(correction.meant), scope: result.file.scope })} (${result.file.scope}: ${safeMessage(result.file.path)})`);
    } else {
      line(io, `learned ${safe(correction.heard)} -> ${safe(result.term.canonical)} (${result.created ? 'new term' : 'alias added'}) in ${safeMessage(result.file.path)}`);
    }
    line(io, `aliases: ${result.term.aliases.length > 0 ? safe(result.term.aliases.join(', ')) : '(none)'}`);
    if (result.conflict) line(io, conflictLine(result.conflict));
    const u = result.untrustedProject;
    if (u) {
      line(
        io,
        `warn: the ${u.trust === 'changed' ? 'changed' : 'untrusted'} project lexicon ${safeMessage(u.path)} also claims ${safe(correction.heard)} for another term; ` +
          'once trusted it wins over this correction. Review it with: lexicon trust',
      );
    }
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

export interface StatsOptions extends CommonOptions {
  json?: boolean;
}

export function renderStats(stats: LexiconStats, note?: string): string {
  const out: string[] = [];
  out.push(`terms: ${stats.termCount}   aliases: ${stats.aliasCount}   hits: ${stats.totalHits}`);
  if (note) out.push(safe(note));
  const categories = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const sources = Object.entries(stats.bySource)
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  if (categories) out.push(`by category: ${categories}`);
  if (sources) out.push(`by source: ${sources}`);
  out.push('');

  out.push('top terms');
  if (stats.topTerms.length === 0) {
    // `lexicon normalize` is a filter and counts nothing, so naming it sent a
    // user who tried it to a stats report that never moved.
    out.push('  (no hits yet. They are counted when the prompt hook, the MCP server, lexicon voice, the clipboard daemon or lexicon serve fixes something; lexicon normalize does not count)');
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
  // Each name made safe on its own: the joined list went through the
  // 200-character display cap, so 20 longer names were cut off mid-list with
  // an ellipsis and `and N more` then undercounted what was not shown.
  out.push(stats.neverHit.length > 0 ? `  ${stats.neverHit.map(safe).join(', ')}${more > 0 ? `, and ${more} more` : ''}` : '  (none)');
  out.push('');

  out.push('files');
  out.push(
    renderTable(stats.files.map((f) => [f.scope, f.path, `${f.terms} term${f.terms === 1 ? '' : 's'}`]), undefined, { pathColumns: [1] }).trimEnd(),
  );
  return `${out.join('\n')}\n`;
}

export async function runStats(opts: StatsOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const loaded = await loadLexicon({ cwd, parseSkipped: false });
    // The counts leave a skipped project file out; say so, as lexicon_stats does.
    warnSkippedProject(loaded, io);
    const stats = computeStats(loaded);
    const empty = emptyStatsNote(loaded);
    if (opts.json) {
      line(io, JSON.stringify(jsonOk({ ...stats, ...skippedProjectJson(loaded), ...(empty ? { note: empty } : {}) }), null, 2));
    } else {
      io.stdout(renderStats(stats, empty));
    }
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
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
    .option('--from <sentence>', 'parse a natural-language correction, e.g. "it\'s Ashlr.AI not Ashler" (instead of <heard> <meant>, not with them)')
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
