/**
 * `lexicon setup`: the one command a new user runs. Walks through seven steps,
 * each printing a one-line result, and never re-implements an installer:
 *
 *   a. global lexicon (runInit) seeded with the git user as a person term and
 *      the company/product name (suggested from the cwd package scope or the
 *      git remote org) with suggested aliases and an optional phonetic hint
 *   b. starter packs (core/packs.ts): a checklist with developer, ai and
 *      voice-tools checked and business offered; `--packs a,b` / `--no-packs`
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
 * label), and `--dry-run` runs every detection and suggestion but
 * writes nothing, returning a `SetupPlan` of what a real run would do (the
 * MCP `setup_lexicon` tool previews with it; the plan lists the harvest
 * candidates either way so the caller can offer them). Every step is
 * idempotent: addTerm merges, the installers skip what is already there and
 * exports overwrite the same file; a person or company already in the global
 * lexicon, or a harvest candidate already covered by a global term, is
 * reported and not added again. All process spawning and filesystem probing
 * goes through `SetupDeps` so tests never touch the machine.
 */
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { listPacks } from '../core/index.js';
import { bold, dim, safe, tildify } from './io.js';
import type { IO } from './io.js';
import { createPrompter, isInteractive } from './prompt.js';
import { SETUP_APPS, SETUP_CLIENTS } from './setup/types.js';
import type { Ctx, SetupDeps, SetupOptions, SetupPlan, SetupSummary } from './setup/types.js';
import { defaultSetupExec, isSetupApp, parseClientList, parsePackList } from './setup/detect.js';
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
 * The wizard's vocabulary, its machine detection and its six steps live under
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
export { detectClients, parseClientList, parsePackList, suggestCompany } from './setup/detect.js';

function printPlan(ctx: Ctx, p: SetupPlan): void {
  ctx.say();
  ctx.say(bold('Plan (nothing written).'));
  ctx.say(`   lexicon: ${safe(tildify(p.lexiconPath, ctx.home))}${p.lexiconExists ? '' : dim(' (would be created)')}`);
  ctx.say(`   would seed: ${p.wouldSeed.length > 0 ? safe(p.wouldSeed.join(', ')) : dim('nothing')}`);
  ctx.say(`   would install packs: ${p.wouldInstallPacks.length > 0 ? p.wouldInstallPacks.join(', ') : dim('none')}`);
  ctx.say(`   would harvest: ${p.wouldHarvest.length > 0 ? safe(p.wouldHarvest.join(', ')) : dim('nothing')}`);
  ctx.say(`   detected clients: ${p.detectedClients.length > 0 ? p.detectedClients.join(', ') : dim('none')}`);
  ctx.say(`   would install into: ${p.wouldInstallClients.length > 0 ? p.wouldInstallClients.join(', ') : dim('none')}`);
  ctx.say(`   login service: ${p.wouldInstallServe ? 'would install' : dim('skipped')}`);
  ctx.say(`   would export: ${p.wouldExport.length > 0 ? safe(p.wouldExport.map((e) => tildify(e.path, ctx.home)).join(', ')) : dim('nothing')}`);
  ctx.say();
  ctx.say(dim('   run again without --dry-run to apply.'));
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
  ctx.say(
    `${bold('Next:')} open ${safe(where)} and dictate a sentence with ${name ? `"${safe(name)}"` : 'one of your names'} in it. That is the whole thing.`,
  );
  ctx.say(dim('   later: lexicon suggest (names you keep correcting), lexicon stats, lexicon voice (local push-to-talk)'));
}

/** Step h: the summary card. */
function printSummary(ctx: Ctx): void {
  const s = ctx.summary;
  ctx.say();
  ctx.say(bold('Done.'));
  ctx.say(`   lexicon: ${safe(tildify(s.lexiconPath, ctx.home))}`);
  ctx.say(`   terms added: ${s.termsAdded.length > 0 ? safe(s.termsAdded.join(', ')) : dim('none')}`);
  ctx.say(`   packs: ${s.packs.length > 0 ? s.packs.map((p) => `${p.name} (${p.added} added)`).join(', ') : dim('none')}`);
  const installed = s.clients.filter((c) => c.status === 'installed').map((c) => c.name);
  const failed = s.clients.filter((c) => c.status === 'failed').map((c) => c.name);
  ctx.say(
    `   clients: ${installed.length > 0 ? installed.join(', ') : dim('none')}${failed.length > 0 ? ` (failed: ${failed.join(', ')})` : ''}`,
  );
  ctx.say(`   local API: ${s.serve}`);
  ctx.say(`   exports: ${s.exports.length > 0 ? safe(s.exports.map((e) => tildify(e.path, ctx.home)).join(', ')) : dim('none')}`);
  printNext(ctx);
}

/**
 * The testable handler behind `lexicon setup`. Returns the exit code and the
 * summary (also printed as JSON under `opts.json`). Exit 1 when any client
 * or the serve install failed; the steps still all run. Under `opts.dryRun`
 * nothing is written, the summary stays empty and `plan` says what a real
 * run with the same options would do (printed as the JSON under `--json`).
 */
export async function runSetup(
  opts: SetupOptions,
  io: IO,
  deps: SetupDeps = {},
): Promise<{ code: number; summary: SetupSummary; plan?: SetupPlan }> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const home = opts.home ? path.resolve(opts.home) : (deps.home ?? os.homedir());
  // Validate the flags before any step writes anything.
  if (opts.clients !== undefined) parseClientList(opts.clients);
  if (opts.app !== undefined && !isSetupApp(opts.app.trim().toLowerCase())) {
    throw new Error(`unknown app "${opts.app}" (expected one of: ${SETUP_APPS.join(', ')})`);
  }
  if (typeof opts.packs === 'string') parsePackList(opts.packs, (await (deps.listPacks ?? listPacks)()).map((p) => p.name));
  // A dry run never prompts: it reports the non-interactive defaults.
  const interactive = !opts.yes && !opts.json && !opts.dryRun && (deps.isInteractive ?? isInteractive)();
  const ownPrompter = interactive && !deps.createPrompter;
  const prompter = interactive
    ? (deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout })))()
    : undefined;

  const say = (s = ''): void => {
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
    summary: { lexiconPath: '', termsAdded: [], packs: [], clients: [], serve: 'skipped', exports: [] },
  };
  if (prompter) ctx.prompter = prompter;
  if (opts.dryRun) {
    ctx.plan = {
      plan: true,
      lexiconPath: '',
      lexiconExists: false,
      wouldSeed: [],
      wouldInstallPacks: [],
      wouldHarvest: [],
      detectedClients: [],
      wouldInstallClients: [],
      wouldInstallServe: false,
      wouldExport: [],
    };
  }

  say(bold(opts.dryRun ? 'lexicon setup (dry run)' : 'lexicon setup'));
  if (!interactive && !opts.yes && !opts.json && !opts.dryRun) say(dim('(no terminal: taking the defaults, as with --yes)'));
  say();
  try {
    await stepLexicon(ctx);
    say();
    await stepPacks(ctx);
    say();
    await stepHarvest(ctx);
    say();
    await stepClients(ctx);
    say();
    await stepServe(ctx);
    say();
    await stepExport(ctx);
    say();
    await stepDemo(ctx);
    if (ctx.plan) printPlan(ctx, ctx.plan);
    else printSummary(ctx);
  } finally {
    if (ownPrompter) prompter?.close();
  }
  if (opts.json) io.stdout(`${JSON.stringify(ctx.plan ?? ctx.summary, null, 2)}\n`);
  const failed = ctx.summary.serve === 'failed' || ctx.summary.clients.some((c) => c.status === 'failed');
  return { code: failed ? 1 : 0, summary: ctx.summary, ...(ctx.plan ? { plan: ctx.plan } : {}) };
}

export function registerSetupCommands(program: Command, io: IO): void {
  program
    .command('setup')
    .description('guided first-run: seed the lexicon, harvest the repo, install into your agents and dictation app')
    .option('-y, --yes', 'take every default without prompting')
    .option('--clients <list>', `comma-separated clients to install into, or none (default: detect; one of ${SETUP_CLIENTS.join(', ')})`)
    .option('--company <name>', 'company or product name to seed (as you want it spelled)')
    .option('--person <name>', 'your name to seed (default: git config --global user.name)')
    .option('--phonetic <hint>', 'pronunciation hint for the company term, e.g. ASH-ler')
    .option('--app <app>', `dictation app to export for: ${SETUP_APPS.join('|')}`)
    .option('--export-dir <dir>', 'where to write the dictation export (default: ~/Desktop)')
    .option('--harvest', 'add the repo names to the project lexicon (with --yes it is skipped unless this is passed)')
    .option('--packs <list>', 'comma-separated starter packs to install, or none (default: a checklist on a terminal, nothing with --yes; one of developer, ai, business, voice-tools)')
    .option('--no-packs', 'skip the starter packs (no prompt)')
    .option('--no-harvest', 'skip the repo harvest (no prompt)')
    .option('--serve', 'install the local API login service (with --yes it is skipped unless this is passed)')
    .option('--no-serve', 'skip installing the local API login service (no prompt)')
    .option('--dry-run', 'detect and suggest only; write nothing and print what a run would do')
    .option('--reseed', 'seed person/company terms even if the lexicon already has terms')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print a machine-readable summary on stdout (progress goes to stderr)')
    .action(async (opts: SetupOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const merged: SetupOptions = cwd ? { ...opts, cwd } : opts;
      const { code } = await runSetup(merged, io);
      if (code !== 0) process.exitCode = code;
    });
}
