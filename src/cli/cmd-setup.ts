/**
 * `lexicon setup`: the one command a new user runs. Walks through seven steps,
 * each printing a one-line result, and never re-implements an installer:
 *
 *   a. global lexicon (runInit) seeded with the git user as a person term and
 *      the company/product name (suggested from the cwd package scope or the
 *      git remote org) with suggested aliases and an optional phonetic hint
 *   b. starter packs (core/packs.ts): a checklist with developer, ai and
 *      voice-tools checked and the rest offered, one yes/no each;
 *      `--packs a,b` / `--no-packs`
 *   c. repo harvest into the project lexicon (top 10, min-count 5)
 *   d. agent clients detected on this machine, installed via runInstall
 *   e. the local API as a login service via runServeInstall
 *   f. an export for the user's dictation app, written to ~/Desktop
 *   g. a live demonstration: the sentence STT would have produced for the
 *      terms just seeded, and the same sentence after normalize() ran
 *   h. a summary card ending in the single next thing to do (or JSON with
 *      --json, which carries the demonstration as `demo`)
 *
 * Interactive on a terminal (prompt.ts); `--yes` answers every prompt with
 * its default, and off a TTY without `--yes` the defaults are used as well.
 * "Default" is not "everything", though. Four things are
 * never done silently: the starter packs (step b, a hundred-odd global terms),
 * the repo harvest (step c) and the login service (step e) are performed under
 * `--yes` only with an explicit `--packs` / `--harvest` / `--serve` (a harvest
 * is a write plus a trust decision, a service replaces whatever is under its
 * label), and step c's prompt itself defaults to no, because a stranger this
 * early cannot judge a list of names that will rewrite everything they
 * dictate in this repo. `--dry-run` runs every detection and suggestion but
 * writes nothing, returning a `SetupPlan` of what this same command would do
 * without it: `plan.interactive` says whether a real run would prompt,
 * `plan.wouldAsk` names the steps that are questions, and the `would*` fields
 * are the outcome of taking every default (the MCP `setup_lexicon` tool
 * previews with it; the plan lists the harvest candidates either way so the
 * caller can offer them). Every step is
 * idempotent: addTerm merges, the installers skip what is already there and
 * an export rewrites its file only when that holds no edits of its own (else
 * it asks on a terminal, or writes lexicon-<app>-<n>); a person or company already in the global
 * lexicon, or a harvest candidate already covered by a global term, is
 * reported and not added again. All process spawning and filesystem probing
 * goes through `SetupDeps` so tests never touch the machine.
 */
import { homeDir } from '../util/xdg.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { listPacks } from '../core/index.js';
import { bold, dim, fail, jsonError, safe, safeMessage, safePath, shownCommand, tildify } from './io.js';
import { errorMessage } from '../util/errors.js';
import type { IO } from './io.js';
import { PromptClosedError, createPrompter, isInteractive, onlyStdoutRedirected } from './prompt.js';
import { SETUP_APPS, SETUP_CLIENTS } from './setup/types.js';
import type { Ctx, SetupDeps, SetupOptions, SetupPlan, SetupSummary } from './setup/types.js';
import { defaultSetupExec, isSetupApp, parseClientList, parsePackList, setupHintProblem, setupNameProblem } from './setup/detect.js';
import {
  stepClients,
  stepDemo,
  stepExport,
  stepHarvest,
  stepLexicon,
  stepPacks,
  stepServe,
} from './setup/steps.js';

/**
 * The wizard's vocabulary, its machine detection and its seven steps live under
 * ./setup/; re-exported here because cmd-setup.js is the import path the MCP
 * `setup_lexicon` tool, index.ts and the tests already use.
 */
export {
  HARVEST_LIMIT,
  HARVEST_MIN_COUNT,
  SEEDED_TERMS,
  SETUP_APPS,
  SETUP_CLIENTS,
} from './setup/types.js';
export type {
  DetectedClient,
  SetupApp,
  SetupClient,
  SetupClientResult,
  SetupDeps,
  SetupExec,
  SetupOptions,
  SetupPackResult,
  SetupPlan,
  SetupSummary,
} from './setup/types.js';
export { detectClients, parseClientList, parsePackList, setupHintProblem, setupNameProblem, suggestCompany } from './setup/detect.js';

/**
 * Step h (dry run): the plan card.
 *
 * It describes one specific run: this command, without `--dry-run`, answering
 * every prompt with its default. A dry run never prompts itself, so a line
 * that says "would install" for a step the same flags cannot reach, or
 * "skipped" for one a real run would stop and ask about, is worse than no
 * plan at all -- this is the flag a cautious stranger reaches for first.
 * Every asked step therefore says so, and says what the default answer is.
 */
function printPlan(ctx: Ctx, p: SetupPlan): void {
  const asks = (step: string): boolean => p.wouldAsk.includes(step);
  ctx.say();
  ctx.say(bold('Plan (nothing written).'));
  ctx.say(
    dim(
      p.interactive
        ? '   this is what the same command without --dry-run does if you press Enter at every prompt.'
        : '   this is what the same command without --dry-run does; nothing here is prompted for.',
    ),
  );
  ctx.say(`   lexicon: ${safePath(tildify(p.lexiconPath, ctx.home))}${p.lexiconExists ? '' : dim(' (would be created)')}`);
  ctx.say(`   would seed: ${p.wouldSeed.length > 0 ? safe(p.wouldSeed.join(', ')) : dim('nothing')}`);
  const packs = p.wouldInstallPacks.length > 0 ? p.wouldInstallPacks.join(', ') : dim('none');
  ctx.say(
    asks('packs')
      ? `   starter packs: ${dim('asks')} (checklist, checked: ${packs}; Enter installs them)`
      : typeof ctx.opts.packs === 'string' && p.wouldInstallPacks.length > 0
        ? `   starter packs: would install ${packs}`
        : p.wouldInstallPacks.length > 0
          ? `   starter packs: ${dim('none')} (--packs ${p.wouldInstallPacks.join(',')} installs the defaults)`
          : `   starter packs: ${dim('none')}`,
  );
  const names = p.wouldHarvest.length > 0 ? safe(p.wouldHarvest.join(', ')) : dim('nothing');
  const onOffer = `${p.wouldHarvest.length} name${p.wouldHarvest.length === 1 ? '' : 's'} on offer: ${names}`;
  ctx.say(
    ctx.opts.harvest === false
      ? `   repo harvest: ${dim('skipped')} (--no-harvest)`
      : p.wouldHarvest.length === 0
      ? `   repo harvest: ${dim('nothing to add')}`
      : ctx.opts.harvest === true
        ? `   repo harvest: would add ${names}`
        : asks('harvest')
          ? `   repo harvest: ${dim('asks')} (default no), ${onOffer}`
          : `   repo harvest: ${dim('nothing added')} (--harvest adds them), ${onOffer}`,
  );
  ctx.say(`   detected clients: ${p.detectedClients.length > 0 ? p.detectedClients.join(', ') : dim('none')}`);
  ctx.say(
    asks('clients')
      ? `   would install into: ${dim('asks')} (checked: ${p.wouldInstallClients.length > 0 ? p.wouldInstallClients.join(', ') : dim('none')})`
      : `   would install into: ${p.wouldInstallClients.length > 0 ? p.wouldInstallClients.join(', ') : dim('none')}`,
  );
  ctx.say(
    p.serveBlocked !== undefined
      ? `   login service: would not install (${safeMessage(p.serveBlocked)})`
      : asks('serve')
        ? `   login service: ${dim('asks')} (default yes) would install a login service that runs the local API`
        : `   login service: ${p.wouldInstallServe ? 'would install' : dim('skipped (--serve installs it)')}`,
  );
  const exports = p.wouldExport.length > 0 ? safeMessage(p.wouldExport.map((e) => tildify(e.path, ctx.home)).join(', ')) : dim('nothing');
  ctx.say(
    asks('export')
      ? `   dictation export: ${dim('asks')} which app, and Enter writes ${exports}`
      : `   would export: ${p.wouldExport.length > 0 ? exports : dim('nothing (--app <app> writes one)')}`,
  );
  ctx.say();
  ctx.say(dim(`   to apply, run: ${setupApplyCommand(ctx.opts)}`));
}

/**
 * The command a dry run names to apply its plan: `lexicon setup` with every
 * flag this run was given except `--dry-run`, each word POSIX-quoted only when
 * it needs it (as `installApplyCommand` does), so the line can be copied as it
 * is. `--cwd` is named only when it is not the current directory.
 */
export function setupApplyCommand(opts: SetupOptions): string {
  const words = ['lexicon'];
  if (opts.cwd !== undefined && path.resolve(opts.cwd) !== process.cwd()) words.push('--cwd', opts.cwd);
  words.push('setup');
  if (opts.yes) words.push('--yes');
  if (opts.clients !== undefined) words.push('--clients', opts.clients);
  if (opts.company !== undefined) words.push('--company', opts.company);
  if (opts.person !== undefined) words.push('--person', opts.person);
  if (opts.phonetic !== undefined) words.push('--phonetic', opts.phonetic);
  if (opts.app !== undefined) words.push('--app', opts.app);
  if (opts.exportDir !== undefined) words.push('--export-dir', opts.exportDir);
  if (typeof opts.packs === 'string') words.push('--packs', opts.packs);
  else if (opts.packs === false) words.push('--no-packs');
  if (opts.harvest === true) words.push('--harvest');
  else if (opts.harvest === false) words.push('--no-harvest');
  if (opts.serve === true) words.push('--serve');
  else if (opts.serve === false) words.push('--no-serve');
  if (opts.reseed) words.push('--reseed');
  if (opts.home) words.push('--home', opts.home);
  if (opts.json) words.push('--json');
  return shownCommand(words);
}

/**
 * The one thing to do next, in one line. Not a list: a stranger who has just
 * read six step results has room for exactly one instruction, and the whole
 * product is "say a name out loud and watch it come out spelled right".
 *
 * The name is the company seeded in step 1 when there is one, else whatever
 * the step-7 demonstration just corrected, so the sentence is always one this
 * lexicon can actually fix.
 */
function printNext(ctx: Ctx): void {
  const s = ctx.summary;
  // A name the user actually owns. `demo.terms` are the user's only when the
  // demonstration did not fall back to the example lexicon -- naming
  // "Ashlr.AI" to someone who has never heard of it would be nonsense.
  const name = ctx.company ?? (s.demo && !s.demo.usedExample ? s.demo.terms[0] : undefined);
  const installed = s.clients.filter((c) => c.status === 'installed').map((c) => c.name);
  const where = installed.includes('claude') ? 'Claude Code' : (installed[0] ?? 'your agent');
  ctx.say();
  // The demonstration fell back to the example terms: the lexicon has no
  // misspelling of the user's own to show, so "dictate one of your names"
  // would test nothing. Adding one is the next thing to do.
  const addName = !name && s.demo?.usedExample === true;
  if (addName) {
    ctx.say(`${bold('Next:')} add a name you dictate: lexicon add "Your Co" --suggest  (then open ${safe(where)} and say it in a sentence)`);
  } else {
    ctx.say(
      `${bold('Next:')} open ${safe(where)} and dictate a sentence with ${name ? `"${safe(name)}"` : 'one of your names'} in it. That is the whole thing.`,
    );
  }
  ctx.say(dim('   later: lexicon suggest (names you keep correcting), lexicon stats, lexicon voice (local push-to-talk)'));
  // The same step for `--json` (where the line above went to stderr) and, in
  // tool terms, for an agent: the agent cannot run `lexicon add`.
  const quoted = name ? JSON.stringify(name) : undefined;
  s.nextStep = ctx.opts.forAgent
    ? addName
      ? 'Ask the user for a name they dictate (their company, product or a teammate) and add it with add_term; then ask them to dictate a sentence with it in it.'
      : `Ask the user to dictate a sentence with ${quoted ?? 'one of their names'} in it${installed.length > 0 ? ` in ${where}` : ''}.`
    : addName
      ? `add a name you dictate: lexicon add "Your Co" --suggest (then open ${where} and say it in a sentence)`
      : `open ${where} and dictate a sentence with ${quoted ?? 'one of your names'} in it`;
}

/**
 * The card for a run cancelled at a prompt: what the finished steps wrote,
 * and that a rerun picks up from there (every step skips what is done).
 */
function printStopped(ctx: Ctx): void {
  ctx.say();
  ctx.say(bold(`Stopped at "${ctx.summary.stoppedAt ?? ''}" (the prompt was cancelled); nothing after it ran.`));
  printWritten(ctx);
  ctx.summary.nextStep = 'run lexicon setup again to finish; every step skips what is already done';
  ctx.say();
  ctx.say(`${bold('Next:')} ${ctx.summary.nextStep}`);
}

/**
 * The card for a run a step failed in: the error, what the finished steps
 * wrote, and that a rerun picks up from there once the error is fixed.
 */
function printFailed(ctx: Ctx): void {
  ctx.say();
  ctx.say(bold(`Failed at "${ctx.summary.failedAt ?? ''}": ${safeMessage(ctx.summary.error ?? '')}; nothing after it ran.`));
  printWritten(ctx);
  ctx.summary.nextStep = ctx.opts.forAgent
    ? 'Tell the user what the error names; once it is fixed, call setup_lexicon again: every step skips what is already done.'
    : 'fix what the error names, then run lexicon setup again; every step skips what is already done';
  ctx.say();
  ctx.say(`${bold('Next:')} ${ctx.summary.nextStep}`);
}

/** Step h: the summary card. */
function printSummary(ctx: Ctx): void {
  ctx.say();
  ctx.say(bold('Done.'));
  printWritten(ctx);
  printNext(ctx);
}

/** What this run wrote, one line per kind, for the summary and the stopped card. */
function printWritten(ctx: Ctx): void {
  const s = ctx.summary;
  ctx.say(`   lexicon: ${safePath(tildify(s.lexiconPath, ctx.home))}`);
  ctx.say(`   terms added: ${s.termsAdded.length > 0 ? safe(s.termsAdded.join(', ')) : dim('none')}`);
  ctx.say(`   packs: ${s.packs.length > 0 ? s.packs.map((p) => `${p.name} (${p.added} added)`).join(', ') : dim('none')}`);
  const installed = s.clients.filter((c) => c.status === 'installed').map((c) => c.name);
  const failed = s.clients.filter((c) => c.status === 'failed').map((c) => c.name);
  ctx.say(
    `   clients: ${installed.length > 0 ? installed.join(', ') : dim('none')}${failed.length > 0 ? ` (failed: ${failed.join(', ')})` : ''}`,
  );
  ctx.say(`   local API: ${s.serve}`);
  ctx.say(`   exports: ${s.exports.length > 0 ? safeMessage(s.exports.map((e) => tildify(e.path, ctx.home)).join(', ')) : dim('none')}`);
}

/**
 * The testable handler behind `lexicon setup`. Returns the exit code and the
 * summary (also printed as JSON under `opts.json`). Exit 1 when any client
 * or the serve install failed; the steps still all run. A prompt cancelled
 * at a terminal (its input closed) stops the run at that step, with a card
 * of what the finished steps wrote and `summary.stoppedAt`; exit 1. A step
 * that throws stops the run the same way, with `summary.failedAt` and
 * `summary.error` (a dry run still throws: it wrote nothing). Under `opts.dryRun`
 * nothing is written, the summary stays empty and `plan` says what a real
 * run with the same options would do (printed as the JSON under `--json`).
 */
export async function runSetup(
  opts: SetupOptions,
  io: IO,
  deps: SetupDeps = {},
): Promise<{ code: number; summary: SetupSummary; plan?: SetupPlan }> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const home = opts.home ? path.resolve(opts.home) : (deps.home ?? homeDir());
  // Validate the flags before any step writes anything.
  if (opts.clients !== undefined) parseClientList(opts.clients);
  // A blank, multi-line or over-cap name otherwise failed only at the write,
  // after the lexicon was created, with errors about generated aliases.
  for (const [flag, value] of [['--company', opts.company], ['--person', opts.person]] as const) {
    const problem = value === undefined ? undefined : setupNameProblem(value);
    if (problem !== undefined) {
      throw new Error(`${flag} ${problem}; nothing was written. Pass only the name, spelled as you want it written, or leave ${flag} out.`);
    }
  }
  // A multi-line or over-cap hint failed the same way, at the company write.
  const hintProblem = opts.phonetic === undefined ? undefined : setupHintProblem(opts.phonetic);
  if (hintProblem !== undefined) {
    throw new Error(`--phonetic ${hintProblem}; nothing was written. Pass only the pronunciation hint, e.g. ASH-ler, or leave --phonetic out.`);
  }
  if (opts.app !== undefined && !isSetupApp(opts.app.trim().toLowerCase())) {
    throw new Error(`unknown app "${opts.app}" (expected one of: ${SETUP_APPS.join(', ')})`);
  }
  if (typeof opts.packs === 'string') parsePackList(opts.packs, (await (deps.listPacks ?? listPacks)()).map((p) => p.name));
  // A dry run never prompts, but it has to describe a run that does: `wouldPrompt`
  // is what the same command without --dry-run would find, so the plan can say
  // which steps are questions instead of inventing an answer for them.
  const wouldPrompt = !opts.yes && !opts.json && (deps.isInteractive ?? isInteractive)();
  const interactive = wouldPrompt && !opts.dryRun;
  const ownPrompter = interactive && !deps.createPrompter;
  const prompter = interactive
    ? (deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout })))()
    : undefined;

  const say = (s = ''): void => {
    // An agent gets the summary or plan instead: the progress names CLI flags it cannot pass.
    if (opts.forAgent) return;
    if (opts.json) io.stderr(`${s}\n`);
    else io.stdout(`${s}\n`);
  };
  const ctx: Ctx = {
    opts,
    deps,
    say,
    homeOverridden: Boolean(opts.home || deps.home),
    warn: (s) => io.stderr(`${s}\n`),
    io,
    cwd,
    home,
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    exists: deps.exists ?? existsSync,
    exec: deps.exec ?? defaultSetupExec,
    seeded: [],
    packCanonicals: [],
    plannedSeed: [],
    summary: { lexiconPath: '', termsAdded: [], packs: [], clients: [], serve: 'skipped', exports: [] },
  };
  if (prompter) ctx.prompter = prompter;
  if (opts.dryRun) {
    ctx.plan = {
      plan: true,
      interactive: wouldPrompt,
      wouldAsk: [],
      lexiconPath: '',
      lexiconExists: false,
      wouldSeed: [],
      wouldInstallPacks: [],
      packsOnOffer: [],
      packsToInstall: [],
      wouldHarvest: [],
      detectedClients: [],
      wouldInstallClients: [],
      wouldInstallServe: false,
      wouldExport: [],
    };
  }

  say(bold(opts.dryRun ? 'lexicon setup (dry run)' : 'lexicon setup'));
  if (!interactive && !opts.yes && !opts.json && !opts.dryRun) {
    // `lexicon setup | tee log` has a person at the keyboard: "no terminal"
    // read as a bug, and the line went into the pipe. Say on stderr what to do.
    if (deps.isInteractive === undefined && onlyStdoutRedirected()) {
      say(dim('(stdout is not a terminal: taking the defaults, as with --yes)'));
      io.stderr(
        'lexicon setup: stdout is not a terminal (piped or redirected), so no questions were asked and the defaults were taken, as with --yes. To answer them, run lexicon setup without the pipe or redirect; or pass the answers as flags (--app, --clients, --packs, --serve, --harvest).\n',
      );
    } else {
      say(dim('(no terminal: taking the defaults, as with --yes)'));
    }
  }
  say();
  const steps: [string, (c: Ctx) => Promise<void>][] = [
    ['Global lexicon', stepLexicon],
    ['Starter packs', stepPacks],
    ['Repo harvest', stepHarvest],
    ['Agent clients', stepClients],
    ['Local API', stepServe],
    ['Dictation app', stepExport],
    ['Does it work?', stepDemo],
  ];
  try {
    for (const [i, [title, step]] of steps.entries()) {
      if (i > 0) say();
      try {
        await step(ctx);
      } catch (err) {
        // ctrl-C or ctrl-D at a prompt closes its input. That surfaced as
        // `lexicon: input closed before the prompt was answered` and exit 1,
        // with no word of what the earlier steps had already written.
        if (err instanceof PromptClosedError) {
          ctx.summary.stoppedAt = title;
          break;
        }
        // A step that failed part way (an export directory that cannot be
        // written, a pack that will not install) threw out of the run, so the
        // only output was the error: nothing said that the lexicon, the packs
        // or the clients before it were already done. A dry run wrote
        // nothing, so its error is still the whole story.
        if (ctx.plan) throw err;
        ctx.summary.failedAt = title;
        ctx.summary.error = errorMessage(err);
        ctx.warn(`lexicon setup: ${title}: ${safeMessage(ctx.summary.error)}`);
        break;
      }
    }
    if (ctx.plan) printPlan(ctx, ctx.plan);
    else if (ctx.summary.stoppedAt !== undefined) printStopped(ctx);
    else if (ctx.summary.failedAt !== undefined) printFailed(ctx);
    else printSummary(ctx);
  } finally {
    if (ownPrompter) prompter?.close();
  }
  const failed =
    ctx.summary.stoppedAt !== undefined || ctx.summary.failedAt !== undefined || ctx.summary.serve === 'failed' || ctx.summary.clients.some((c) => c.status === 'failed');
  // `ok` leads the document so a script reads success the same way it reads
  // the `{ ok: false, error, nextStep }` refusal; false when a client or serve failed (exit 1).
  if (opts.json) io.stdout(`${JSON.stringify({ ok: !failed, ...(ctx.plan ?? ctx.summary) }, null, 2)}\n`);
  return { code: failed ? 1 : 0, summary: ctx.summary, ...(ctx.plan ? { plan: ctx.plan } : {}) };
}

/** Commander action for `lexicon setup`. Loaded only when that command runs. */
export async function runSetupCli(program: { opts(): { cwd?: string } }, io: IO, opts: SetupOptions): Promise<void> {
  const { cwd } = program.opts();
  const merged: SetupOptions = cwd ? { ...opts, cwd } : opts;
  let code: number;
  try {
    ({ code } = await runSetup(merged, io));
  } catch (err) {
    if (!opts.json) throw err;
    // Under --json stdout is the one document a script reads: a refusal
    // (an unknown --app or client, a step that threw) is `{ ok: false,
    // error }` there, with the usual stderr line, rather than nothing.
    io.stdout(`${JSON.stringify(jsonError(errorMessage(err), 'fix what error names, then run lexicon setup --json again (lexicon setup --help lists the flags)'), null, 2)}\n`);
    code = fail(io, err);
  }
  if (code !== 0) process.exitCode = code;
}

export { registerSetupCommands } from './program.js';
