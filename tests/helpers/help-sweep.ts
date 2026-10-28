/**
 * Answers `lexicon <cmd> --help` for every command named on argv inside one
 * process, and prints one JSON line per command ({ cmd, code, stdout, stderr })
 * for the caller to assert on.
 *
 * argv: <program module file URL> <cwd> <command>...
 *
 * The e2e sweep used to spawn the real CLI once per registered command, about
 * thirty cold `node` starts. Under a loaded CI runner, and serially on
 * Windows where the e2e file caps its own concurrency at 1, that could outrun
 * the test's 30 s budget. Building the program per command keeps commander's
 * own help path and exit codes identical to a real spawn (run.ts maps the
 * thrown CommanderError to process.exitCode), while the spawned
 * `lexicon --help` in the test still covers the bin entry end to end.
 */
import { CommanderError } from 'commander';
import type { Command } from 'commander';
import type { IO } from '../../src/cli/args.js';
import type { buildProgram } from '../../src/cli/program.js';

const [moduleUrl, cwd, ...commands] = process.argv.slice(2);
if (moduleUrl === undefined || cwd === undefined || commands.length === 0) {
  process.stderr.write('usage: help-sweep <program module file URL> <cwd> <command>...\n');
  process.exit(2);
}
const program = ((await import(moduleUrl)) as { buildProgram: typeof buildProgram }).buildProgram;

// Command handlers take this IO; --help never reaches one, so the sink only
// has to exist.
const sink: IO = { stdout: () => undefined, stderr: () => undefined };

for (const cmd of commands) {
  let stdout = '';
  let stderr = '';
  let code = 0;
  const root = program(sink);
  // Help text is written through each command's own outputConfiguration
  // (subcommands inherit the root's only at creation, before ours is set), so
  // capture is installed on the whole tree.
  const capture = (command: Command): void => {
    command.configureOutput({
      writeOut: (s: string) => {
        stdout += s;
      },
      writeErr: (s: string) => {
        stderr += s;
      },
    });
    for (const sub of command.commands) capture(sub);
  };
  capture(root);
  try {
    // The same argv runCli hands the real binary: <cmd> --help --cwd <dir>.
    await root.parseAsync(['node', 'lexicon', cmd, '--help', '--cwd', cwd]);
  } catch (err) {
    code = err instanceof CommanderError ? err.exitCode : 1;
    if (!(err instanceof CommanderError)) stderr += `${err instanceof Error ? err.message : String(err)}\n`;
  }
  process.stdout.write(`${JSON.stringify({ cmd, code, stdout, stderr })}\n`);
}
