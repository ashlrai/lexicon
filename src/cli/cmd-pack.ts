/**
 * `lexicon pack list|add|remove|show`: the starter term packs shipped in
 * `packs/`. Handlers are exported for tests; registerPackCommands() only wires
 * commander. Every handler prints a table (or JSON with --json) and returns the
 * exit code; a `ProjectTrustError` on `--project` is reported like everywhere
 * else and never bypassed.
 */
import type { Command } from 'commander';
import { ProjectTrustError, installPack, installedPacks, listPacks, loadPack, uninstallPack } from '../core/index.js';
import { loadLexicon } from '../core/index.js';
import type { InstallPackResult, TermScope, UninstallPackResult } from '../core/index.js';
import { fail, line, renderTable, resolveCwd, safe } from './io.js';
import type { CommonOptions, IO } from './io.js';

export interface PackCliOptions extends CommonOptions {
  json?: boolean;
  /** Install into / remove from the project .lexicon.yaml instead of the global file. */
  project?: boolean;
}

export interface PackDeps {
  /** Directory holding the pack files (tests). Default: the package's packs/. */
  dir?: string;
}

function scopeOf(opts: PackCliOptions): TermScope {
  return opts.project ? 'project' : 'global';
}

/** `lexicon pack list`: every pack with its size and whether it is installed. */
export async function runPackList(opts: PackCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const packs = await listPacks(deps);
    const installed = installedPacks(await loadLexicon({ cwd }));
    const rows = packs.map((p) => ({ ...p, installed: installed.includes(p.name) }));
    if (opts.json) {
      line(io, JSON.stringify({ packs: rows, installed }, null, 2));
      return 0;
    }
    if (rows.length === 0) {
      line(io, 'no packs found');
      return 0;
    }
    io.stdout(
      renderTable(
        rows.map((p) => [p.name, p.title, String(p.terms), String(p.aliases), p.installed ? 'yes' : '', p.description]),
        ['name', 'title', 'terms', 'aliases', 'installed', 'description'],
      ),
    );
    line(io, 'add one with: lexicon pack add <name>   (lexicon pack show <name> lists its terms)');
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

/** `lexicon pack add <name...>`: install one or more packs. Stops at the first failure and exits 1. */
export async function runPackAdd(names: readonly string[], opts: PackCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const scope = scopeOf(opts);
  const results: InstallPackResult[] = [];
  for (const name of names) {
    try {
      const result = await installPack(name, { cwd, scope, ...deps });
      results.push(result);
      if (!opts.json) {
        line(
          io,
          `installed ${safe(result.pack.name)} (${result.pack.title}): ${result.added} added, ${result.merged} merged into ${safe(result.path)}`,
        );
      }
    } catch (err) {
      if (opts.json && results.length > 0) line(io, JSON.stringify(results, null, 2));
      if (err instanceof ProjectTrustError) return fail(io, err);
      return fail(io, err);
    }
  }
  if (opts.json) line(io, JSON.stringify(results, null, 2));
  else if (results.length > 0) line(io, 'the terms are live: normalize_transcript, the hook and the local API pick them up on the next call');
  return 0;
}

/** `lexicon pack remove <name>`: uninstall a pack, keeping terms the user edited. */
export async function runPackRemove(name: string, opts: PackCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const result: UninstallPackResult = await uninstallPack(name, { cwd, ...(opts.project ? { scope: 'project' as const } : {}), ...deps });
    if (opts.json) {
      line(io, JSON.stringify(result, null, 2));
      return 0;
    }
    if (result.files.length === 0) {
      line(io, `${safe(name)} is not installed`);
      return 0;
    }
    line(io, `removed ${result.removed.length} term${result.removed.length === 1 ? '' : 's'} of ${safe(name)} from ${safe(result.files.join(', '))}`);
    if (result.kept.length > 0) {
      line(io, `kept ${result.kept.length} you edited (hits, extra aliases or never-words): ${safe(result.kept.join(', '))}`);
    }
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

/** `lexicon pack show <name>`: the pack's terms and aliases. */
export async function runPackShow(name: string, opts: PackCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  try {
    const pack = await loadPack(name, deps);
    if (opts.json) {
      line(io, JSON.stringify(pack, null, 2));
      return 0;
    }
    line(io, `${pack.name}: ${pack.title} (${pack.terms} terms, ${pack.aliases} aliases)`);
    if (pack.description) line(io, pack.description);
    line(io);
    io.stdout(
      renderTable(
        pack.lexicon.terms.map((t) => [t.canonical, t.category ?? '', t.aliases.join(', '), t.never ? `never: ${t.never.join(', ')}` : '']),
        ['canonical', 'category', 'aliases', ''],
      ),
    );
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

// ---------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------

export function registerPackCommands(program: Command, io: IO, deps: PackDeps = {}): void {
  const globals = (): { cwd?: string } => {
    const { cwd } = program.opts<{ cwd?: string }>();
    return cwd ? { cwd } : {};
  };
  const done = (code: number): void => {
    if (code !== 0) process.exitCode = code;
  };

  const pack = program
    .command('pack')
    .description('starter term packs (developer, ai, business, voice-tools): list, add, remove, show')
    .action(() => {
      pack.outputHelp();
    });

  pack
    .command('list')
    .alias('ls')
    .description('list the available packs and which are installed')
    .option('--json', 'print the packs as JSON')
    .action(async (opts: PackCliOptions) => done(await runPackList({ ...opts, ...globals() }, io, deps)));

  pack
    .command('add')
    .description('install one or more packs into the global lexicon (existing terms only gain aliases)')
    .argument('<name...>', 'pack names, e.g. developer ai')
    .option('--project', 'install into the project .lexicon.yaml instead')
    .option('--json', 'print the results as JSON')
    .action(async (names: string[], opts: PackCliOptions) => done(await runPackAdd(names, { ...opts, ...globals() }, io, deps)));

  pack
    .command('remove')
    .alias('rm')
    .description('remove a pack; terms you edited since (hits, extra aliases) are kept')
    .argument('<name>')
    .option('--project', 'only look in the project .lexicon.yaml')
    .option('--json', 'print the result as JSON')
    .action(async (name: string, opts: PackCliOptions) => done(await runPackRemove(name, { ...opts, ...globals() }, io, deps)));

  pack
    .command('show')
    .description('print the terms and aliases a pack contains')
    .argument('<name>')
    .option('--json', 'print the pack as JSON')
    .action(async (name: string, opts: PackCliOptions) => done(await runPackShow(name, { ...opts, ...globals() }, io, deps)));
}
