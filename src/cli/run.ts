/**
 * Parse argv and run one command. Loaded for every invocation except a lone
 * `--version`, `-V` or `-v`, which index.ts answers without this module.
 */
import { existsSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { packageVersion } from '../util/package.js';
import { buildHandshake, wantsHandshake } from './handshake.js';
import { argvRequestsJson, CliRefusal, jsonFlagsOf, line, optsRequestJson, processIO, usageErrorJson } from './args.js';
import { buildProgram } from './program.js';

// Companion handshake (docs/ashlr-handshake.md): before commander, one JSON line.
if (wantsHandshake(process.argv.slice(2))) {
  const { resolvePaths } = await import('../core/store.js');
  const found = { globalLexicon: existsSync(resolvePaths().global) };
  process.stdout.write(`${JSON.stringify(buildHandshake(packageVersion(import.meta.url), found))}\n`);
  process.exit(0);
}

const program = buildProgram(processIO);
// Status is the same health report, including JSON and exit codes.
program.commands.find((command) => command.name() === 'doctor')!.alias('status');

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
// in the form its flags asked for: under --json, a `{ ok: false, error, nextStep }`
// document on stdout as well as the stderr line.
let active: Command | undefined;
program.hook('preAction', async (_thisCommand, actionCommand) => {
  active = actionCommand;
  // `hook` must always exit 0 and ignores --cwd (the payload names the
  // directory); `mcp` takes its roots from the client.
  if (actionCommand.name() === 'hook' || actionCommand.name() === 'mcp') return;
  const { cwdOptionProblem } = await import('./io.js');
  const problem = cwdOptionProblem(program.opts<{ cwd?: string }>().cwd);
  if (problem) throw problem;
});

// `-v` is the version flag in node, npm and most CLIs; commander only knows -V.
const argv = process.argv.length === 3 && process.argv[2] === '-v' ? [...process.argv.slice(0, 2), '--version'] : process.argv;

try {
  await program.parseAsync(argv);
} catch (err) {
  if (err instanceof CommanderError) {
    // commander already printed help/version/usage errors on stderr; under
    // --json a usage error also gets its stdout document. Same exit code.
    const failed = usageErrorCommand.get(err) ?? program;
    if (err.exitCode !== 0 && !NOT_USAGE_ERRORS.has(err.code) && argvRequestsJson(argv.slice(2), jsonFlagsOf(failed))) {
      const where = commandPath(failed);
      // `voice --json` promises `code` (the exit code) on every failure, its
      // own refusals and commander's alike.
      const doc = where === 'lexicon voice' ? { ...usageErrorJson(err.message, where), code: err.exitCode } : usageErrorJson(err.message, where);
      line(processIO, JSON.stringify(doc, null, 2));
    }
    process.exitCode = err.exitCode;
  } else if (err instanceof CliRefusal) {
    const { refuse } = await import('./io.js');
    process.exitCode = refuse(processIO, optsRequestJson(active?.opts<{ json?: boolean; full?: boolean }>()), err.message, err.nextStep);
  } else {
    // fail() is the same `lexicon: <message>` line plus, for a lexicon file
    // that does not parse, the command that fixes it.
    // `--full` (list, harvest) implies --json, so its failure gets the document too.
    const { fail } = await import('./io.js');
    process.exitCode = fail(processIO, err, optsRequestJson(active?.opts<{ json?: boolean; full?: boolean }>()));
  }
}
