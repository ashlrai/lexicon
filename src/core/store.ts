/**
 * Lexicon storage: path resolution, YAML read/write, global+project merge and
 * the mutating helpers (addTerm / removeTerm / recordHits) used by the MCP
 * server, CLI and hooks.
 */
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { emptyLexicon, parseLexicon } from './schema.js';
import { isTrusted, refreshTrust, trustProject } from './trust.js';
import type { TrustStatus } from './trust.js';
import { errorMessage, isEnoent } from '../util/errors.js';
import { writeFileAtomic } from '../util/atomic.js';
import type {
  Lexicon,
  LexiconFile,
  LexiconSettings,
  LoadedLexicon,
  Term,
  TermScope,
} from './types.js';

export interface StoreOptions {
  /** Directory to start the project-file walk-up from. Default process.cwd(). */
  cwd?: string;
  /** Explicit global lexicon path; overrides $LEXICON_PATH and XDG defaults. */
  globalPath?: string;
}

export interface LoadOptions extends StoreOptions {
  /**
   * Merge the project file even when it is not trusted (see core/trust.ts).
   * Default false: an untrusted or changed project file is reported via
   * `LoadedLexicon.skippedProject` and NOT merged.
   */
  includeUntrusted?: boolean;
}

export const PROJECT_FILE_NAME = '.lexicon.yaml';

/**
 * Largest lexicon file we will parse. A project file comes from an arbitrary
 * repository; refusing huge files keeps a hostile repo from stalling the hook.
 */
export const MAX_LEXICON_BYTES = 2 * 1024 * 1024;

const HEADER_COMMENT = [
  'Lexicon — personal vocabulary for voice-to-agents.',
  'canonical: the spelling you want; aliases: what STT actually hears.',
  '',
  'Each term may also carry: phonetic (pronunciation hint), category',
  '(brand|person|product|acronym|identifier|place|other), notes (shown to the',
  'agent), never (words that must not be rewritten to this canonical).',
  'settings: minConfidence, phonetic, fuzzy, protectedWords, skipCode.',
].join('\n');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Walk up from `start` until a directory containing `.git` (inclusive) or the filesystem root. */
function findGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function findProjectFile(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, PROJECT_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    // The git root is the outermost directory we consider part of the project.
    if (existsSync(path.join(dir, '.git'))) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolvePaths(opts: StoreOptions = {}): { global: string; project?: string } {
  const cwd = opts.cwd ?? process.cwd();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const global =
    opts.globalPath || process.env.LEXICON_PATH || path.join(configHome, 'lexicon', 'lexicon.yaml');
  const project = findProjectFile(cwd);
  return project ? { global, project } : { global };
}

/** Where a new project lexicon should be created for `cwd`: the git root if inside a repo, else cwd. */
export function defaultProjectPath(cwd: string = process.cwd()): string {
  return path.join(findGitRoot(cwd) ?? path.resolve(cwd), PROJECT_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readLexiconFile(filePath: string, scope: TermScope): Promise<LexiconFile> {
  let text: string;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_LEXICON_BYTES) {
      throw new Error(
        `Refusing to read lexicon at ${filePath}: ${stat.size} bytes exceeds the ${MAX_LEXICON_BYTES} byte limit`,
      );
    }
    text = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      return { path: filePath, scope, lexicon: emptyLexicon(), exists: false };
    }
    throw err;
  }
  let raw: unknown;
  try {
    // prettyErrors embeds up to ~80 characters of the offending source line,
    // verbatim, in the thrown message. A project .lexicon.yaml is untrusted
    // input that may be shown to an agent, so the reason is all we want: a
    // deliberate syntax error after a line of instructions must not become a
    // way to get that line quoted back into a model's context.
    raw = parseYaml(text, { prettyErrors: false });
  } catch (err) {
    throw new Error(`Failed to parse lexicon YAML at ${filePath}: ${errorMessage(err)}`);
  }
  // An empty file is a valid, empty lexicon.
  if (raw === null || raw === undefined) {
    return { path: filePath, scope, lexicon: emptyLexicon(), exists: true };
  }
  let lexicon: Lexicon;
  try {
    lexicon = parseLexicon(raw);
  } catch (err) {
    throw new Error(`Invalid lexicon at ${filePath}: ${errorMessage(err)}`);
  }
  return { path: filePath, scope, lexicon, exists: true };
}

export async function writeLexiconFile(file: LexiconFile): Promise<void> {
  const body = stringifyYaml(orderLexicon(file.lexicon), { lineWidth: 0 });
  const header = HEADER_COMMENT.split('\n')
    .map((line) => (line ? `# ${line}` : '#'))
    .join('\n');
  await writeFileAtomic(file.path, `${header}\n\n${body}`);
  file.exists = true;
}

const TERM_KEY_ORDER: (keyof Term)[] = [
  'canonical',
  'aliases',
  'phonetic',
  'category',
  'notes',
  'caseSensitive',
  'never',
  'scope',
  'source',
  'createdAt',
  'hits',
];

/**
 * Drop `undefined` values and empty lists. The schema materializes an empty
 * array for every optional word list (`protectedWords`, `packs`), so without
 * this a plain `lexicon add` would litter a hand-edited file with `packs: []`.
 */
function orderLexicon(lexicon: Lexicon): Record<string, unknown> {
  const out: Record<string, unknown> = { version: lexicon.version };
  if (lexicon.settings && Object.keys(stripUndefined(lexicon.settings)).length > 0) {
    out.settings = stripUndefined(lexicon.settings);
  }
  out.terms = lexicon.terms.map((term) => {
    const ordered: Record<string, unknown> = {};
    for (const key of TERM_KEY_ORDER) {
      const value = term[key];
      if (value !== undefined) ordered[key] = value;
    }
    // Any keys not in the fixed order (future additions) go last.
    for (const [key, value] of Object.entries(term)) {
      if (!(key in ordered) && value !== undefined) ordered[key] = value;
    }
    return ordered;
  });
  return out;
}

function stripUndefined<T extends object>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load + merge
// ---------------------------------------------------------------------------

/**
 * Load global + project and merge them. The project file is merged ONLY when
 * it is trusted (`lexicon trust`, or `LEXICON_TRUST_ALL=1`), unless
 * `opts.includeUntrusted` is set. Otherwise the result is global-only with
 * `skippedProject` and `projectTrust` describing what was left out, so callers
 * can tell the user without ever injecting the file's contents.
 *
 * An untrusted project file that fails to parse is skipped the same way rather
 * than thrown, so a hostile or broken repo file cannot disable the global
 * lexicon in the hook.
 */
export async function loadLexicon(opts: LoadOptions = {}): Promise<LoadedLexicon> {
  const paths = resolvePaths(opts);
  const global = await readLexiconFile(paths.global, 'global');
  if (!paths.project) return { merged: mergeLexicons(global.lexicon), global };

  let project: LexiconFile;
  try {
    project = await readLexiconFile(paths.project, 'project');
  } catch (err) {
    const placeholder: LexiconFile = { path: paths.project, scope: 'project', lexicon: emptyLexicon(), exists: true };
    const trust = await isTrusted(placeholder, opts);
    if (trust === 'trusted' || opts.includeUntrusted) throw err;
    return { merged: mergeLexicons(global.lexicon), global, projectTrust: trust, skippedProject: placeholder };
  }

  const projectTrust = await isTrusted(project, opts);
  if (projectTrust === 'trusted' || opts.includeUntrusted) {
    return { merged: mergeLexicons(global.lexicon, project.lexicon), global, project, projectTrust };
  }
  return { merged: mergeLexicons(global.lexicon), global, projectTrust, skippedProject: project };
}

/**
 * Merge a project lexicon over a global one. Project terms replace global terms
 * with the same canonical (case-insensitive) but aliases are unioned; settings
 * override per key; protectedWords are unioned.
 */
export function mergeLexicons(global: Lexicon, project?: Lexicon): Lexicon {
  const terms: Term[] = global.terms.map((t) => ({ ...t, aliases: [...t.aliases], scope: t.scope ?? 'global' }));
  if (project) {
    for (const pt of project.terms) {
      const idx = terms.findIndex((t) => sameCanonical(t.canonical, pt.canonical));
      const replacement: Term = { ...pt, scope: pt.scope ?? 'project' };
      if (idx === -1) {
        terms.push({ ...replacement, aliases: [...pt.aliases] });
      } else {
        replacement.aliases = dedupeAliases([...pt.aliases, ...terms[idx].aliases], pt.canonical);
        terms[idx] = replacement;
      }
    }
  }
  const settings = mergeSettings(global.settings, project?.settings);
  const merged: Lexicon = { version: 1, terms };
  if (settings) merged.settings = settings;
  return merged;
}

function mergeSettings(
  global?: LexiconSettings,
  project?: LexiconSettings,
): LexiconSettings | undefined {
  if (!global && !project) return undefined;
  const out: LexiconSettings = { ...(global ?? {}), ...(project ?? {}) };
  const protectedWords = dedupeCaseInsensitive([
    ...(global?.protectedWords ?? []),
    ...(project?.protectedWords ?? []),
  ]);
  if (protectedWords.length > 0) out.protectedWords = protectedWords;
  else delete out.protectedWords;
  return out;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Thrown when a write would target an existing project lexicon that the user
 * has not approved (or that changed since they did). Writing would read the
 * unreviewed file, merge into it and re-pin the whole thing as trusted, which
 * launders a hostile repo file into the model's context.
 */
export class ProjectTrustError extends Error {
  readonly path: string;
  readonly status: Exclude<TrustStatus, 'trusted'>;

  constructor(projectPath: string, status: Exclude<TrustStatus, 'trusted'>) {
    const why = status === 'changed' ? 'has changed since it was trusted' : 'is untrusted';
    super(
      `project lexicon at ${projectPath} ${why}; review it and run \`lexicon trust\` first, or write to the global lexicon instead`,
    );
    this.name = 'ProjectTrustError';
    this.path = projectPath;
    this.status = status;
  }
}

/**
 * Gate for every project-scope write. A file that does not exist yet may be
 * created (the user is authoring it, and writeAndTrust pins it). An existing
 * file must already be 'trusted' (registry match, LEXICON_TRUST_ALL, or inside
 * the global config dir); 'untrusted' and 'changed' throw before anything is
 * read or merged. Callers that must never throw (recordHits) skip the file
 * instead of calling this.
 */
async function assertProjectWritable(projectPath: string, opts: StoreOptions): Promise<void> {
  if (!existsSync(projectPath)) return;
  const status = await isTrusted(
    { path: projectPath, scope: 'project', lexicon: emptyLexicon(), exists: true },
    opts,
  );
  if (status !== 'trusted') throw new ProjectTrustError(projectPath, status);
}

export async function addTerm(
  term: Term,
  opts: StoreOptions & { scope?: TermScope; merge?: boolean } = {},
): Promise<{ file: LexiconFile; term: Term; created: boolean }> {
  const scope: TermScope = opts.scope ?? 'global';
  const file = await resolveScopeFile(scope, opts);
  const canonical = term.canonical.trim();
  if (!canonical) throw new Error('addTerm: canonical must not be empty');

  const incoming: Term = {
    ...term,
    canonical,
    aliases: dedupeAliases(term.aliases ?? [], canonical),
  };

  const existing = findTerm(file.lexicon, canonical);
  if (existing && opts.merge !== false) {
    existing.aliases = dedupeAliases([...existing.aliases, ...incoming.aliases], existing.canonical);
    existing.phonetic ??= incoming.phonetic;
    existing.category ??= incoming.category;
    existing.notes ??= incoming.notes;
    existing.caseSensitive ??= incoming.caseSensitive;
    if (incoming.never?.length) {
      existing.never = dedupeCaseInsensitive([...(existing.never ?? []), ...incoming.never]);
    }
    await writeAndTrust(file, opts);
    return { file, term: existing, created: false };
  }

  if (existing) {
    // merge === false: replace outright, keeping the original creation time.
    const replaced: Term = {
      ...incoming,
      scope,
      source: incoming.source ?? 'user',
      createdAt: existing.createdAt ?? incoming.createdAt ?? new Date().toISOString(),
    };
    const idx = file.lexicon.terms.indexOf(existing);
    file.lexicon.terms[idx] = replaced;
    await writeAndTrust(file, opts);
    return { file, term: replaced, created: false };
  }

  const created: Term = {
    ...incoming,
    scope,
    source: incoming.source ?? 'user',
    createdAt: incoming.createdAt ?? new Date().toISOString(),
  };
  file.lexicon.terms.push(created);
  await writeAndTrust(file, opts);
  return { file, term: created, created: true };
}

/**
 * Write a lexicon file and, for a project file, register it as trusted: the
 * user (or an agent acting on their explicit add/harvest request) just wrote
 * it, which is the same judgment `lexicon trust` records. Only reached for a
 * file that was new or already trusted (see assertProjectWritable), so this
 * re-pins the user's own edit and never blesses pre-existing untrusted
 * content. Global files need no trust entry.
 */
async function writeAndTrust(file: LexiconFile, opts: StoreOptions): Promise<void> {
  await writeLexiconFile(file);
  if (file.scope === 'project') await trustProject(file.path, opts);
}

/**
 * Remove `canonical` from the first file that holds it (project, then global,
 * or just the requested scope). Throws ProjectTrustError when the term lives
 * in an untrusted/changed project file: rewriting that file would look like a
 * user edit and must not happen until the user has reviewed it.
 */
export async function removeTerm(
  canonical: string,
  opts: StoreOptions & { scope?: TermScope } = {},
): Promise<boolean> {
  const files = await candidateFiles(opts, opts.scope);
  for (const file of files) {
    if (!file.exists) continue;
    const remaining = file.lexicon.terms.filter((t) => !sameCanonical(t.canonical, canonical));
    if (remaining.length === file.lexicon.terms.length) continue;
    if (file.scope === 'project') await assertProjectWritable(file.path, opts);
    file.lexicon.terms = remaining;
    await writeLexiconFile(file);
    // The user's own edit must not flip an already-trusted file to 'changed'.
    if (file.scope === 'project') await refreshTrust(file.path, opts);
    return true;
  }
  return false;
}

/** Increment `hits` on each canonical in whichever file holds it. Never throws. */
export async function recordHits(canonicals: string[], opts: StoreOptions = {}): Promise<void> {
  try {
    if (canonicals.length === 0) return;
    const counts = new Map<string, number>();
    for (const c of canonicals) {
      const key = c.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const files = await candidateFiles(opts);
    for (const file of files) {
      if (!file.exists) continue;
      // Hits only come from merged terms, so an untrusted project file cannot
      // have produced any; skip it silently (this function never throws, so
      // it cannot use assertProjectWritable) and never auto-trust it here.
      if (file.scope === 'project' && (await isTrusted(file, opts)) !== 'trusted') continue;
      let touched = false;
      for (const term of file.lexicon.terms) {
        const n = counts.get(term.canonical.toLowerCase());
        if (n) {
          term.hits = (term.hits ?? 0) + n;
          touched = true;
          // Project file is consulted first; do not double-count in global.
          counts.delete(term.canonical.toLowerCase());
        }
      }
      if (touched) {
        await writeLexiconFile(file);
        if (file.scope === 'project') await refreshTrust(file.path, opts);
      }
    }
  } catch {
    // best effort by contract
  }
}

export function findTerm(lexicon: Lexicon, canonical: string): Term | undefined {
  return lexicon.terms.find((t) => sameCanonical(t.canonical, canonical));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The file a scoped write targets. For project scope the trust gate runs BEFORE the file is read. */
async function resolveScopeFile(scope: TermScope, opts: StoreOptions): Promise<LexiconFile> {
  const paths = resolvePaths(opts);
  if (scope === 'global') return readLexiconFile(paths.global, 'global');
  const projectPath = paths.project ?? defaultProjectPath(opts.cwd ?? process.cwd());
  await assertProjectWritable(projectPath, opts);
  return readLexiconFile(projectPath, 'project');
}

/** Files to search for a term: project first (if any), then global; or just the requested scope. */
async function candidateFiles(opts: StoreOptions, scope?: TermScope): Promise<LexiconFile[]> {
  const paths = resolvePaths(opts);
  if (scope === 'global') return [await readLexiconFile(paths.global, 'global')];
  if (scope === 'project') {
    return paths.project ? [await readLexiconFile(paths.project, 'project')] : [];
  }
  const files: LexiconFile[] = [];
  if (paths.project) files.push(await readLexiconFile(paths.project, 'project'));
  files.push(await readLexiconFile(paths.global, 'global'));
  return files;
}

function sameCanonical(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Trim, drop empties and anything equal to the canonical, dedupe case-insensitively (first spelling wins). */
export function dedupeAliases(aliases: string[], canonical: string): string[] {
  const canon = canonical.trim().toLowerCase();
  return dedupeCaseInsensitive(aliases).filter((a) => a.toLowerCase() !== canon);
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

