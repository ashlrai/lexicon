/**
 * `lexicon pack list|add|remove|show`: the starter term packs shipped in
 * `packs/`. Handlers are exported for tests; registerPackCommands() only wires
 * commander. Every handler prints a table (or JSON with --json) and returns the
 * exit code; a `ProjectTrustError` on `--project` is reported like everywhere
 * else and never bypassed.
 *
 * Community packs (`<author>/<name>`, from a registry index via `--registry`)
 * install through the same `addTerm` loop as the vendored four, but with the
 * trust story the registry demands: checksums pinned at install, a full term
 * preview before the first write (confirmed, never silent), and updates that
 * are re-approved one by one.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import {
  ProjectTrustError,
  applyRegistryUpdate,
  downloadPack,
  findRegistryEntry,
  installPack,
  installRegistryPack,
  installedPacks,
  installedRegistryPacks,
  isRegistryRef,
  listPacks,
  loadPack,
  loadPackFile,
  loadRegistryIndex,
  parsePackText,
  parseRegistryRef,
  previewRegistryUpdates,
  readRegistryState,
  searchRegistryIndex,
  uninstallPack,
  uninstallRegistryPack,
  validateCommunityPack,
  verifyPackChecksum,
} from '../core/index.js';
import { loadLexicon } from '../core/index.js';
import type { InstallPackResult, RegistryDeps, RegistryIndexEntry, Term, TermScope, UninstallPackResult } from '../core/index.js';
import { bold, dim, fail, line, plural, renderTable, resolveCwd, safe } from './io.js';
import type { CommonOptions, IO } from './io.js';
import { createPrompter, isInteractive } from './prompt.js';
import type { Prompter } from './prompt.js';

export interface PackCliOptions extends CommonOptions {
  json?: boolean;
  /** Install into / remove from the project .lexicon.yaml instead of the global file. */
  project?: boolean;
  /** Override the global lexicon path (mainly for tests). */
  globalPath?: string;
}

/** Options for the community-pack commands. */
export interface PackRegistryCliOptions extends PackCliOptions {
  /** Registry index: a local path, file:// URL or https:// URL. */
  registry?: string;
  /** Accept the preview without prompting (required off a terminal). */
  yes?: boolean;
}

export interface PackDeps {
  /** Directory holding the pack files (tests). Default: the package's packs/. */
  dir?: string;
  /** Registry fetch overrides (tests). Default: global fetch. */
  registry?: RegistryDeps;
  createPrompter?: () => Prompter;
  isInteractive?: () => boolean;
}

function scopeOf(opts: PackCliOptions): TermScope {
  return opts.project ? 'project' : 'global';
}

/** `lexicon pack list`: every pack with its size and whether it is installed. With --registry, the index's community packs. */
export async function runPackList(opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const storeOpts = { cwd, scope: scopeOf(opts), ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) };
  try {
    const packs = await listPacks(deps);
    const installed = installedPacks(await loadLexicon(storeOpts));
    const rows = packs.map((p) => ({ ...p, installed: installed.includes(p.name) }));
    const communityInstalled = await installedRegistryPacks(storeOpts);
    if (opts.json) {
      let registryPacks: RegistryIndexEntry[] | undefined;
      if (opts.registry) {
        const { index } = await loadRegistryIndex(opts.registry, deps.registry);
        registryPacks = index.packs;
      }
      line(io, JSON.stringify({ packs: rows, installed, communityInstalled, ...(registryPacks ? { registry: registryPacks } : {}) }, null, 2));
      return 0;
    }
    if (rows.length === 0 && communityInstalled.length === 0) {
      line(io, 'no packs found');
      return 0;
    }
    io.stdout(
      renderTable(
        rows.map((p) => [p.name, p.title, String(p.terms), String(p.aliases), p.installed ? 'yes' : '', p.description]),
        ['name', 'title', 'terms', 'aliases', 'installed', 'description'],
      ),
    );
    if (communityInstalled.length > 0) {
      const state = await readRegistryState(storeOpts);
      line(io);
      line(io, bold('community packs installed:'));
      io.stdout(
        renderTable(
          communityInstalled.map((r) => [r, state.packs[r]?.version ?? '', state.packs[r]?.indexSource ?? '']),
          ['ref', 'version', 'registry'],
        ),
      );
    }
    if (opts.registry) {
      const { index } = await loadRegistryIndex(opts.registry, deps.registry);
      line(io);
      line(io, bold(`community packs in ${safe(opts.registry)}:`));
      if (index.packs.length === 0) {
        line(io, dim('  (empty index)'));
      } else {
        io.stdout(
          renderTable(
            index.packs.map((p) => [p.ref, p.title, String(p.terms), communityInstalled.includes(p.ref) ? 'yes' : '', p.description]),
            ['ref', 'title', 'terms', 'installed', 'description'],
          ),
        );
      }
    }
    line(io, 'add one with: lexicon pack add <name>   (lexicon pack show <name> lists its terms)');
    line(io, dim('community: lexicon pack search <query> --registry <index>'));
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

/** `lexicon pack remove <name>`: uninstall a pack, keeping terms the user edited. A community ref (`author/name`) uninstalls through the registry cache. */
export async function runPackRemove(name: string, opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    let result: UninstallPackResult;
    if (isRegistryRef(name)) {
      const ref = parseRegistryRef(name).ref;
      result = await uninstallRegistryPack(ref, opts.registry, { cwd, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}), ...(opts.project ? { scope: 'project' as const } : {}) }, deps.registry);
    } else {
      result = await uninstallPack(name, { cwd, ...(opts.project ? { scope: 'project' as const } : {}), ...deps });
    }
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

/** `lexicon pack show <name>`: the pack's terms and aliases. A community ref downloads through `--registry` into a temp dir. */
export async function runPackShow(name: string, opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  try {
    if (isRegistryRef(name)) {
      if (!needRegistry(opts, io)) return 1;
      const parsed = parseRegistryRef(name);
      const { index, base } = await loadRegistryIndex(opts.registry as string, deps.registry);
      const entry = findRegistryEntry(index, parsed.ref);
      const bytes = await downloadPack(entry, base, deps.registry);
      verifyPackChecksum(bytes, entry.checksum, entry.ref);
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-pack-'));
      try {
        const file = path.join(tmp, `${entry.name}.yaml`);
        await fs.writeFile(file, bytes);
        const pack = await loadPackFile(file, entry.name);
        if (opts.json) {
          line(io, JSON.stringify({ ref: entry.ref, author: entry.author, homepage: entry.homepage, version: entry.version, checksum: entry.checksum, pack }, null, 2));
          return 0;
        }
        line(io, `${safe(entry.ref)} ${dim(`(community pack${entry.author ? ` by ${entry.author}` : ''}, version ${entry.version || 'unversioned'}, checksum ${entry.checksum.slice(0, 12)}...)`)}`);
        printPackTerms(io, pack);
        return 0;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
    const pack = await loadPack(name, deps);
    if (opts.json) {
      line(io, JSON.stringify(pack, null, 2));
      return 0;
    }
    printPackTerms(io, pack);
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

function printPackTerms(io: IO, pack: { name: string; title: string; description: string; lexicon: { terms: Term[] } }): void {
  line(io, `${pack.name}: ${pack.title} (${pack.lexicon.terms.length} terms)`);
  if (pack.description) line(io, pack.description);
  line(io);
  line(io, JSON.stringify(pack.lexicon.terms, null, 2));
}

/** `lexicon pack search <query> --registry <index>`: search the community packs. */
export async function runPackSearch(query: string, opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  try {
    if (!opts.registry) {
      io.stderr('lexicon: pack search needs --registry <index> (a local path, file:// or https:// URL)\n');
      return 1;
    }
    const { index } = await loadRegistryIndex(opts.registry, deps.registry);
    const hits = searchRegistryIndex(index, query);
    const cwd = resolveCwd(opts);
    const installed = installedPacks(await loadLexicon({ cwd, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) }));
    if (opts.json) {
      line(io, JSON.stringify({ query, registry: opts.registry, packs: hits }, null, 2));
      return 0;
    }
    if (hits.length === 0) {
      line(io, dim(`no community packs match "${query}" in ${opts.registry}`));
      return 0;
    }
    io.stdout(
      renderTable(
        hits.map((p) => [
          p.ref,
          p.title,
          String(p.terms),
          p.version,
          installed.includes(p.ref) ? 'yes' : '',
          p.author,
          p.description,
        ]),
        ['ref', 'title', 'terms', 'version', 'installed', 'author', 'description'],
      ),
    );
    line(io, dim(`install with: lexicon pack add <ref> --registry ${opts.registry}   (shows the term list before writing)`));
    return 0;
  } catch (err) {
    return fail(io, err);
  }
}

function needRegistry(opts: PackRegistryCliOptions, io: IO): boolean {
  if (!opts.registry) {
    io.stderr('lexicon: community packs need --registry <index> (a local path, file:// or https:// URL)\n');
    return false;
  }
  return true;
}

async function confirmCommunityWrite(
  io: IO,
  question: string,
  opts: PackRegistryCliOptions,
  deps: PackDeps,
): Promise<boolean> {
  // A community pack is a stranger's terms landing in model context: the
  // default answer is no, and off a terminal --yes is the explicit consent.
  if (opts.yes) return true;
  const interactive = (deps.isInteractive ?? isInteractive)();
  if (!interactive) {
    io.stderr(`lexicon: ${question}: not a terminal; pass --yes to accept, or run on a terminal to review first\n`);
    return false;
  }
  const prompter = deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout }));
  const p = prompter();
  try {
    return await p.confirm(question, false);
  } finally {
    if (!deps.createPrompter) p.close();
  }
}

/**
 * Install one community pack: download, checksum-verify, show the full term
 * list, and only write after the user confirms. A `@version` pin is recorded
 * and honored by `pack update`.
 */
async function runPackAddRegistry(
  rawName: string,
  opts: PackRegistryCliOptions,
  io: IO,
  deps: PackDeps,
): Promise<InstallPackResult & { ref: string }> {
  const cwd = resolveCwd(opts);
  const scope = opts.project ? 'project' : 'global';
  const parsed = parseRegistryRef(rawName);
  const { index, base } = await loadRegistryIndex(opts.registry as string, deps.registry);
  const entry = findRegistryEntry(index, parsed.ref);
  if (parsed.version !== undefined && parsed.version !== entry.version) {
    throw new Error(`pack ${parsed.ref} is at version "${entry.version}" in this registry (you asked for @${parsed.version})`);
  }
  const bytes = await downloadPack(entry, base, deps.registry);
  verifyPackChecksum(bytes, entry.checksum, entry.ref);
  const pack = parsePackText(bytes.toString('utf8'), entry.url, entry.name);

  if (opts.json && !opts.yes) {
    line(io, JSON.stringify({ preview: true, scope, ref: entry.ref, author: entry.author, homepage: entry.homepage, version: entry.version, checksum: entry.checksum, terms: pack.lexicon.terms }, null, 2));
    throw new PreviewOnly();
  }
  if (!opts.json) {
    line(io, bold(`community pack ${safe(entry.ref)}`));
    line(io, `  ${safe(entry.title)}${entry.author ? ` by ${safe(entry.author)}` : ''}${entry.homepage ? ` (${safe(entry.homepage)})` : ''}`);
    line(io, `  version ${safe(entry.version || '(unversioned)')}, checksum ${safe(entry.checksum.slice(0, 12))}...`);
    line(io, `  ${dim('this preview is the whole install: nothing is written until you confirm.')}`);
    line(io);
    printPackTerms(io, pack);
    line(io);
  }
  const ok = await confirmCommunityWrite(io, `install ${entry.ref} (${pack.lexicon.terms.length} terms)?`, opts, deps);
  if (!ok) throw new Declined();
  const result = await installRegistryPack(entry, base, opts.registry as string, {
    cwd,
    scope,
    approvedBytes: bytes,
    ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}),
    ...(parsed.version !== undefined ? { pinnedVersion: parsed.version } : {}),
  }, deps.registry);
  if (opts.json) {
    line(io, JSON.stringify({ preview: false, ref: result.ref, added: result.added, merged: result.merged, path: result.path, scope: result.scope }, null, 2));
  } else {
    line(io, `installed ${safe(result.ref)} (${entry.title}): ${result.added} added, ${result.merged} merged into ${safe(result.path)}`);
    if (parsed.version !== undefined) line(io, dim(`  pinned at version ${parsed.version}; pack update will not move it`));
    line(io, dim('  the terms are live: normalize_transcript, the hook and the local API pick them up on the next call'));
  }
  return result;
}

/** Thrown to unwind a preview-only run without an error message. */
class PreviewOnly extends Error {
  constructor() { super('preview'); this.name = 'PreviewOnly'; }
}
/** Thrown when the user declines the install at the confirm prompt. */
class Declined extends Error {
  constructor() { super('declined'); this.name = 'Declined'; }
}

/** `lexicon pack add <name...>`: install one or more packs. Stops at the first failure and exits 1. */
export async function runPackAdd(names: readonly string[], opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const scope = opts.project ? 'project' : 'global';
  // Registry installs print their own output (preview or result) inside
  // runPackAddRegistry; only vendored installs accumulate here.
  const results: InstallPackResult[] = [];
  for (const name of names) {
    try {
      if (isRegistryRef(name)) {
        if (!needRegistry(opts, io)) return 1;
        await runPackAddRegistry(name, opts, io, deps);
      } else {
        const result = await installPack(name, { cwd, scope, ...deps });
        results.push(result);
        if (!opts.json) {
          line(
            io,
            `installed ${safe(result.pack.name)} (${result.pack.title}): ${result.added} added, ${result.merged} merged into ${safe(result.path)}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof PreviewOnly) return 0;
      if (err instanceof Declined) {
        if (!opts.json) line(io, dim('declined; nothing written.'));
        return 0;
      }
      if (opts.json && results.length > 0) line(io, JSON.stringify(results, null, 2));
      if (err instanceof ProjectTrustError) return fail(io, err);
      return fail(io, err);
    }
  }
  if (opts.json) line(io, JSON.stringify(results, null, 2));
  else if (results.length > 0) line(io, 'the terms are live: normalize_transcript, the hook and the local API pick them up on the next call');
  return 0;
}

/** `lexicon pack update [ref...]`: re-check installed community packs against a fresh index. Never silent: every changed pack is previewed and confirmed. */
export async function runPackUpdate(refs: readonly string[], opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const storeOpts = { cwd, scope: scopeOf(opts), ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) };
  try {
    // Group by index so packs installed from different registries each get a fresh read of their own.
    const state = await readRegistryState(storeOpts);
    const byIndex = new Map<string, string[]>();
    const targets = refs.length > 0 ? refs.map((r) => parseRegistryRef(r).ref) : Object.keys(state.packs);
    for (const ref of targets) {
      const source = opts.registry ?? state.packs[ref]?.indexSource;
      if (!source) {
        io.stderr(`lexicon: ${safe(ref)} was not installed from a registry index; pass --registry <index> to check it\n`);
        continue;
      }
      const list = byIndex.get(source) ?? [];
      list.push(ref);
      byIndex.set(source, list);
    }
    if (byIndex.size === 0) {
      if (!opts.json) line(io, dim('no community packs installed; nothing to update.'));
      else line(io, JSON.stringify({ updates: [] }, null, 2));
      return 0;
    }
    const reports: { ref: string; status: string; from?: string; to?: string; added?: number | string[]; merged?: number; dropped?: string[]; error?: string }[] = [];
    for (const [source, group] of byIndex) {
      const previews = await previewRegistryUpdates(group, source, storeOpts, deps.registry);
      for (const preview of previews) {
        if (preview.status === 'current') {
          if (!opts.json) line(io, dim(`${preview.ref}: already current${preview.to ? ` (version ${preview.to})` : ''}`));
          reports.push({ ref: preview.ref, status: preview.status, from: preview.from, to: preview.to });
          continue;
        }
        if (preview.status === 'pinned') {
          if (!opts.json) line(io, `${safe(preview.ref)}: pinned at version ${safe(preview.from ?? '?')} (index has ${safe(preview.to ?? '?')}); \`lexicon pack add ${safe(preview.ref)}@${safe(preview.to ?? '')} --registry <index>\` to move it`);
          reports.push({ ref: preview.ref, status: preview.status, from: preview.from, to: preview.to });
          continue;
        }
        if (preview.status === 'not-installed' || preview.status === 'failed') {
          const msg = preview.status === 'failed' ? `: ${preview.error}` : ' (not installed from a registry)';
          if (!opts.json) line(io, `${safe(preview.ref)}: ${preview.status}${msg}`);
          reports.push({ ref: preview.ref, status: preview.status, ...(preview.error ? { error: preview.error } : {}) });
          continue;
        }
        // 'available': show the diff, then ask. This is the re-approval the trust story demands.
        if (!opts.json) {
          line(io, bold(`${preview.ref}: update available${preview.from || preview.to ? ` (${preview.from ?? '?'} -> ${preview.to ?? '?'})` : ''}`));
          if (preview.added.length > 0) line(io, `  new terms: ${safe(preview.added.join(', '))}`);
          if (preview.removed.length > 0) line(io, `  dropped by the new file (kept in your lexicon): ${safe(preview.removed.join(', '))}`);
          if (preview.added.length === 0 && preview.removed.length === 0) line(io, dim('  (only aliases or metadata changed)'));
          line(io, '  complete incoming terms (notes are shown to agents):');
          line(io, JSON.stringify(preview.terms, null, 2));
          if (preview.changed?.length) line(io, JSON.stringify({ changed: preview.changed }, null, 2));
        }
        if (opts.json && !opts.yes) {
          reports.push({ ...preview, status: 'preview' });
          continue;
        }
        const ok = await confirmCommunityWrite(io, `apply the ${preview.ref} update?`, opts, deps);
        if (!ok) {
          if (!opts.json) line(io, dim('  skipped; nothing written.'));
          reports.push({ ref: preview.ref, status: 'skipped', from: preview.from, to: preview.to });
          continue;
        }
        const applied = await applyRegistryUpdate(preview, source, storeOpts, deps.registry);
        if (applied.status === 'updated' && !opts.json) {
          line(io, `  updated ${safe(applied.ref)}: ${applied.added} added, ${applied.merged} merged`);
        } else if (!opts.json) {
          line(io, `  ${safe(applied.ref)}: ${applied.status}${applied.error ? `: ${applied.error}` : ''}`);
        }
        reports.push(applied);
      }
    }
    if (opts.json) line(io, JSON.stringify({ updates: reports }, null, 2));
    return reports.some(report => report.status === 'failed' || report.status === 'not-installed') ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

/** `lexicon pack validate <file>`: the publish-time review bar for a community pack. Exit 1 on errors, 0 with warnings listed. */
export async function runPackValidate(file: string, opts: PackCliOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const abs = path.resolve(cwd, file);
    const pack = await loadPackFile(abs);
    const { errors, warnings } = validateCommunityPack(pack);
    if (opts.json) {
      line(io, JSON.stringify({ file: abs, pack: pack.name, errors, warnings }, null, 2));
    } else {
      line(io, `${safe(pack.name)}: ${safe(pack.title)} (${plural(pack.lexicon.terms.length, 'term')}, ${pack.aliases === 1 ? '1 alias' : `${pack.aliases} aliases`})`);
      for (const w of warnings) line(io, `  warning: ${safe(w)}`);
      for (const e of errors) line(io, `  error: ${safe(e)}`);
      if (errors.length === 0 && warnings.length === 0) line(io, dim('  valid: ready to list in a registry index.'));
    }
    return errors.length > 0 ? 1 : 0;
  } catch (err) {
    return fail(io, err);
  }
}

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
    .description('starter term packs (developer, ai, business, voice-tools) and community packs (<author>/<name> via --registry): list, add, remove, show, search, update, validate')
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
    .action(async (opts: PackRegistryCliOptions) => done(await runPackList({ ...opts, ...globals() }, io, deps)));

  pack
    .command('add')
    .description('install one or more packs into the global lexicon (existing terms only gain aliases); <author>/<name> installs a community pack after a preview')
    .argument('<name...>', 'pack names, e.g. developer ai, or community refs like example/cardiology')
    .option('--project', 'install into the project .lexicon.yaml instead')
    .option('--registry <index>', 'registry index for community pack refs (local path, file:// or https:// URL)')
    .option('-y, --yes', 'accept the community-pack preview without prompting (required off a terminal)')
    .option('--json', 'print the results as JSON')
    .action(async (names: string[], opts: PackRegistryCliOptions) => done(await runPackAdd(names, { ...opts, ...globals() }, io, deps)));

  pack
    .command('remove')
    .alias('rm')
    .description('remove a pack; terms you edited since (hits, extra aliases) are kept')
    .argument('<name>', 'pack name or community ref (author/name)')
    .option('--project', 'only look in the project .lexicon.yaml')
    .option('--registry <index>', 'registry index to re-fetch a community pack whose cache is gone')
    .option('--json', 'print the result as JSON')
    .action(async (name: string, opts: PackRegistryCliOptions) => done(await runPackRemove(name, { ...opts, ...globals() }, io, deps)));

  pack
    .command('show')
    .description('print the terms and aliases a pack contains')
    .argument('<name>', 'pack name or community ref (author/name, needs --registry)')
    .option('--registry <index>', 'registry index for community pack refs')
    .option('--json', 'print the pack as JSON')
    .action(async (name: string, opts: PackRegistryCliOptions) => done(await runPackShow(name, { ...opts, ...globals() }, io, deps)));

  pack
    .command('search')
    .description('search community packs in a registry index by name, title, description or author')
    .argument('<query>', 'what to look for, e.g. cardiology')
    .option('--registry <index>', 'registry index to search (local path, file:// or https:// URL)')
    .option('--json', 'print the matches as JSON')
    .action(async (query: string, opts: PackRegistryCliOptions) => done(await runPackSearch(query, { ...opts, ...globals() }, io, deps)));

  pack
    .command('update')
    .description('re-check installed community packs against a fresh index; every changed pack is previewed and confirmed, never silent')
    .argument('[refs...]', 'community refs to update (default: every installed community pack)')
    .option('--project', 'update only community packs installed in this project')
    .option('--registry <index>', 'registry index to check (default: the index each pack was installed from)')
    .option('-y, --yes', 'apply every available update without prompting (required off a terminal)')
    .option('--json', 'print the update report as JSON')
    .action(async (refs: string[], opts: PackRegistryCliOptions) => done(await runPackUpdate(refs, { ...opts, ...globals() }, io, deps)));

  pack
    .command('validate')
    .description('check a pack file against the community publish bar (schema, author, the ordinary-word guard)')
    .argument('<file>', 'pack YAML file to validate')
    .option('--json', 'print the errors and warnings as JSON')
    .action(async (file: string, opts: PackCliOptions) => done(await runPackValidate(file, { ...opts, ...globals() }, io)));
}
