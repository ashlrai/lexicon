/**
 * Commander wiring for `lexicon`. This module stays light on purpose: --help
 * loads it, and a real command loads its handler with a dynamic import the
 * first time that command runs. Do not add a value import of io.ts, the core
 * barrel, commands.ts, or a cmd-*.ts file here.
 */
import { Command, InvalidArgumentError } from 'commander';
import { packageVersion } from '../util/package.js';
import { EXPORT_MAX_LIMIT, HARVEST_MAX_LIMIT, LIMITS, SUGGEST_MAX_LIMIT, AUTO_APPLY_CONFIDENCE, IMPORT_FORMATS } from '../core/caps.js';
import { parseBackendName } from '../daemon/clipboard-backends.js';
import type { ClipboardBackendName } from '../daemon/clipboard-backends.js';
import { INSTALL_CLIENTS, SETUP_APPS, SETUP_CLIENTS } from './client-names.js';
import { DEFAULT_PORT } from '../serve/defaults.js';
import { exampleAfterMissingArgument, nonNegativeIntOption, parsePort, positiveIntOption, unknownCommandHint } from './args.js';
import type { IO } from './args.js';
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
import type { DoctorFixOptions } from './doctor-fix.js';
import type { ImportCliOptions } from './cmd-import.js';
import type { ImportGuidedOptions } from './cmd-import-guided.js';
import type { LearnOptions, StatsOptions } from './cmd-learn.js';
import type { PackCliOptions, PackDeps, PackRegistryCliOptions } from './cmd-pack.js';
import type { PendingOptions } from './cmd-pending.js';
import type { EditOptions, ReviewOptions } from './cmd-review.js';
import type { ServeOptions } from './cmd-serve.js';
import type { SetupOptions } from './setup/types.js';
import type { SuggestCliOptions } from './cmd-suggest.js';
import type { TrustDeps } from './cmd-trust.js';
import type { UninstallOptions } from './cmd-uninstall.js';

interface DaemonCliOptions {
  interval: number;
  dryRun?: boolean;
  quiet?: boolean;
  once?: boolean;
  paste?: boolean;
  which?: boolean;
  backend?: ClipboardBackendName;
  expander?: boolean;
  socket?: string;
}

interface VoiceCliOptions {
  toggle?: boolean;
  status?: boolean;
  listDevices?: boolean;
  seconds?: number;
  device?: string;
  model: string;
  lang: string;
  translate?: boolean;
  prompt: boolean;
  history: boolean;
  copy?: boolean;
  paste?: boolean;
  json?: boolean;
  quiet?: boolean;
}

function done(code: number): void {
  if (code !== 0) process.exitCode = code;
}

function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('expected a positive number of seconds');
  return n;
}

/** The usage error of `lexicon edit <anything>`. */
const EDIT_TAKES_NO_TERM =
  'error: lexicon edit takes no term: it opens the whole lexicon file in $VISUAL/$EDITOR. To change one term: lexicon add <canonical> <alias...>, or lexicon remove <term>';

export function buildProgram(io: IO): Command {
  const program = new Command();

  program
    .name('lexicon')
    .description('Personal lexicon for voice-to-agents: fixes the words STT gets wrong before your agent sees them.')
    .version(packageVersion(import.meta.url))
    .option('--cwd <dir>', 'directory used to find the project .lexicon.yaml; must exist (default: current directory)')
    .exitOverride()
    .showHelpAfterError('(use --help for usage)')
    // No leading spaces: the e2e --help sweep reads indented lines as commands.
    .addHelpText(
      'after',
      '\nStart here: lexicon setup (the guided first run), or lexicon add "Ashlr.AI" Ashler to add one term.\nCheck an install: lexicon doctor',
    );

  // commander suggests by spelling alone; for names other tools use (`status`,
  // `version`, `config`) name the lexicon command that does that job instead.
  program.on('command:*', (operands: string[]) => {
    const name = operands[0] ?? '';
    const hint = unknownCommandHint(name);
    if (hint) program.error(`error: unknown command '${name}'\n(${hint})`, { code: 'commander.unknownCommand' });
    (program as unknown as { unknownCommand(): never }).unknownCommand();
  });

  function withGlobals<T extends object>(opts: T): T & { cwd?: string } {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { ...opts, cwd } : opts;
  }

  program
    .command('init')
    .description('create the lexicon file (global by default) if it does not exist')
    .option('--project', 'create a project .lexicon.yaml at the git root (or cwd) instead')
    .option('--dry-run', 'report the file it would create and trust; write nothing')
    .option('--json', 'print { ok: true, scope, path, created } as JSON (plus trust for --project)')
    .action(async (opts: InitOptions) => {
      const { runInit } = await import('./commands.js');
      done(await runInit(withGlobals(opts), io));
    });

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
    .option('--dry-run', 'report the term and aliases it would create or merge; write nothing')
    .option('-i, --interactive', 'confirm suggested aliases as a checklist, then ask for phonetic hint and category')
    .option(
      '--never <word...>',
      'words that must never be rewritten to this term even if they sound alike, e.g. --never sauce',
    )
    .option('--json', 'print { ok: true, term, path, created, scope, suggested } as JSON (suggested: the generated aliases this call added), plus unchanged, conflicts and note when they apply')
    .action(async (canonical: string, aliases: string[], opts: AddOptions) => {
      const { runAdd } = await import('./commands.js');
      done(await runAdd(canonical, aliases, withGlobals(opts), io));
    });
  exampleAfterMissingArgument(program.commands.at(-1)!, '(e.g. lexicon add "Ashlr.AI" Ashler Ashlar; use lexicon add --help for usage)');

  program
    .command('remove')
    .alias('rm')
    .description('remove a term (project lexicon first, then global), or one alias of it with --alias')
    .argument('<canonical>')
    .option('--alias <alias>', 'remove only this alias from the term and keep the term (exit 1 when the term or alias is unknown)')
    .option('--dry-run', 'report the term or alias it would remove; write nothing')
    .option('--project', 'only look in the project lexicon')
    .option('--global', 'only look in the global lexicon (not with --project)')
    .option('--json', 'print { ok: true, canonical, removed } as JSON (exit 1 when not found, with ok: false and error), plus stillIn when a copy is left in the other lexicon file and untrustedProject when the untrusted project lexicon has one; with --alias also alias, aliases and paths')
    .action(async (canonical: string, opts: RemoveOptions) => {
      const { runRemove } = await import('./commands.js');
      done(await runRemove(canonical, withGlobals(opts), io));
    });
  exampleAfterMissingArgument(
    program.commands.at(-1)!,
    '(e.g. lexicon remove "Ashlr.AI", or lexicon remove "Ashlr.AI" --alias Ashler; lexicon list shows the terms; use lexicon remove --help for usage)',
  );

  program
    .command('list')
    .alias('ls')
    .description('list terms from the merged global + project lexicon')
    .option('--json', 'print terms as JSON (a bare array)')
    .option('--full', 'print { ok: true, terms, counts, paths } as JSON, ok and then the object MCP list_terms returns, plus projectTrust, skippedProject and note when an untrusted project lexicon was left out, or note alone when nothing matched, and page { offset, limit?, returned, nextOffset? } with --offset or --limit (nextOffset is the next page\'s --offset, while matches remain) (implies --json)')
    .option('--category <category>', 'only this category')
    .option('--query <text>', 'only terms whose canonical or aliases contain this text')
    .option('--offset <n>', 'skip this many matching terms first (default 0)', nonNegativeIntOption('--offset', 50))
    .option('--limit <n>', 'print at most this many matching terms (default: every one)', positiveIntOption('--limit', 50))
    .action(async (opts: ListOptions) => {
      const { runList } = await import('./commands.js');
      done(await runList(withGlobals(opts), io));
    });

  program
    .command('normalize')
    .description('correct dictated text (from arguments, or stdin when omitted); stdout always round-trips the input, exit 1 if the lexicon could not be read')
    .argument('[text...]')
    .option('--json', 'print ok: true and the full NormalizeResult as JSON ({ ok: false, error, nextStep } and the unchanged input when the lexicon fails to load; { ok: false, error, nextStep } alone for a bad --min-confidence), plus example: true when the built-in example terms stood in and projectTrust, skippedProject and note when an untrusted project lexicon was left out')
    .option('--diff', 'print a summary of replacements to stderr (with --json too)')
    .option('--dry-run', 'print the replacement summary to stderr and the text unchanged to stdout')
    .option('--min-confidence <n>', 'minimum confidence (0..1) for fuzzy/phonetic matches')
    .option('--no-phonetic', 'disable phonetic matching')
    .option('--no-fuzzy', 'disable fuzzy (edit-distance) matching')
    .option('--include-untrusted', 'merge the project .lexicon.yaml even if it has not been trusted')
    .action(async (text: string[], opts: NormalizeCliOptions) => {
      const { runNormalize } = await import('./commands.js');
      done(await runNormalize(text, withGlobals(opts), io));
    });

  program
    .command('harvest')
    .description('scan a repository for names worth adding to the lexicon')
    .argument('[path]', 'repository root (default: cwd)')
    .option('--limit <n>', `max candidates (default 50, at most ${HARVEST_MAX_LIMIT})`, positiveIntOption('--limit', 50, HARVEST_MAX_LIMIT))
    .option('--min-count <n>', 'minimum occurrences for a name found only in file text (default 2); the directory name, git authors, package names and dot-TLD brands (Ashlr.AI) are proposed at any count', positiveIntOption('--min-count', 2))
    .option('--add', 'add candidates (with suggested aliases) to the project lexicon; on a terminal this walks them one by one')
    .option('-i, --interactive', 'walk candidates one by one: y add, n skip, e edit aliases, c category, a add all, q quit')
    .option('--yes', 'with --add: add every candidate without prompting')
    .option('--dry-run', 'with --add: report the terms it would add or merge; write nothing')
    .option('--symbols', 'also propose names seen only as a code symbol (off: they are what you type, not what you say)')
    .option('--json', 'print candidates as JSON (a bare array; with --add it is printed after the writes, the add summary goes to stderr, and a failed write prints only { ok: false, error, added, created, merged, path })')
    .option('--full', 'print { ok: true, root, candidates, count } as JSON, the keys MCP harvest_repo returns, plus added, created, merged and path with --add (implies --json)')
    .action(async (root: string | undefined, opts: HarvestCliOptions) => {
      const { runHarvest } = await import('./commands.js');
      done(await runHarvest(root, withGlobals(opts), io));
    });

  program
    .command('export')
    .description('export the merged lexicon for another tool (run without a format to list them)')
    .argument('[format]')
    .option('--out <file>', 'write to a file instead of stdout')
    .option('--dry-run', 'with --out: report the export format, terms, bytes and path; write nothing')
    .option('--category <categories...>', 'only these categories, space- or comma-separated')
    .option('--limit <n>', `cap the number of terms, applied after --category, keeping the most hits first (at equal hits brand, person and product terms first, then canonical A to Z); csv, wispr, superwhisper, macos and espanso (one row per alias) count only terms that have an alias; at most ${EXPORT_MAX_LIMIT}`, positiveIntOption('--limit', 50, EXPORT_MAX_LIMIT))
    .option('--json', 'print { ok: true, format, terms, bytes, path } after writing --out, or { ok: true, format, terms, bytes, content } with the export as a string without it; { ok: true, formats } with no format (plus rows for the one-row-per-alias formats, dropped (one sentence per kind of entry the format left out to fit its target, also printed on stderr without --json), and projectTrust, skippedProject and note when an untrusted project lexicon was left out)')
    .action(async (format: string | undefined, opts: ExportCliOptions) => {
      const { runExport } = await import('./commands.js');
      done(await runExport(format, withGlobals(opts), io));
    });

  program
    .command('path')
    .description('print the resolved global and project lexicon paths')
    .option('--json', 'print { ok: true, global, project } as JSON (project is null when there is no project lexicon)')
    .action(async (opts: PathOptions) => {
      const { runPath } = await import('./commands.js');
      done(await runPath(withGlobals(opts), io));
    });

  program
    .command('doctor')
    .description('check lexicon files, term conflicts and the Claude Code integration')
    .option('--json', 'print the report as JSON ({ ok, ready, summary, nextStep, checks, ... } plus error, the first failing check, when ok is false; as the lexicon_doctor MCP tool returns it). With --fix: { mode, plan, outcome }')
    .option('--fix', 'preview safe repairs (writes nothing): create a missing global lexicon, move aside an unusable trust, hits, pending or index cache file')
    .option('--apply', 'with --fix: make the repairs, backing up each file first (exit 1 if one was skipped)')
    .action(async (opts: DoctorCliOptions & DoctorFixOptions) => {
      const o = withGlobals(opts);
      if (o.apply && !o.fix) {
        const { refuseApplyWithoutFix } = await import('./doctor-fix.js');
        return done(refuseApplyWithoutFix(io, o.json));
      }
      if (o.fix) {
        const { runDoctorFix } = await import('./doctor-fix.js');
        return done(await runDoctorFix(o, io));
      }
      const { runDoctor } = await import('./commands.js');
      return done(await runDoctor(o, io));
    });

  program
    .command('mcp')
    .description('start the stdio MCP server (what `claude mcp add` points at)')
    .action(async () => {
      const { main } = await import('../mcp/server.js');
      await main();
    });

  program
    .command('hook')
    .description('run as a Claude Code UserPromptSubmit or SessionStart hook (reads the hook JSON from stdin)')
    .action(async () => {
      const { main } = await import('../hooks/user-prompt-submit.js');
      // commander already parsed this command's argv; the hook reads only stdin.
      await main([]);
    });

  program
    .command('daemon')
    .description('watch the clipboard (macOS, Linux, Windows) and correct dictated text in place')
    .option('--once', 'correct the clipboard once and exit (for a keyboard shortcut after dictating)')
    .option('--paste', 'with --once: send Cmd+V afterwards (macOS only; needs Accessibility permission)')
    .option('--interval <ms>', 'poll interval in milliseconds (at least 20; a smaller value is raised to 20, with a warning)', positiveIntOption('--interval', 250), 250)
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
    .option('--expander', 'opt in: run the resident expander instead, answering keystrokes and corrections over a local socket')
    .option('--socket <path>', 'with --expander: the socket to listen on (default $XDG_RUNTIME_DIR/lexicon/expander.sock)')
    .action(async (opts: DaemonCliOptions) => {
      const { cwd } = withGlobals({});
      const { runDaemonCommand } = await import('../daemon/clipboard.js');
      done(
        await runDaemonCommand({
          intervalMs: opts.interval,
          dryRun: opts.dryRun ?? false,
          quiet: opts.quiet ?? false,
          once: opts.once ?? false,
          paste: opts.paste ?? false,
          which: opts.which ?? false,
          expander: opts.expander ?? false,
          ...(opts.socket !== undefined ? { socketPath: opts.socket } : {}),
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
    .option('--scope <scope>', 'user|project (project = the repo-level config file)')
    .option('--project', 'same as --scope project')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print { ok: true, client, scope, applied, written, output } as JSON, as `lexicon install claude --json` does')
    .action(async (opts: InstallOptions) => {
      const { runInstall } = await import('./cmd-install.js');
      done(await runInstall('claude', withGlobals(opts), io));
    });

  registerImportCommands(program, io);
  registerInstallCommands(program, io);
  registerUninstallCommands(program, io);
  registerTrustCommands(program, io);
  registerLearnCommands(program, io);
  registerPendingCommands(program, io);
  registerServeCommands(program, io);
  registerVoiceCommands(program, io);
  registerSetupCommands(program, io);
  registerSuggestCommands(program, io);
  registerReviewCommands(program, io);
  registerPackCommands(program, io);

  return program;
}

export function registerImportCommands(program: Command, io: IO): void {
  program
    .command('import')
    .description('import an existing dictionary (Wispr Flow, Superwhisper, macOS, espanso, markdown, text, csv, json) into the lexicon, or --guided to harvest names from your contacts, calendar and GitHub')
    .argument('[file]', 'file to import, or - for stdin (not used with --guided)')
    .argument('[format]', `one of: ${IMPORT_FORMATS.join(', ')} (default: auto)`)
    .option('--format <format>', 'same as the positional format argument')
    .option('--project', 'write to the project lexicon instead of the global one')
    .option('--dry-run', 'print what would be added without writing')
    .option('--source <source>', 'source recorded on each term (default: import)')
    .option('--category <category>', 'category applied to imported terms that lack one')
    .option('--guided', 'guided vocabulary import: pick sources (contacts, calendar, github) and approve each candidate before it is written')
    .option('--sources <list>', 'with --guided: explicit comma-separated sources to harvest (required non-interactively)')
    .option('--limit <n>', 'with --guided: max candidates to review (default: 50)')
    .option('-y, --yes', 'with --guided: apply approved candidate ids (requires --sources, --preview-id and --accept)')
    .option('--preview-id <digest>', 'with --guided --yes: digest returned by the prior JSON preview')
    .option('--accept <ids>', 'with --guided --yes: comma-separated candidate ids the user approved')
    .option('--home <dir>', 'with --guided: treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print the result as JSON')
    .action(async (file: string | undefined, formatArg: string | undefined, opts: ImportCliOptions & ImportGuidedOptions) => {
      const { runImportCli } = await import('./cmd-import.js');
      await runImportCli(program, io, file, formatArg, opts);
    });
}

export function registerInstallCommands(program: Command, io: IO): void {
  program
    .command('install')
    .description('print (or with --apply, write) the MCP config for an agent client; no client lists them')
    .argument('[client]', `one of: ${INSTALL_CLIENTS.join(', ')}`)
    .option('--apply', 'write the config file (merge; existing keys are kept)')
    .option('--scope <scope>', 'user|project (project = the repo-level config file)')
    .option('--project', 'same as --scope project')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print { ok: true, client, scope, applied, written, output } as JSON ({ ok: false, error, nextStep } for an unknown client or scope)')
    .action(async (client: string | undefined, opts: InstallOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const { runInstall } = await import('./cmd-install.js');
      const code = await runInstall(client, cwd ? { ...opts, cwd } : opts, io);
      if (code !== 0) process.exitCode = code;
    });
}

export function registerUninstallCommands(program: Command, io: IO): void {
  program
    .command('uninstall')
    .description('remove the MCP config (and, for claude, the hooks) lexicon install wrote for a client; nothing else is touched')
    .argument('[client]', `one of: ${INSTALL_CLIENTS.filter((c) => c !== 'generic').join(', ')}`)
    .option('--dry-run', 'print what would be removed; write nothing')
    .option('--scope <scope>', 'user|project (project = the repo-level config file), as for install')
    .option('--project', 'same as --scope project')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print { ok: true, client, scope, dryRun, changes, output } as JSON ({ ok: false, error, nextStep } on a refusal)')
    .action(async (client: string | undefined, opts: UninstallOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const { runUninstall } = await import('./cmd-uninstall.js');
      const code = await runUninstall(client, cwd ? { ...opts, cwd } : opts, io);
      if (code !== 0) process.exitCode = code;
    });
}

export function registerTrustCommands(program: Command, io: IO, deps: TrustDeps = {}): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };

  program
    .command('trust')
    .description('approve a project .lexicon.yaml so its terms are merged (shows a preview, then asks on a terminal)')
    .argument('[path]', 'lexicon file or project directory (default: the project .lexicon.yaml for the current directory)')
    .option('--list', 'list trusted project lexicons and whether they still match')
    .option('-y, --yes', 'trust without asking (required off a terminal)')
    .option('--dry-run', 'show the preview and the pin it would write; ask nothing, pin nothing')
    .option('--json', 'print the result as JSON: ok, then the object MCP trust_project returns, with the full preview where MCP has a summary (with --list: { ok, registry, trustAll, trusted })')
    .action(async (target: string | undefined, opts: { list?: boolean; yes?: boolean; dryRun?: boolean; json?: boolean }) => {
      const { runTrust } = await import('./cmd-trust.js');
      done(await runTrust(target, { ...opts, ...globals() }, io, deps));
    });

  program
    .command('untrust')
    .description('revoke approval for a project .lexicon.yaml')
    .argument('[path]', 'lexicon file or project directory (default: the project .lexicon.yaml for the current directory)')
    .option('--dry-run', 'report the registry entry it would remove; write nothing')
    .option('--json', 'print { ok, action, path, removed, registry, summary } as JSON, as MCP trust_project returns it plus ok')
    .action(async (target: string | undefined, opts: { json?: boolean; dryRun?: boolean }) => {
      const { runUntrust } = await import('./cmd-trust.js');
      done(await runUntrust(target, { ...opts, ...globals() }, io));
    });
}

export function registerLearnCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };

  program
    .command('learn')
    .description('record a spelling correction: what STT heard and what you meant')
    .argument('[words...]', '<heard> <meant>, or a sentence like "Ashler -> Ashlr.AI"')
    .option('--from <sentence>', 'parse a natural-language correction, e.g. "it\'s Ashlr.AI not Ashler" (instead of <heard> <meant>, not with them)')
    .option('--project', 'write to the project lexicon (default: the file that already holds the meant term, else the global one)')
    .option('--dry-run', 'report what would be learned; write nothing')
    .option('--json', 'print the result as JSON')
    // A bare "->" would otherwise be rejected as an unknown option; let it through
    // as a word so `lexicon learn Ashler -> Ashlr.AI` works without `--`.
    .allowUnknownOption()
    .action(async (words: string[], opts: LearnOptions) => {
      const { runLearn } = await import('./cmd-learn.js');
      done(await runLearn(words, { ...opts, ...globals() }, io));
    });

  program
    .command('stats')
    .description('show term/alias counts, most-used terms and terms that never fired')
    .option('--json', 'print the stats as JSON')
    .action(async (opts: StatsOptions) => {
      const { runStats } = await import('./cmd-learn.js');
      done(await runStats({ ...opts, ...globals() }, io));
    });
}

export function registerPendingCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  // `pending` takes --json too, and commander gives a flag both levels define
  // to the parent: `pending accept <id> --json` set it on `pending`, so the
  // subcommand saw none and printed text (or nothing) on stdout.
  const withParent = (opts: PendingOptions): PendingOptions => ({
    ...opts,
    ...(opts.json || pending.opts<PendingOptions>().json ? { json: true } : {}),
    ...globals(),
  });
  const pending = program
    .command('pending')
    .description('review aliases noticed in your corrections; nothing is applied until you accept')
    .option('--json', 'print { ok: true, file, pending } as JSON, each entry with alreadyKnown')
    .action(async (opts: PendingOptions) => {
      const { runPendingList } = await import('./cmd-pending.js');
      done(await runPendingList({ ...opts, ...globals() }, io));
    });
  pending
    .command('list')
    .description('list pending aliases')
    .option('--json', 'print { ok: true, file, pending } as JSON, each entry with alreadyKnown')
    .action(async (opts: PendingOptions) => {
      const { runPendingList } = await import('./cmd-pending.js');
      done(await runPendingList(withParent(opts), io));
    });
  pending
    .command('accept')
    .description('learn pending aliases (as lexicon learn does) and remove them from the queue')
    .argument('[ids...]', 'ids from lexicon pending')
    .option('--all', 'accept every pending alias')
    .option('--dry-run', 'report what would be learned and dequeued; write nothing')
    .option('--json', 'print { ok, file, accepted, failed, unknown } as JSON (ok: false and exit 1 when an id is unknown or not accepted)')
    .action(async (ids: string[], opts: PendingOptions) => {
      const { runPendingAccept } = await import('./cmd-pending.js');
      done(await runPendingAccept(ids, withParent(opts), io));
    });
  pending
    .command('reject')
    .description('drop pending aliases without learning them')
    .argument('[ids...]', 'ids from lexicon pending')
    .option('--all', 'reject every pending alias')
    .option('--dry-run', 'report what would be dequeued; write nothing')
    .option('--json', 'print { ok, file, rejected, unknown } as JSON (ok: false and exit 1 when an id is unknown)')
    .action(async (ids: string[], opts: PendingOptions) => {
      const { runPendingReject } = await import('./cmd-pending.js');
      done(await runPendingReject(ids, withParent(opts), io));
    });
}

export function registerServeCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };

  program
    .command('serve')
    .description(`run the local HTTP API on http://127.0.0.1:${DEFAULT_PORT} for extensions, Shortcuts, Raycast and desktop apps`)
    .option('--port <n>', `port to listen on (default ${DEFAULT_PORT}; 0 picks a free port)`, parsePort)
    .option('--host <host>', 'interface to bind (default 127.0.0.1; anything else is exposed to the network)')
    .option('--json', 'print the listening info (or the --show, --status, --pair, --install or --uninstall result) as JSON, led by ok (for --status, ok equals up)')
    .option('--quiet', 'do not log each request; failures and start/stop are still printed (the installed service runs with it; refused with --show, --status, --pair, --install, --uninstall)')
    .option('--show', 'print the URL and bearer token (for the extension options page) and exit')
    .option('--status', 'check whether the server is up and exit')
    .option('--pair', `open http://127.0.0.1:${DEFAULT_PORT}/pair in your browser so the extension pairs itself, and exit`)
    .option('--install', 'install as a login service (launchd on macOS, systemd --user on Linux, a Scheduled Task on Windows)')
    .option('--uninstall', 'remove the login service')
    .action(async (opts: ServeOptions) => {
      const { runServe } = await import('./cmd-serve.js');
      done(await runServe({ ...opts, ...globals() }, io));
    });
}

export function registerVoiceCommands(program: Command, io: IO): void {
  program
    .command('voice')
    .description('dictate locally: record the microphone, transcribe with whisper.cpp, correct with the lexicon')
    .option('--toggle', 'hotkey mode: first call starts recording in the background, second call stops and transcribes. the first call records with its --device and --seconds, the second transcribes and delivers with its own --model, --lang, --translate, --no-prompt, --no-history, --copy and --paste, so give both calls the same flags')
    .option('--status', 'print "recording since <time>" (exit 0) or "idle" (exit 1)')
    .option('--list-devices', 'print the audio input devices ffmpeg can see')
    .option('--seconds <n>', 'stop recording after n seconds instead of waiting for Enter (with --toggle, at most 600)', positiveNumber)
    .option('--device <name|index>', 'input device (default: the system default microphone)')
    .option('--model <name|path>', 'whisper model: a name like base.en or small.en (auto-downloaded) or a ggml file', 'base.en')
    .option('--lang <code>', 'spoken language', 'en')
    .option('--translate', 'translate to English (whisper -tr)')
    .option('--no-prompt', 'do not pass the lexicon canonicals as the whisper initial prompt')
    .option('--no-history', 'do not append to voice/history.jsonl')
    .option('--copy', 'also put the corrected text on the clipboard')
    .option('--paste', 'copy and paste into the frontmost app (macOS; needs Accessibility permission)')
    .option('--json', 'print { ok: true, raw, output, replacements, summary, model, seconds, ms } as JSON (with --toggle, a press that starts prints {"status":"recording"}; with --status, { ok: true, recording: true, since, pid } while recording or { ok: false, recording: false } when idle); every failure prints { ok: false, error, nextStep?, code } with code the exit code (over the result when there is text, e.g. nothing heard or a failed --paste)')
    .option('--quiet', 'no status lines on stderr')
    .action(async (opts: VoiceCliOptions, cmd: Command) => {
      const { runVoiceCli } = await import('./cmd-voice.js');
      await runVoiceCli(program, io, opts, cmd);
    });
}

export function registerSetupCommands(program: Command, io: IO): void {
  program
    .command('setup')
    .description('guided first-run: seed the lexicon, harvest the repo, install into your agents and dictation app')
    .option('-y, --yes', 'take every default without prompting')
    .option('--clients <list>', `comma-separated clients to install into, or none (default: detect; one of ${SETUP_CLIENTS.join(', ')})`)
    .option('--company <name>', `company or product name to seed (as you want it spelled; one line, at most ${LIMITS.word} characters)`)
    .option('--person <name>', `your name to seed, one line of at most ${LIMITS.word} characters (default: git user.name, global then this repo, or $GIT_AUTHOR_NAME)`)
    .option('--phonetic <hint>', 'pronunciation hint for the company term, e.g. ASH-ler')
    .option('--app <app>', `dictation app to export for: ${SETUP_APPS.join('|')}`)
    .option('--export-dir <dir>', 'where to write the dictation export (default: ~/Desktop)')
    .option('--harvest', 'add the repo names to the project lexicon (with --yes it is skipped unless this is passed)')
    .option('--packs <list>', 'comma-separated starter packs to install, or none (default: a checklist on a terminal, nothing with --yes; one of developer, ai, business, voice-tools, cloud-devops, profession-q8)')
    .option('--no-packs', 'skip the starter packs (no prompt)')
    .option('--no-harvest', 'skip the repo harvest (no prompt)')
    .option('--serve', 'install the local API login service (with --yes it is skipped unless this is passed)')
    .option('--no-serve', 'skip installing the local API login service (no prompt)')
    .option('--dry-run', 'detect and suggest only; write nothing and print what a run would do')
    .option('--reseed', 'also seed the guessed person/company (git user.name, package scope) when the lexicon already has terms')
    .option('--home <dir>', 'treat <dir> as the home directory (mainly for tests)')
    .option('--json', 'print a machine-readable summary on stdout, led by ok (progress goes to stderr; a refusal prints { ok: false, error, nextStep })')
    .action(async (opts: SetupOptions) => {
      const { runSetupCli } = await import('./cmd-setup.js');
      await runSetupCli(program, io, opts);
    });
}

export function registerSuggestCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };

  program
    .command('suggest')
    .description('suggest aliases, new terms, never-words and stale terms from your voice history')
    .option('--json', 'print the suggestions as JSON; with --yes, one document naming what was applied and the file each went to')
    .option('--apply', 'walk the suggestions one by one: y apply, n skip, a apply all remaining, q quit')
    .option('--yes', `apply every suggestion at or above ${AUTO_APPLY_CONFIDENCE.toFixed(2)} confidence without asking`)
    .option('--harvest [dir]', 'also harvest a repository for new-term candidates (default: the --cwd directory); an explicit --cwd harvests too')
    .option('--limit <n>', `max suggestions (default 20, at most ${SUGGEST_MAX_LIMIT})`, positiveIntOption('--limit', 20, SUGGEST_MAX_LIMIT))
    .option('--project', 'write new terms to the project lexicon instead of the global one')
    .action(async (opts: SuggestCliOptions) => {
      const { runSuggest } = await import('./cmd-suggest.js');
      done(await runSuggest({ ...opts, ...globals() }, io));
    });
}

export function registerReviewCommands(program: Command, io: IO): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };

  program
    .command('review')
    .description('walk through existing terms and keep, delete or edit each one')
    .option('--dry-run', 'walk through the review and report the changes; write nothing')
    .option('--never-hit', 'only terms that have never fired (0 hits)')
    .option('--project', 'review the project .lexicon.yaml instead of the global file')
    .option('--global', 'review the global lexicon (the default)')
    .option('--category <category>', 'only this category')
    .option('--json', 'refused (exit 1): review asks about each term; prints { ok: false, error, nextStep } naming list --json, remove and add, and the MCP tools')
    .action(async (opts: ReviewOptions) => {
      const { runReview } = await import('./cmd-review.js');
      done(await runReview({ ...opts, ...globals() }, io));
    });

  const edit = program
    .command('edit')
    .description('open the global lexicon (or --project) in $VISUAL/$EDITOR and validate it afterwards')
    .option('--dry-run', 'report the file it would create or open; do not launch an editor or write anything')
    .option('--project', 'open the project .lexicon.yaml instead of the global file')
    .option('--json', 'refused (exit 1): edit opens an editor; prints { ok: false, error, nextStep } naming add, remove and the MCP tools')
    .action(async (opts: EditOptions) => {
      const { runEdit } = await import('./cmd-review.js');
      done(await runEdit({ ...opts, ...globals() }, io));
    });
  // `lexicon edit Nope` got commander's "Expected 0 arguments but got 1",
  // which did not say that edit opens the whole file, or what changes one term.
  const error = edit.error.bind(edit);
  edit.error = (message, errorOptions) =>
    error(errorOptions?.code === 'commander.excessArguments' ? EDIT_TAKES_NO_TERM : message, errorOptions);
}

export function registerPackCommands(program: Command, io: IO, deps: PackDeps = {}): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };

  const pack = program
    .command('pack')
    .description('starter term packs (developer, ai, business, voice-tools, cloud-devops, profession-q8) and community packs (<author>/<name> via --registry): list, add, remove, show, search, update, validate')
    .action(() => {
      pack.outputHelp();
    });

  pack
    .command('list')
    .alias('ls')
    .description('list the available packs and which are installed')
    .option('--json', 'print the packs as JSON')
    .option('--registry <index>', 'also list the community packs in this registry index')
    .option('--project', 'list community packs installed in this project')
    .action(async (opts: PackRegistryCliOptions) => {
      const { runPackList } = await import('./cmd-pack.js');
      done(await runPackList({ ...opts, ...globals() }, io, deps));
    });

  exampleAfterMissingArgument(
    pack
      .command('add')
      .description('install one or more packs into the global lexicon (existing terms only gain aliases); <author>/<name> installs a community pack after a preview')
      .argument('<name...>', 'pack names, e.g. developer ai, or community refs like example/cardiology')
      .option('--project', 'install into the project .lexicon.yaml instead')
      .option('--registry <index>', 'registry index for community pack refs (local path, file:// or https:// URL)')
      .option('-y, --yes', 'accept the community-pack preview without prompting (required off a terminal)')
      .option('--dry-run', 'compute and show the install each pack would make; ask nothing, write nothing')
      .option('--json', 'print the results as JSON')
      .action(async (names: string[], opts: PackRegistryCliOptions) => {
        const { runPackAdd } = await import('./cmd-pack.js');
        done(await runPackAdd(names, { ...opts, ...globals() }, io, deps));
      }),
    '(e.g. lexicon pack add developer; lexicon pack list shows the packs; use lexicon pack add --help for usage)',
  );

  exampleAfterMissingArgument(
    pack
      .command('remove')
      .alias('rm')
      .description('remove a pack; terms you edited since (hits, extra aliases) are kept')
      .argument('<name>', 'pack name or community ref (author/name)')
      .option('--project', 'only look in the project .lexicon.yaml')
      .option('--registry <index>', 'registry index to re-fetch a community pack whose cache is gone')
      .option('--dry-run', 'report which terms would be removed and kept; write nothing')
      .option('--json', 'print the result as JSON')
      .action(async (name: string, opts: PackRegistryCliOptions) => {
        const { runPackRemove } = await import('./cmd-pack.js');
        done(await runPackRemove(name, { ...opts, ...globals() }, io, deps));
      }),
    '(e.g. lexicon pack remove developer; lexicon pack list shows which are installed; use lexicon pack remove --help for usage)',
  );

  exampleAfterMissingArgument(
    pack
      .command('show')
      .description('print the terms and aliases a pack contains')
      .argument('<name>', 'pack name or community ref (author/name, needs --registry)')
      .option('--registry <index>', 'registry index for community pack refs')
      .option('--json', 'print the pack as JSON')
      .action(async (name: string, opts: PackRegistryCliOptions) => {
        const { runPackShow } = await import('./cmd-pack.js');
        done(await runPackShow(name, { ...opts, ...globals() }, io, deps));
      }),
    '(e.g. lexicon pack show developer; lexicon pack list shows the packs; use lexicon pack show --help for usage)',
  );

  pack
    .command('search')
    .description('search community packs in a registry index by name, title, description or author')
    .argument('<query>', 'what to look for, e.g. cardiology')
    .option('--registry <index>', 'registry index to search (local path, file:// or https:// URL)')
    .option('--json', 'print the matches as JSON')
    .action(async (query: string, opts: PackRegistryCliOptions) => {
      const { runPackSearch } = await import('./cmd-pack.js');
      done(await runPackSearch(query, { ...opts, ...globals() }, io, deps));
    });

  pack
    .command('update')
    .description('re-check installed community packs against a fresh index; every changed pack is previewed and confirmed, never silent')
    .argument('[refs...]', 'community refs to update (default: every installed community pack)')
    .option('--project', 'update only community packs installed in this project')
    .option('--registry <index>', 'registry index to check (default: the index each pack was installed from)')
    .option('-y, --yes', 'apply every available update without prompting (required off a terminal)')
    .option('--dry-run', 'compute each available update and report what it would write; ask nothing, write nothing')
    .option('--json', 'print the update report as JSON')
    .action(async (refs: string[], opts: PackRegistryCliOptions) => {
      const { runPackUpdate } = await import('./cmd-pack.js');
      done(await runPackUpdate(refs, { ...opts, ...globals() }, io, deps));
    });

  pack
    .command('validate')
    .description('check a pack file against the community publish bar (schema, author, the ordinary-word guard)')
    .argument('<file>', 'pack YAML file to validate')
    .option('--strict', 'treat warnings as errors (exit 1 when any are reported)')
    .option('--json', 'print the errors and warnings as JSON')
    .action(async (file: string, opts: PackCliOptions) => {
      const { runPackValidate } = await import('./cmd-pack.js');
      done(await runPackValidate(file, { ...opts, ...globals() }, io));
    });
}
