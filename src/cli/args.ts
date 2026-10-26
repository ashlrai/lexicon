/**
 * Commander helpers and the JSON error document that --help and usage errors
 * need. No import from the core: `lexicon --help` loads this file, and loading
 * the core (zod, yaml, the matcher) is what made help slow.
 */
import { InvalidArgumentError } from 'commander';
import type { Command } from 'commander';

/**
 * Where a command writes. Handlers take one instead of touching `process`
 * directly, so a test can run a command and read back exactly what it printed.
 */
export interface IO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export const processIO: IO = {
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
};

/** Write one line to stdout. `line(io)` writes a blank one. */
export function line(io: IO, s = ''): void {
  io.stdout(`${s}\n`);
}

/**
 * The stdout document of a `--json` command that failed: `{ ok: false, error,
 * nextStep }`. `nextStep` is always there: the caller's, else DEFAULT_NEXT_STEP.
 */
export interface JsonError {
  ok: false;
  error: string;
  nextStep: string;
}

/** The `nextStep` of a failure that has no more specific one. */
export const DEFAULT_NEXT_STEP = 'fix what error names, then run the command again (its --help lists the flags)';

export function jsonError(error: string, nextStep?: string): JsonError {
  return { ok: false, error, nextStep: nextStep || DEFAULT_NEXT_STEP };
}

/** Print `jsonError(error, nextStep)` on stdout. */
export function printJsonError(io: IO, error: string, nextStep?: string): void {
  io.stdout(`${JSON.stringify(jsonError(error, nextStep), null, 2)}\n`);
}

/**
 * Whether a command line asked for `--json`: the flag appears before any `--`
 * (after it, `--json` is text for `normalize`, not a flag). `flags` are the
 * spellings that ask for JSON on that command: `--json`, plus `--full` where
 * it implies --json (`list`, `harvest`).
 */
export function argvRequestsJson(args: readonly string[], flags: readonly string[] = ['--json']): boolean {
  const end = args.indexOf('--');
  const before = end === -1 ? args : args.slice(0, end);
  return flags.some((flag) => before.includes(flag));
}

/**
 * A refusal raised before a command runs (see `cwdOptionProblem`): the CLI
 * reports it through `refuse`, so it gets the `lexicon:` lines and, under
 * --json, `{ ok: false, error, nextStep }`.
 */
export class CliRefusal extends Error {
  constructor(message: string, readonly nextStep?: string) {
    super(message);
    this.name = 'CliRefusal';
  }
}

/**
 * The flags that ask `cmd` for a JSON document: `--json`, and `--full` on a
 * command that defines it (`list --full` and `harvest --full` imply --json).
 */
export function jsonFlagsOf(cmd: { options: readonly { long?: string }[] } | undefined): string[] {
  return cmd?.options.some((o) => o.long === '--full') ? ['--json', '--full'] : ['--json'];
}

/** Whether a command's parsed options ask for JSON: `--json`, or `--full`, which implies it. */
export function optsRequestJson(opts: { json?: unknown; full?: unknown } | undefined): boolean {
  return opts?.json === true || opts?.full === true;
}

/**
 * The `--json` document for a commander usage error (an unknown option or
 * command, a missing argument, an invalid option value): commander's message
 * without its `error: ` prefix, and the `--help` command of the command that
 * rejected the line (`lexicon pack add`, or just `lexicon`) as `nextStep`.
 */
export function usageErrorJson(message: string, commandPath: string): JsonError {
  const error = message.replace(/^error:\s*/, '').trim() || 'invalid command line';
  return jsonError(error, `see the usage: ${commandPath} --help`);
}

/**
 * Names a first-time user tries that are not lexicon commands, mapped to the
 * command that does that job. commander's own suggestion goes by spelling
 * alone, so `status` got `stats` (term counts) instead of `doctor`.
 */
const OTHER_COMMAND_NAMES: Readonly<Record<string, string>> = {
  status: 'Did you mean doctor? It checks the setup; stats counts terms and hits',
  check: 'Did you mean doctor? It checks the lexicon files and the agent integration',
  version: 'the version is: lexicon --version',
  config: 'lexicon path prints where the lexicon files are; lexicon edit opens the global one',
  show: 'Did you mean list? It prints the terms',
  delete: 'Did you mean remove? e.g. lexicon remove "Ashlr.AI"',
};

/**
 * The hint for an unknown command `name` that is another tool's name for a
 * lexicon command (`status`, `version`, `config`), or undefined to keep
 * commander's spelling suggestion.
 */
export function unknownCommandHint(name: string): string | undefined {
  return Object.hasOwn(OTHER_COMMAND_NAMES, name) ? OTHER_COMMAND_NAMES[name] : undefined;
}

/**
 * A commander option parser for a positive integer flag. A refused value
 * throws InvalidArgumentError, so commander names the option (`option
 * '--limit <n>' argument '0' is invalid.`), followed by an example of a good
 * one for that flag (`expected a positive integer, e.g. --limit 50`). Only a
 * string of digits (surrounding spaces aside) is taken, so `5abc` and `1.5`
 * are refused rather than read as 5 and 1.
 */
export function positiveIntOption(flag: string, example: number, max?: number): (value: string) => number {
  return (value: string): number => {
    const n = wholeNumber(value);
    if (n === undefined || n <= 0) throw new InvalidArgumentError(`expected a positive integer, e.g. ${flag} ${example}`);
    if (max !== undefined && n > max) throw new InvalidArgumentError(`expected a positive integer of at most ${max}, e.g. ${flag} ${example}`);
    return n;
  };
}

/** Like positiveIntOption, but 0 is allowed (an `--offset` that starts at the first item). */
export function nonNegativeIntOption(flag: string, example: number): (value: string) => number {
  return (value: string): number => {
    const n = wholeNumber(value);
    if (n === undefined) throw new InvalidArgumentError(`expected a whole number (0 or more), e.g. ${flag} ${example}`);
    return n;
  };
}

/**
 * A string of digits (surrounding spaces aside) as a safe integer, else
 * undefined. The rule positiveIntOption and the handlers' own integer options
 * share: parseInt read `5abc` as 5 and `1.5` as 1.
 */
export function wholeNumber(value: string): number | undefined {
  const text = value.trim();
  if (!/^[0-9]+$/.test(text)) return undefined;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * After a missing-argument error, print `example`; after any other usage
 * error (an unknown option, say), only where the usage is. An example of the
 * right call does not answer `unknown option '--bogus'`.
 */
export function exampleAfterMissingArgument(cmd: Command, example: string): Command {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  const usage = `(use ${names.join(' ')} --help for usage)`;
  const error = cmd.error.bind(cmd);
  cmd.error = (message, errorOptions) => {
    cmd.showHelpAfterError(errorOptions?.code === 'commander.missingArgument' ? example : usage);
    return error(message, errorOptions);
  };
  return cmd;
}

/** A TCP port for `lexicon serve --port`, 0 meaning "pick a free port". */
export function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535 || String(n) !== value.trim()) {
    throw new InvalidArgumentError('expected a port between 0 and 65535 (0 picks a free port)');
  }
  return n;
}
