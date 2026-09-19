#!/usr/bin/env node
/**
 * `lexicon` CLI. Only commander wiring lives here; the behaviour is in
 * ./commands.ts so it can be unit-tested without spawning a process.
 */
import { readFileSync } from 'node:fs';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
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
import {
  processIO,
  runAdd,
  runDoctor,
  runExport,
  runHarvest,
  runInit,
  runInstallClaude,
  runList,
  runNormalize,
  runPath,
  runRemove,
} from './commands.js';
import type { ClipboardBackendName } from '../daemon/clipboard-backends.js';
import type {
  AddOptions,
  ExportCliOptions,
  HarvestCliOptions,
  InitOptions,
  InstallClaudeOptions,
  ListOptions,
  NormalizeCliOptions,
  RemoveOptions,
} from './commands.js';

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

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
  .version(readVersion())
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
  .action(async (canonical: string, aliases: string[], opts: AddOptions) =>
    done(await runAdd(canonical, aliases, withGlobals(opts), io)),
  );

program
  .command('remove')
  .alias('rm')
  .description('remove a term (project lexicon first, then global)')
  .argument('<canonical>')
  .option('--project', 'only look in the project lexicon')
  .action(async (canonical: string, opts: RemoveOptions) => done(await runRemove(canonical, withGlobals(opts), io)));

program
  .command('list')
  .alias('ls')
  .description('list terms from the merged global + project lexicon')
  .option('--json', 'print terms as JSON')
  .option('--category <category>', 'only this category')
  .option('--query <text>', 'only terms whose canonical or aliases contain this text')
  .action(async (opts: ListOptions) => done(await runList(withGlobals(opts), io)));

program
  .command('normalize')
  .description('correct dictated text (from arguments, or stdin when omitted); always exits 0')
  .argument('[text...]')
  .option('--json', 'print the full NormalizeResult as JSON')
  .option('--diff', 'print a summary of replacements to stderr')
  .option('--dry-run', 'report replacements without applying them')
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
  .option('--json', 'print candidates as JSON')
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
  .action(async () => done(await runPath(withGlobals({}), io)));

program
  .command('doctor')
  .description('check lexicon files, term conflicts and the Claude Code integration')
  .action(async () => done(await runDoctor(withGlobals({}), io)));

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

program
  .command('install-claude')
  .description('print (or with --apply, perform) the Claude Code MCP + hook setup')
  .option('--apply', 'run `claude mcp add` and merge the hook into ~/.claude/settings.json')
  .option('--scope <scope>', 'MCP registration scope: user|project', 'user')
  .action(async (opts: InstallClaudeOptions) => done(await runInstallClaude(withGlobals(opts), io)));

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

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    // commander already printed help/version/usage errors; just carry its exit code.
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`lexicon: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
