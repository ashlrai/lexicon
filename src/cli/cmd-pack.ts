/**
 * `lexicon pack list|add|remove|show`: the starter term packs shipped in
 * `packs/`. Handlers are exported for tests; registerPackCommands() only wires
 * commander. Every handler prints a table (or JSON with --json) and returns the
 * exit code; a `ProjectTrustError` on `--project` is reported like everywhere
 * else and never bypassed.
 *
 * Community packs (`<author>/<name>`, from a registry index via `--registry`)
 * install through the same `addTerm` loop as the vendored five, but with the
 * trust story the registry demands: checksums pinned at install, a full term
 * preview before the first write (confirmed, never silent), and updates that
 * are re-approved one by one.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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
  packAlreadyInstalledNote,
  parsePackText,
  parseRegistryRef,
  previewRegistryUpdates,
  REGISTRY_REF_RE,
  readRegistryState,
  searchRegistryIndex,
  uninstallPack,
  uninstallRegistryPack,
  validateCommunityPack,
  verifyPackChecksum,
} from '../core/index.js';
import { findRegistryRecordMismatch, loadLexicon, registryRecordMismatch } from '../core/index.js';
import type { InstallPackResult, RegistryDeps, RegistryRecordMismatch, RegistryIndexEntry, Term, TermScope, UninstallPackResult } from '../core/index.js';
import { CliRefusal, PACK_NOT_FOUND_NEXT_STEP, bold, dim, fail, jsonError, jsonOk, line, plural, refuse, renderTable, resolveCwd, safe, shownCommand, shownWord, safeMessage, skippedProjectJson, unreadableLexiconHint, warnSkippedProject } from './io.js';
import type { CommonOptions, IO } from './io.js';
import { errorMessage, isEnoent } from '../util/errors.js';
import { createPrompter, isInteractive } from './prompt.js';
import type { Prompter } from './prompt.js';

export interface PackCliOptions extends CommonOptions {
  json?: boolean;
  /** `pack validate`: warnings count as errors, so the exit code is 1. */
  strict?: boolean;
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
  /** Compute and show the change a write would make; ask nothing, write nothing. */
  dryRun?: boolean;
}

export interface PackDeps {
  /** Directory holding the pack files (tests). Default: the package's packs/. */
  dir?: string;
  /** Registry fetch overrides (tests). Default: global fetch. */
  registry?: RegistryDeps;
  createPrompter?: () => Prompter;
  isInteractive?: () => boolean;
}

/** What a skipped project lexicon means for an `installed` flag. */
const PACKS_SKIPPED = 'A pack recorded only in that file shows as not installed until it is trusted.';

function scopeOf(opts: PackCliOptions): TermScope {
  return opts.project ? 'project' : 'global';
}

/** Kept as an export of this module for existing importers; defined in core. */
export type { RegistryRecordMismatch } from '../core/index.js';

/** One `lexicon: warn:` line per ref the two records disagree on. `scope` names the file when the listing is scoped. */
function warnRegistryMismatch(io: IO, mismatch: RegistryRecordMismatch, scope?: TermScope): void {
  const where = scope ? `the ${scope} lexicon's settings.packs` : 'the lexicon files\' settings.packs';
  const flag = scope === 'project' ? ' --project' : '';
  for (const ref of mismatch.fileOnly) {
    io.stderr(`lexicon: warn: ${safe(ref)} is in ${where} but has no registry record, so pack update will not check it (reinstall: lexicon pack add ${shownWord(ref)} --registry <index>${flag})\n`);
  }
  for (const ref of mismatch.recordOnly) {
    io.stderr(`lexicon: warn: ${safe(ref)} has a registry record but is not in ${where}, so it is listed as not installed (${shownCommand(['lexicon', 'pack', 'remove', ref, ...(flag ? ['--project'] : [])])} clears the record)\n`);
  }
}

/**
 * `lexicon pack list`: every pack with its size and whether it is installed.
 * With --registry, the index's community packs. `installed` comes from
 * `settings.packs` of the trusted lexicon files (`installedPacks`), the same
 * source as `pack search` and MCP `list_packs`; the registry state file only
 * adds version and source, and a disagreement between the two is reported.
 */
export async function runPackList(opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const scope = scopeOf(opts);
  const storeOpts = { cwd, scope, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}) };
  try {
    const packs = await listPacks(deps);
    // installedPacks and the mismatch read only the merged files: a skipped
    // project file is named by path, so it is never parsed.
    const loaded = await loadLexicon({ ...storeOpts, parseSkipped: false });
    // installedPacks reads trusted files only: a pack the skipped project file
    // records shows as not installed, so name that file (stderr, path only).
    warnSkippedProject(loaded, io);
    const installed = installedPacks(loaded);
    const rows = packs.map((p) => ({ ...p, installed: installed.includes(p.name) }));
    // Registry records of this scope: what `pack update` checks.
    const communityInstalled = await installedRegistryPacks(storeOpts);
    const mismatch = registryRecordMismatch(loaded, scope, communityInstalled);
    if (mismatch) warnRegistryMismatch(io, mismatch, scope);
    const community = installed.filter((p) => isRegistryRef(p));
    if (opts.json) {
      let registryPacks: (RegistryIndexEntry & { installed: boolean })[] | undefined;
      if (opts.registry) {
        const { index } = await loadRegistryIndex(opts.registry, deps.registry);
        // The same per-pack flag MCP list_packs and pack search give.
        registryPacks = index.packs.map((p) => ({ ...p, installed: installed.includes(p.ref) }));
      }
      line(
        io,
        JSON.stringify(
          jsonOk({
            packs: rows,
            installed,
            communityInstalled,
            ...(mismatch ? { registryMismatch: mismatch } : {}),
            ...(registryPacks ? { registry: registryPacks } : {}),
            ...skippedProjectJson(loaded, PACKS_SKIPPED),
          }),
          null,
          2,
        ),
      );
      return 0;
    }
    if (rows.length === 0 && community.length === 0) {
      line(io, 'no packs found');
      return 0;
    }
    io.stdout(
      renderTable(
        rows.map((p) => [p.name, p.title, String(p.terms), String(p.aliases), p.installed ? 'yes' : '', p.description]),
        ['name', 'title', 'terms', 'aliases', 'installed', 'description'],
      ),
    );
    if (community.length > 0) {
      const state = await readRegistryState(storeOpts);
      line(io);
      line(io, bold('community packs installed:'));
      io.stdout(
        renderTable(
          community.map((r) => [r, state.packs[r]?.version ?? '', state.packs[r]?.indexSource ?? '']),
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
            index.packs.map((p) => [p.ref, p.title, String(p.terms), installed.includes(p.ref) ? 'yes' : '', p.description]),
            ['ref', 'title', 'terms', 'installed', 'description'],
          ),
        );
      }
    }
    line(io, 'add one with: lexicon pack add <name>   (lexicon pack show <name> lists its terms)');
    line(io, dim('community: lexicon pack search <query> --registry <index>'));
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}

/** `lexicon pack remove <name>`: uninstall a pack, keeping terms the user edited. A community ref (`author/name`) uninstalls through the registry cache. */
export async function runPackRemove(name: string, opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const dry = opts.dryRun === true;
    let result: UninstallPackResult;
    if (isRegistryRef(name)) {
      const ref = parseRegistryRef(name).ref;
      result = await uninstallRegistryPack(ref, opts.registry, { cwd, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}), ...(opts.project ? { scope: 'project' as const } : {}), ...(dry ? { dryRun: true } : {}) }, deps.registry);
    } else {
      result = await uninstallPack(name, { cwd, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}), ...(opts.project ? { scope: 'project' as const } : {}), ...(dry ? { dryRun: true } : {}), ...deps });
    }
    if (result.files.length === 0 && !result.registryRemoved) {
      // No file listed the pack, so nothing was written. Under --json that
      // was `ok: true` with three empty lists and no word that the pack was
      // not there; it now says so, as the text and `DELETE /packs/:name` do.
      if (opts.json) {
        const summary = `${result.pack.name} is not installed${opts.project ? ' in the project lexicon' : ''}; nothing was removed`;
        line(io, JSON.stringify(jsonOk({ ...result, notInstalled: true, summary, ...(dry ? { dryRun: true } : {}) }), null, 2));
        return 0;
      }
      line(io, `${safe(name)} is not installed`);
      return 0;
    }
    if (opts.json) {
      line(io, JSON.stringify(jsonOk({ ...result, ...(dry ? { dryRun: true } : {}) }), null, 2));
      return 0;
    }
    if (result.files.length > 0) {
      line(io, `${dry ? 'would remove' : 'removed'} ${result.removed.length} term${result.removed.length === 1 ? '' : 's'} of ${safe(name)} from ${safe(result.files.join(', '))}${dry ? '; nothing was written' : ''}`);
    }
    if (result.registryRemoved) {
      line(io, `${dry ? 'would remove' : 'removed'} registry record and cached pack for ${safe(name)}${dry ? '; nothing was written' : ''}`);
    }
    if (result.kept.length > 0) {
      line(io, `kept ${result.kept.length} you edited (hits, extra aliases or never-words): ${safe(result.kept.join(', '))}`);
    }
    if (result.shared.length > 0) {
      line(io, `kept ${result.shared.length} another installed pack also has: ${safe(result.shared.join(', '))}`);
    }
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
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
          line(io, JSON.stringify(jsonOk({ ref: entry.ref, author: entry.author, homepage: entry.homepage, version: entry.version, checksum: entry.checksum, pack }), null, 2));
          return 0;
        }
        line(io, `${safe(entry.ref)} ${dim(`(community pack${entry.author ? ` by ${safe(entry.author)}` : ''}, version ${safe(entry.version || 'unversioned')}, checksum ${entry.checksum.slice(0, 12)}...)`)}`);
        printPackTerms(io, pack);
        return 0;
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }
    const pack = await loadPack(name, deps);
    if (opts.json) {
      line(io, JSON.stringify(jsonOk(pack), null, 2));
      return 0;
    }
    printPackTerms(io, pack);
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}

function printPackTerms(io: IO, pack: { name: string; title: string; description: string; lexicon: { terms: Term[] } }): void {
  // A community pack file is a stranger's text: its title and description reach the terminal sanitized.
  line(io, `${safe(pack.name)}: ${safe(pack.title)} (${plural(pack.lexicon.terms.length, 'term')})`);
  if (pack.description) line(io, safeMessage(pack.description));
  line(io);
  line(io, JSON.stringify(pack.lexicon.terms, null, 2));
}

/** `lexicon pack search <query> --registry <index>`: search the community packs. */
export async function runPackSearch(query: string, opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  try {
    if (!opts.registry) {
      return refuse(io, opts.json, 'pack search needs --registry <index> (a local path, file:// or https:// URL)', 'pass --registry <index>, or run lexicon pack list for the built-in packs');
    }
    const { index } = await loadRegistryIndex(opts.registry, deps.registry);
    const hits = searchRegistryIndex(index, query);
    const cwd = resolveCwd(opts);
    const loaded = await loadLexicon({ cwd, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}), parseSkipped: false });
    warnSkippedProject(loaded, io);
    const installed = installedPacks(loaded);
    // The same report as `pack list`, over every file the flags come from.
    const mismatch = await findRegistryRecordMismatch(loaded, opts.globalPath !== undefined ? { cwd, globalPath: opts.globalPath } : { cwd });
    if (mismatch) warnRegistryMismatch(io, mismatch);
    if (opts.json) {
      const packs = hits.map((p) => ({ ...p, installed: installed.includes(p.ref) }));
      line(
        io,
        JSON.stringify(
          jsonOk({ query, registry: opts.registry, packs, ...(mismatch ? { registryMismatch: mismatch } : {}), ...skippedProjectJson(loaded, PACKS_SKIPPED) }),
          null,
          2,
        ),
      );
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
    line(io, dim(`install with: lexicon pack add <ref> --registry ${shownWord(opts.registry)}   (shows the term list before writing)`));
    return 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}

const NEED_REGISTRY = 'community packs need --registry <index> (a local path, file:// or https:// URL)';

function needRegistry(opts: PackRegistryCliOptions, io: IO): boolean {
  if (!opts.registry) {
    refuse(io, opts.json, NEED_REGISTRY, 'pass --registry <index>, or run lexicon pack list for the built-in packs');
    return false;
  }
  return true;
}

/**
 * The command that re-runs one community `pack add` or `pack update` with
 * `--yes`: the ref as given, then `--registry` and `--project` when the run
 * had them, so the line can be copied as it is.
 */
function yesCommand(sub: 'add' | 'update', ref: string, opts: PackRegistryCliOptions): string {
  const words = ['lexicon', 'pack', sub, ref];
  if (opts.registry) words.push('--registry', opts.registry);
  if (opts.project) words.push('--project');
  words.push('--yes');
  return shownCommand(words);
}

/**
 * The step that moves a pinned community pack to the index's version: the
 * whole `pack add <ref>@<version>` command with the index it was checked
 * against, quoted for the shell. It was assembled by hand with `--registry
 * <index>` left as a placeholder, and the index's version (free text, up to
 * 32 characters) went in unquoted, so a version with a space or `;` printed
 * a line that ran something else. A version no pin can name (empty, a space,
 * a `/`) gets the unpinned add, which takes the index's file and drops the pin.
 */
function movePinStep(ref: string, to: string | undefined, source: string, opts: PackRegistryCliOptions): string {
  const flags = ['--registry', source, ...(opts.project ? ['--project'] : [])];
  const pin = to !== undefined ? `${ref}@${to}` : undefined;
  if (pin !== undefined && REGISTRY_REF_RE.test(pin)) return `\`${shownCommand(['lexicon', 'pack', 'add', pin, ...flags])}\` to move it`;
  return `that version cannot be pinned by name; \`${shownCommand(['lexicon', 'pack', 'add', ref, ...flags])}\` takes the index's file and drops the pin`;
}

/** The answer to a community write: yes, no at the question, or no terminal to ask on. */
type CommunityConsent = 'yes' | 'no' | 'no-terminal';

async function confirmCommunityWrite(
  io: IO,
  question: string,
  rerun: string,
  opts: PackRegistryCliOptions,
  deps: PackDeps,
): Promise<CommunityConsent> {
  // A community pack is a stranger's terms landing in model context: the
  // default answer is no, and off a terminal --yes is the explicit consent.
  if (opts.yes) return 'yes';
  const interactive = (deps.isInteractive ?? isInteractive)();
  if (!interactive) {
    io.stderr(`lexicon: ${question}: not a terminal, so nothing was written. Review the list above, then run: ${rerun}\n`);
    return 'no-terminal';
  }
  const prompter = deps.createPrompter ?? (() => createPrompter({ input: process.stdin, output: process.stdout }));
  const p = prompter();
  try {
    return (await p.confirm(question, false)) ? 'yes' : 'no';
  } finally {
    if (!deps.createPrompter) p.close();
  }
}

/** The `--json` preview of one community pack (`--json` without `--yes`): nothing was written. */
interface CommunityPreviewJson {
  preview: true;
  scope: TermScope;
  ref: string;
  author: string | undefined;
  homepage: string | undefined;
  version: string;
  checksum: string;
  terms: Term[];
}

/** What one community ref came to: installed, only previewed (`--json` without `--yes`), or declined at the question. */
type RegistryAddOutcome =
  | { kind: 'installed'; result: InstallPackResult & { ref: string } }
  | { kind: 'preview'; preview: CommunityPreviewJson }
  | { kind: 'declined'; ref: string; offTerminal: boolean };

/**
 * Install one community pack: download, checksum-verify, show the full term
 * list, and only write after the user confirms. A `@version` pin is recorded
 * and honored by `pack update`. Under `--json` without `--yes` it returns the
 * preview instead, and runPackAdd prints it with every other ref's outcome.
 */
async function runPackAddRegistry(
  rawName: string,
  opts: PackRegistryCliOptions,
  io: IO,
  deps: PackDeps,
): Promise<RegistryAddOutcome> {
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

  if (opts.dryRun) {
    // A dry run approves nothing, so there is no question to ask: the preview
    // terms are shown and installRegistryPack computes the change it would
    // write (added, merged, the target file) without writing it.
    if (!opts.json) {
      line(io, bold(`community pack ${safe(entry.ref)}`));
      line(io, `  ${safe(entry.title)}${entry.author ? ` by ${safe(entry.author)}` : ''}${entry.homepage ? ` (${safe(entry.homepage)})` : ''}`);
      line(io, `  version ${safe(entry.version || '(unversioned)')}, checksum ${safe(entry.checksum.slice(0, 12))}...`);
      line(io);
      printPackTerms(io, pack);
      line(io);
    }
    const result = await installRegistryPack(entry, base, opts.registry as string, {
      cwd,
      scope,
      approvedBytes: bytes,
      dryRun: true,
      ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}),
      ...(parsed.version !== undefined ? { pinnedVersion: parsed.version } : {}),
    }, deps.registry);
    if (!opts.json) {
      line(io, result.alreadyInstalled ? alreadyInstalledLine(result.ref, result) : `would install ${safe(result.ref)} (${safe(entry.title)}): ${result.added} added, ${result.merged} merged into ${safe(result.path)}; nothing was written`);
    }
    return { kind: 'installed', result };
  }
  if (opts.json && !opts.yes) {
    return {
      kind: 'preview',
      preview: { preview: true, scope, ref: entry.ref, author: entry.author, homepage: entry.homepage, version: entry.version, checksum: entry.checksum, terms: pack.lexicon.terms },
    };
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
  const consent = await confirmCommunityWrite(io, `install ${entry.ref} (${plural(pack.lexicon.terms.length, 'term')})?`, yesCommand('add', rawName, opts), opts, deps);
  if (consent !== 'yes') return { kind: 'declined', ref: entry.ref, offTerminal: consent === 'no-terminal' };
  const result = await installRegistryPack(entry, base, opts.registry as string, {
    cwd,
    scope,
    approvedBytes: bytes,
    ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}),
    ...(parsed.version !== undefined ? { pinnedVersion: parsed.version } : {}),
  }, deps.registry);
  // Under --json runPackAdd prints the result, so stdout carries one document.
  if (!opts.json && result.alreadyInstalled) {
    line(io, alreadyInstalledLine(result.ref, result));
  } else if (!opts.json) {
    line(io, `installed ${safe(result.ref)} (${safe(entry.title)}): ${result.added} added, ${result.merged} merged into ${safe(result.path)}`);
    if (parsed.version !== undefined) line(io, dim(`  pinned at version ${parsed.version}; pack update will not move it`));
    line(io, dim(`  ${TERMS_LIVE}`));
  }
  return { kind: 'installed', result };
}

/** After an install that wrote something: what picks the terms up, in words a person at a shell can run. */
const TERMS_LIVE = 'the terms are live: lexicon normalize, the prompt hook and lexicon serve use them from the next call';

/** A reinstall that left the file as it was: say so, with the pack's counts, instead of "0 added, N merged". */
function alreadyInstalledLine(name: string, result: InstallPackResult): string {
  return packAlreadyInstalledNote(name, result, safe);
}

/** The `--json` record of one community install. */
interface CommunityInstallJson {
  preview: false;
  ref: string;
  added: number;
  merged: number;
  path: string;
  scope: string;
  /** Present when the run was a --dry-run preview: nothing was written. */
  dryRun?: boolean;
}

/** The `--json` entry of the ref a `pack add` run stopped at: `{ ref, ok: false, error, nextStep? }`. */
interface PackAddFailureJson {
  ref: string;
  ok: false;
  error: string;
  nextStep?: string;
}

/**
 * `lexicon pack add <name...>`: install one or more packs. Stops at the first
 * failure and exits 1: the failing ref is reported (under `--json` as a
 * `{ ref, ok: false, error, nextStep? }` entry after the refs before it), the
 * refs after it are not attempted and not reported. A community ref that is
 * only previewed (`--json` without `--yes`) or declined at the question writes
 * nothing and does not stop the refs after it, so every ref's outcome is
 * reported. A community ref declined because there is no terminal to ask on
 * (no `--yes`) makes the run exit 1 once every ref is reported.
 */
export async function runPackAdd(names: readonly string[], opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const scope = opts.project ? 'project' : 'global';
  // Registry installs print their preview (and, without --json, their
  // result) inside runPackAddRegistry. Under --json every ref's outcome (an
  // install, or a community preview) accumulates here and is printed once: a
  // single community ref as its object, anything else as one array in
  // argument order.
  const dry = opts.dryRun === true;
  const results: ((InstallPackResult & { dryRun?: boolean }) | CommunityInstallJson | CommunityPreviewJson)[] = [];
  let vendored = 0;
  const installed: string[] = [];
  const declined: string[] = [];
  // A ref declined only because there was no terminal to ask on: the run
  // needed a consent it could not get, so it exits 1, as `review`, `suggest
  // --apply` and `import --guided` do off a terminal. A no at the question is
  // the user's answer and exits 0.
  let unconfirmed = 0;
  for (const [at, name] of names.entries()) {
    try {
      if (isRegistryRef(name)) {
        // The ref is checked first, as MCP add_pack does: `../x` was told
        // community packs need --registry, for a name that can never be one.
        try {
          parseRegistryRef(name);
        } catch (err) {
          throw new CliRefusal(errorMessage(err), PACK_NOT_FOUND_NEXT_STEP);
        }
        if (!opts.registry) {
          throw new CliRefusal(
            NEED_REGISTRY,
            `run: lexicon pack add ${shownWord(name.trim())} --registry <index> (lexicon pack search <query> --registry <index> lists the index's packs)`,
          );
        }
        const outcome = await runPackAddRegistry(name, opts, io, deps);
        if (outcome.kind === 'preview') {
          results.push(outcome.preview);
        } else if (outcome.kind === 'declined') {
          declined.push(outcome.ref);
          if (outcome.offTerminal) unconfirmed += 1;
          if (!opts.json) line(io, dim(names.length > 1 ? `declined ${safe(outcome.ref)}; nothing written for it.` : 'declined; nothing written.'));
        } else {
          const result = outcome.result;
          installed.push(result.ref);
          results.push({ preview: false, ref: result.ref, added: result.added, merged: result.merged, path: result.path, scope: result.scope, ...(dry ? { dryRun: true } : {}) });
        }
      } else {
        const result = await installPack(name, { cwd, scope, ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}), ...(dry ? { dryRun: true } : {}), ...deps });
        results.push(dry ? { ...result, dryRun: true } : result);
        installed.push(result.pack.name);
        if (!result.alreadyInstalled) vendored += 1;
        if (!opts.json) {
          line(
            io,
            result.alreadyInstalled
              ? alreadyInstalledLine(result.pack.name, result)
              : `${dry ? 'would install' : 'installed'} ${safe(result.pack.name)} (${safe(result.pack.title)}): ${result.added} added, ${result.merged} merged into ${safe(result.path)}${dry ? '; nothing was written' : ''}`,
          );
        }
      }
    } catch (err) {
      return failPackAdd(io, opts, names, results, at, err);
    }
  }
  if (opts.json) {
    const single = names.length === 1 && isRegistryRef(names[0]!) && results.length === 1;
    line(io, JSON.stringify(single ? jsonOk(results[0] as CommunityInstallJson | CommunityPreviewJson) : results, null, 2));
    return 0;
  }
  if (vendored > 0 && !dry) line(io, TERMS_LIVE);
  // With several refs, one line that adds them up, so a decline is not read as "nothing was written" when another ref was.
  if (names.length > 1 && declined.length > 0) {
    line(io, `${plural(installed.length, 'pack')} ${dry ? 'would install' : 'installed'}${installed.length > 0 ? ` (${installed.map(safe).join(', ')})` : ''}; declined: ${declined.map(safe).join(', ')}`);
  }
  return unconfirmed > 0 ? 1 : 0;
}

/**
 * Report the ref a `pack add` run stopped at. Under `--json` stdout carries one
 * document: for a single ref `{ ok: false, ref, error, nextStep? }`, for a list
 * the array of the refs before it with `{ ref, ok: false, error, nextStep? }`
 * appended; the refs after it were not attempted and are left out. On stderr
 * the `lexicon: <ref>: <error>` line (then the hint, and for a list the refs
 * not attempted). Exit code 1.
 */
function failPackAdd(
  io: IO,
  opts: PackRegistryCliOptions,
  names: readonly string[],
  results: ((InstallPackResult & { dryRun?: boolean }) | CommunityInstallJson | CommunityPreviewJson)[],
  at: number,
  err: unknown,
): number {
  const ref = names[at]!;
  const message = errorMessage(err);
  // The refusal's own next step (a community ref without --registry), or the
  // pack list for a name that is no pack at all: `fail` gives every other
  // command both, and without them `pack add` left a typo with no way on.
  const hint =
    unreadableLexiconHint(message) ??
    (err instanceof CliRefusal ? err.nextStep : err instanceof Error && err.name === 'PackNotFoundError' ? PACK_NOT_FOUND_NEXT_STEP : undefined);
  if (opts.json) {
    const { ok, ...detail } = jsonError(message, hint);
    const entry: PackAddFailureJson = { ref, ok, ...detail };
    // A single ref's object leads with `ok`, as every object-shaped document does.
    const doc = names.length === 1 ? { ok, ref, ...detail } : [...results, entry];
    line(io, JSON.stringify(doc, null, 2));
  }
  io.stderr(`lexicon: ${safe(ref)}: ${safeMessage(message)}\n`);
  if (hint) io.stderr(`lexicon: ${safeMessage(hint)}\n`);
  const after = names.slice(at + 1);
  if (after.length > 0) io.stderr(`lexicon: not attempted: ${after.map(safe).join(', ')}\n`);
  return 1;
}

/** `lexicon pack update [ref...]`: re-check installed community packs against a fresh index. Never silent: every changed pack is previewed and confirmed. */
export async function runPackUpdate(refs: readonly string[], opts: PackRegistryCliOptions, io: IO, deps: PackDeps = {}): Promise<number> {
  const cwd = resolveCwd(opts);
  const dry = opts.dryRun === true;
  const storeOpts = { cwd, scope: scopeOf(opts), ...(opts.globalPath !== undefined ? { globalPath: opts.globalPath } : {}), ...(dry ? { dryRun: true } : {}) };
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
      else line(io, JSON.stringify(jsonOk({ updates: [] }), null, 2));
      return 0;
    }
    const reports: { ref: string; status: string; from?: string; to?: string; added?: number | string[]; merged?: number; dropped?: string[]; error?: string; dryRun?: boolean }[] = [];
    let unconfirmed = 0;
    for (const [source, group] of byIndex) {
      const previews = await previewRegistryUpdates(group, source, storeOpts, deps.registry);
      for (const preview of previews) {
        if (preview.status === 'current') {
          if (!opts.json) line(io, dim(`${safe(preview.ref)}: already current${preview.to ? ` (version ${safe(preview.to)})` : ''}`));
          reports.push({ ref: preview.ref, status: preview.status, from: preview.from, to: preview.to });
          continue;
        }
        if (preview.status === 'pinned') {
          if (!opts.json) line(io, `${safe(preview.ref)}: pinned at version ${safe(preview.from ?? '?')} (index has ${safe(preview.to ?? '?')}); ${movePinStep(preview.ref, preview.to, source, opts)}`);
          reports.push({ ref: preview.ref, status: preview.status, from: preview.from, to: preview.to });
          continue;
        }
        if (preview.status === 'not-installed' || preview.status === 'failed') {
          const msg = preview.status === 'failed' ? `: ${safeMessage(preview.error ?? '')}` : ' (not installed from a registry)';
          if (!opts.json) line(io, `${safe(preview.ref)}: ${preview.status}${msg}`);
          reports.push({ ref: preview.ref, status: preview.status, ...(preview.error ? { error: preview.error } : {}) });
          continue;
        }
        // 'available': show the diff, then ask. This is the re-approval the trust story demands.
        if (!opts.json) {
          line(io, bold(`${safe(preview.ref)}: update available${preview.from || preview.to ? ` (${safe(preview.from ?? '?')} -> ${safe(preview.to ?? '?')})` : ''}`));
          if (preview.added.length > 0) line(io, `  new terms: ${safe(preview.added.join(', '))}`);
          if (preview.removed.length > 0) line(io, `  dropped by the new file (kept in your lexicon): ${safe(preview.removed.join(', '))}`);
          if (preview.added.length === 0 && preview.removed.length === 0) line(io, dim('  (only aliases or metadata changed)'));
          line(io, '  complete incoming terms (notes are shown to agents):');
          line(io, JSON.stringify(preview.terms, null, 2));
          if (preview.changed?.length) line(io, JSON.stringify({ changed: preview.changed }, null, 2));
        }
        // Under --json without --yes an 'available' update is reported as a
        // preview and nothing is attempted; a dry run goes one step further
        // and computes the write it would make (below).
        if (opts.json && !opts.yes && !dry) {
          reports.push({ ...preview, status: 'preview' });
          continue;
        }
        // A dry run approves nothing, so there is no question to ask: the
        // update is applied with dryRun and the report says what a real run
        // would write.
        const consent = dry ? ('yes' as const) : await confirmCommunityWrite(io, `apply the ${preview.ref} update?`, yesCommand('update', preview.ref, opts), opts, deps);
        if (consent !== 'yes') {
          // No terminal to ask on: the update needed a consent the run could
          // not get, so the run exits 1 once every pack is reported, as
          // `pack add` does. A no at the question is the user's answer.
          if (consent === 'no-terminal') unconfirmed += 1;
          if (!opts.json) line(io, dim('  skipped; nothing written.'));
          reports.push({ ref: preview.ref, status: 'skipped', from: preview.from, to: preview.to });
          continue;
        }
        const applied = await applyRegistryUpdate(preview, source, storeOpts, deps.registry);
        if (applied.status === 'updated' && !opts.json) {
          line(io, `  ${dry ? 'would update' : 'updated'} ${safe(applied.ref)}: ${applied.added} added, ${applied.merged} merged${dry ? '; nothing was written' : ''}`);
        } else if (!opts.json) {
          line(io, `  ${safe(applied.ref)}: ${applied.status}${applied.error ? `: ${safeMessage(applied.error)}` : ''}`);
        }
        reports.push(dry ? { ...applied, dryRun: true } : applied);
      }
    }
    const failed = reports.some((report) => report.status === 'failed' || report.status === 'not-installed');
    // The report is the failure document too, so `ok` follows the exit code.
    if (opts.json) line(io, JSON.stringify({ ok: !failed, updates: reports, ...(dry ? { dryRun: true } : {}) }, null, 2));
    return failed || unconfirmed > 0 ? 1 : 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}

/** The `nextStep` of `pack validate` on a path that does not exist: it takes a pack YAML file, not a pack name. */
const PACK_FILE_NOT_FOUND_NEXT_STEP =
  'check the path (a relative one resolves against the current directory); validate takes a pack YAML file, so to see the packs you can add run lexicon pack list';

/** `lexicon pack validate <file>`: the publish-time review bar for a community pack. Exit 1 on errors (and, with `--strict`, on warnings too), 0 otherwise. */
export async function runPackValidate(file: string, opts: PackCliOptions, io: IO): Promise<number> {
  const cwd = resolveCwd(opts);
  try {
    const abs = path.resolve(cwd, file);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch (err) {
      if (isEnoent(err)) throw new CliRefusal(`file not found: ${abs}`, PACK_FILE_NOT_FOUND_NEXT_STEP);
      throw err;
    }
    // A community pack is installed by its index entry's name, never by the
    // file name, so validate the content as written (my-pack.yaml, foo.yml).
    const pack = parsePackText(text, abs);
    const { errors, warnings } = validateCommunityPack(pack);
    const failed = errors.length > 0 || (opts.strict === true && warnings.length > 0);
    if (opts.json) {
      line(io, JSON.stringify({ ok: !failed, file: abs, pack: pack.name, errors, warnings, ...(opts.strict ? { strict: true } : {}) }, null, 2));
    } else {
      line(io, `${safe(pack.name)}: ${safe(pack.title)} (${plural(pack.lexicon.terms.length, 'term')}, ${pack.aliases === 1 ? '1 alias' : `${pack.aliases} aliases`})`);
      for (const w of warnings) line(io, `  warning: ${safe(w)}`);
      for (const e of errors) line(io, `  error: ${safe(e)}`);
      if (!failed && warnings.length === 0) line(io, dim('  valid: ready to list in a registry index.'));
      if (opts.strict && warnings.length > 0 && errors.length === 0) line(io, dim(`  ${plural(warnings.length, 'warning')} counts as an error under --strict`));
    }
    return failed ? 1 : 0;
  } catch (err) {
    return fail(io, err, opts.json);
  }
}

export { registerPackCommands } from './program.js';
