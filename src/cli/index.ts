#!/usr/bin/env node
/**
 * `lexicon` CLI. Only commander wiring lives here; the behaviour is in
 * ./commands.ts so it can be unit-tested without spawning a process.
 */
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { packageVersion } from '../util/package.js';
import { parseBackendName, runDaemonCommand } from '../daemon/clipboard.js';
import { registerImportCommands } from './cmd-import.js';
import { registerInstallCommands } from './cmd-install.js';
import { registerTrustCommands } from './cmd-trust.js';
import { registerLearnCommands } from './cmd-learn.js';
import { registerServeCommands } from './cmd-serve.js';
import { registerVoiceCommands } from './cmd-voice.js';
import { registerSetupCommands } from './cmd-setup.js';
import { registerSuggestCommands } from './cmd-suggest.js';
import { registerReviewCommands } from './cmd-review.js';
import { registerPackCommands } from './cmd-pack.js';
import {
  processIO,
  runAdd,
  runDoctor,
  runExport,
  runHarvest,
  runInit,
  runList,
  runNormalize,
  runPath,
  runRemove,
} from './commands.js';
import { runInstall } from './cmd-install.js';
import type { ClipboardBackendName } from '../daemon/clipboard-backends.js';
import type {
  AddOptions,
  DoctorCliOptions,
  ExportCliOptions,
  HarvestCliOptions,
  InitOptions,
  ListOptions,
  NormalizeCliOptions,
  PathOptions,
  RemoveOptions,
} from './commands.js';
import type { InstallOptions } from './cmd-install.js';
import { argvRequestsJson, fail, line, usageErrorJson } from './io.js';


interface DaemonCliOptions {
  interval: number;
  dryRun?: boolean;
  quiet?: boolean;
  once?: boolean;
  paste?: boolean;
  which?: boolean;
  backend?: ClipboardBackendName;
}

function positiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive integer');
  return n;
}

const program = new Command();
const io = processIO;

program
  .name('lexicon')
  .description('Personal lexicon for voice-to-agents: fixes the words STT gets wrong before your agent sees them.')
  .version(packageVersion(import.meta.url))
  .option('--cwd <dir>', 'directory used to find the project .lexicon.yaml (default: current directory)')
  .exitOverride()
  .showHelpAfterError('(use --help for usage)');

/** Global options, merged into each command's own. */
function withGlobals<T extends object>(opts: T): T & { cwd?: string } {
  const { cwd } = program.opts<{ cwd?: string }>();
  return cwd ? { ...opts, cwd } : opts;
}

function done(code: number): void {
  if (code !== 0) process.exitCode = code;
}

program
  .command('init')
  .description('create the lexicon file (global by default) if it does not exist')
  .option('--project', 'create a project .lexicon.yaml at the git root (or cwd) instead')
  .action(async (opts: InitOptions) => done(await runInit(withGlobals(opts), io)));

program
  .command('add')
  .description('add a term, or merge aliases into an existing one')
  .argument('<canonical>', 'the correct spelling, e.g. "Ashlr.AI"')
  .argument('[aliases...]', 'what STT actually writes, e.g. Ashler Ashlar')
  .option('--phonetic <hint>', 'pronunciation hint, e.g. ASH-ler')
  .option('--category <category>', 'brand|person|product|acronym|identifier|place|other')
  .option('--notes <text>', 'free text shown to the agent')
  .option('--project', 'write to the project lexicon instead of the global one')
  .option('--suggest', 'append auto-generated likely misspellings (automatic when no aliases are given)')
  .option('-i, --interactive', 'confirm suggested aliases as a checklist, then ask for phonetic hint and category')
  .option(
    '--never <word...>',
    'words that must never be rewritten to this term even if they sound alike, e.g. --never sauce',
  )
  .option('--json', 'print the saved term, file path and whether it was created as JSON')
  .action(async (canonical: string, aliases: string[], opts: AddOptions) =>
    done(await runAdd(canonical, aliases, withGlobals(opts), io)),
  );

program
  .command('remove')
  .alias('rm')
  .description('remove a term (project lexicon first, then global), or one alias of it with --alias')
  .argument('<canonical>')
  .option('--alias <alias>', 'remove only this alias from the term and keep the term (exit 1 when the term or alias is unknown)')
  .option('--project', 'only look in the project lexicon')
  .option('--global', 'only look in the global lexicon (not with --project)')
  .option('--json', 'print { ok: true, canonical, removed } as JSON (exit 1 when not found, with ok: false and error), plus stillIn when a copy is left in the other lexicon file and untrustedProject when the untrusted project lexicon has one; with --alias also alias, aliases and paths')
  .action(async (canonical: string, opts: RemoveOptions) => done(await runRemove(canonical, withGlobals(opts), io)));

program
  .command('list')
  .alias('ls')
  .description('list terms from the merged global + project lexicon')
  .option('--json', 'print terms as JSON (a bare array)')
  .option('--full', 'print { terms, counts, paths } as JSON, the object MCP list_terms returns, plus projectTrust, skippedProject and note when an untrusted project lexicon was left out (implies --json)')
  .option('--category <category>', 'only this category')
  .option('--query <text>', 'only terms whose canonical or aliases contain this text')
  .action(async (opts: ListOptions) => done(await runList(withGlobals(opts), io)));

program
  .command('normalize')
  .description('correct dictated text (from arguments, or stdin when omitted); stdout always round-trips the input, exit 1 if the lexicon could not be read')
  .argument('[text...]')
  .option('--json', 'print the full NormalizeResult as JSON, plus example: true when the built-in example terms stood in and projectTrust, skippedProject and note when an untrusted project lexicon was left out')
  .option('--diff', 'print a summary of replacements to stderr (with --json too)')
  .option('--dry-run', 'print the replacement summary to stderr and the text unchanged to stdout')
  .option('--min-confidence <n>', 'minimum confidence (0..1) for fuzzy/phonetic matches')
  .option('--no-phonetic', 'disable phonetic matching')
  .option('--no-fuzzy', 'disable fuzzy (edit-distance) matching')
  .option('--include-untrusted', 'merge the project .lexicon.yaml even if it has not been trusted')
  .action(async (text: string[], opts: NormalizeCliOptions) => done(await runNormalize(text, withGlobals(opts), io)));

program
  .command('harvest')
  .description('scan a repository for names worth adding to the lexicon')
  .argument('[path]', 'repository root (default: cwd)')
  .option('--limit <n>', 'max candidates', positiveInt)
  .option('--min-count <n>', 'minimum occurrences', positiveInt)
  .option('--add', 'add candidates (with suggested aliases) to the project lexicon; on a terminal this walks them one by one')
  .option('-i, --interactive', 'walk candidates one by one: y add, n skip, e edit aliases, c category, a add all, q quit')
  .option('--yes', 'with --add: add every candidate without prompting')
  .option('--symbols', 'also propose names seen only as a code symbol (off: they are what you type, not what you say)')
  .option('--json', 'print candidates as JSON (a bare array; with --add it is printed after the writes, the add summary goes to stderr, and a failed write prints only { ok: false, error, added, created, merged, path })')
  .option('--full', 'print { root, candidates, count } as JSON, the object MCP harvest_repo returns, plus added, created, merged and path with --add (implies --json)')
  .action(async (root: string | undefined, opts: HarvestCliOptions) =>
    done(await runHarvest(root, withGlobals(opts), io)),
  );

program
  .command('export')
  .description('export the merged lexicon for another tool (run without a format to list them)')
  .argument('[format]')
  .option('--out <file>', 'write to a file instead of stdout')
  .option('--category <categories...>', 'only these categories')
  .option('--limit <n>', 'cap the number of terms', positiveInt)
  .action(async (format: string | undefined, opts: ExportCliOptions) =>
    done(await runExport(format, withGlobals(opts), io)),
  );

program
  .command('path')
  .description('print the resolved global and project lexicon paths')
  .option('--json', 'print { global, project } as JSON (project is null when there is no project lexicon)')
  .action(async (opts: PathOptions) => done(await runPath(withGlobals(opts), io)));

program
  .command('doctor')
  .description('check lexicon files, term conflicts and the Claude Code integration')
  .option('--json', 'print the report as JSON ({ ok, ready, summary, nextStep, checks, ... }, as the lexicon_doctor MCP tool returns it)')
  .action(async (opts: DoctorCliOptions) => done(await runDoctor(withGlobals(opts), io)));

program
  .command('mcp')
  .description('start the stdio MCP server (what `claude mcp add` points at)')
  .action(async () => {
    const { main } = await import('../mcp/server.js');
    await main();
  });

program
  .command('hook')
  .description('run as a Claude Code UserPromptSubmit hook (reads JSON from stdin)')
  .action(async () => {
    const { main } = await import('../hooks/user-prompt-submit.js');
    await main();
  });

program
  .command('daemon')
  .description('watch the clipboard (macOS, Linux, Windows) and correct dictated text in place')
  .option('--once', 'correct the clipboard once and exit (for a keyboard shortcut after dictating)')
  .option('--paste', 'with --once: send Cmd+V afterwards (macOS only; needs Accessibility permission)')
  .option('--interval <ms>', 'poll interval in milliseconds', positiveInt, 250)
  .option('--dry-run', 'report corrections without writing to the clipboard')
  .option('--quiet', 'do not print corrections')
  .option('--backend <name>', 'force a clipboard backend: pbcopy|wl|xclip|xsel|powershell', (v: string) => {
    try {
      return parseBackendName(v);
    } catch (e) {
      throw new InvalidArgumentError(e instanceof Error ? e.message : String(e));
    }
  })
  .option('--which', 'print the detected clipboard backend and exit')
  .action(async (opts: DaemonCliOptions) => {
    const { cwd } = withGlobals({});
    done(
      await runDaemonCommand({
        intervalMs: opts.interval,
        dryRun: opts.dryRun ?? false,
        quiet: opts.quiet ?? false,
        once: opts.once ?? false,
        paste: opts.paste ?? false,
        which: opts.which ?? false,
        ...(opts.backend ? { backend: opts.backend } : {}),
        ...(cwd ? { cwd } : {}),
      }),
    );
  });

/**
 * Back-compat alias for `lexicon install claude`, which is the documented
 * command. Hidden from --help and from docs/CLI.md so there is one name to
 * learn, but kept working (and forwarded to the same handler, with the same
 * flags) because it is in shipped READMEs, in older doctor output and in
 * people's shell history.
 */
program
  .command('install-claude', { hidden: true })
  .description('deprecated alias for `lexicon install claude`')
  .option('--apply', 'write the config (merge; existing keys are kept)')
  .option('--scope <scope>', 'user|project', 'user')
  .option('--project', 'same as --scope project')
  .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
  .action(async (opts: InstallOptions) => done(await runInstall('claude', withGlobals(opts), io)));

// Extension slots: each module registers its own commands (keeps index.ts small).
registerImportCommands(program, io);
registerInstallCommands(program, io);
registerTrustCommands(program, io);
registerLearnCommands(program, io);
registerServeCommands(program, io);
registerVoiceCommands(program, io);
registerSetupCommands(program, io);
registerSuggestCommands(program, io);
registerReviewCommands(program, io);
registerPackCommands(program, io);

// Commander usage errors (unknown option or command, missing argument, an
// invalid --port) are raised before any handler runs, so under --json they
// got no stdout document. Every command throws its own CommanderError, which
// is remembered with the command, so the catch below can print
// `{ ok: false, error, nextStep }` naming that command's --help. The stderr
// text and the exit code stay commander's.
const usageErrorCommand = new WeakMap<CommanderError, Command>();
function trackUsageErrors(cmd: Command): void {
  cmd.exitOverride((err) => {
    usageErrorCommand.set(err, cmd);
    throw err;
  });
  for (const sub of cmd.commands) trackUsageErrors(sub);
}
trackUsageErrors(program);

/** `lexicon pack add` for the `add` subcommand of `pack`. */
function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** Exits that are not usage errors: help and version output, which stay as they are. */
const NOT_USAGE_ERRORS = new Set(['commander.helpDisplayed', 'commander.help', 'commander.version', 'commander.executeSubCommandAsync']);

// A reader that closed the pipe (`lexicon list | head`) has seen all it wants:
// stop quietly instead of dying on an unhandled EPIPE with a stack trace.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

// The command whose action is running, so an error it throws can be reported
// in the form its flags asked for: under --json, a `{ ok: false, error }`
// document on stdout as well as the stderr line.
let active: Command | undefined;
program.hook('preAction', (_program, actionCommand) => {
  active = actionCommand;
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    // commander already printed help/version/usage errors on stderr; under
    // --json a usage error also gets its stdout document. Same exit code.
    if (err.exitCode !== 0 && !NOT_USAGE_ERRORS.has(err.code) && argvRequestsJson(process.argv.slice(2))) {
      line(io, JSON.stringify(usageErrorJson(err.message, commandPath(usageErrorCommand.get(err) ?? program)), null, 2));
    }
    process.exitCode = err.exitCode;
  } else {
    // fail() is the same `lexicon: <message>` line plus, for a lexicon file
    // that does not parse, the command that fixes it.
    process.exitCode = fail(io, err, active?.opts<{ json?: boolean }>().json === true);
  }
}
