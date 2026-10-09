/**
 * Vocabulary import sources: where a user's proper nouns live outside the
 * lexicon, and how to turn each place into harvest candidates without ever
 * writing anything. This is the engine behind `lexicon import --guided` and
 * the MCP `import_vocabulary` tool.
 *
 * The privacy posture is the whole design. Every source here reads only data
 * already on this machine or reachable with credentials the user set up
 * themselves (`gh` CLI auth); there is no new OAuth, no new network call
 * beyond the source's own API. Lexicon adds no automatic upload or telemetry;
 * previews are returned to the requesting CLI/MCP client, which may share
 * them with its model provider. Email and
 * Slack are listed as sources the wizard knows about but does not implement:
 * reading someone's mail or workspace messages to build a vocabulary file is
 * exactly the access this project tells agents to ask about first, so they
 * stay unavailable until that conversation happens, and the wizard says so
 * instead of silently omitting them.
 *
 * All process spawning and filesystem probing goes through `ImportSourceDeps`
 * (the same seam as `SetupDeps`), so tests never touch the machine.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARVEST_STOPLIST, harvestAliases } from './harvest.js';
import { addTerm } from './store.js';
import type { StoreOptions } from './store.js';
import type { HarvestCandidate, Term, TermCategory, TermScope, TermSource } from './types.js';

export const IMPORT_SOURCE_IDS = ['contacts', 'calendar', 'github', 'email', 'slack'] as const;
export type ImportSourceId = (typeof IMPORT_SOURCE_IDS)[number];

/** Sources the wizard can actually harvest from today. */
export const IMPLEMENTED_IMPORT_SOURCES: readonly ImportSourceId[] = ['contacts', 'calendar', 'github'];

export type ImportExec = (file: string, args: readonly string[]) => string;

export interface ImportSourceDeps {
  platform?: NodeJS.Platform;
  /** Home directory. Default os.homedir(). */
  home?: string;
  /** Filesystem probe. Default existsSync. */
  exists?: (p: string) => boolean;
  /** Read a text file (the .ics calendars). Default readFileSync utf8. */
  readText?: (p: string) => string;
  /** List a directory's entry names. Default readdirSync. */
  readDir?: (p: string) => string[];
  /** True when p is a directory. Default statSync-based. */
  isDirectory?: (p: string) => boolean;
  /** File size in bytes, undefined when unreadable. Default statSync-based. */
  fileSize?: (p: string) => number | undefined;
  /** Run `sqlite3` / `gh`. Default execFileSync with a short timeout; throws on failure. */
  exec?: ImportExec;
}

const defaultDeps = (): Required<ImportSourceDeps> => ({
  platform: process.platform,
  home: os.homedir(),
  exists: existsSync,
  readText: (p) => readFileSync(p, 'utf8'),
  readDir: (p) => readdirSync(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  fileSize: (p) => {
    try {
      return statSync(p).size;
    } catch {
      return undefined;
    }
  },
  exec: ((file, args) =>
    execFileSync(file, [...args], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })) as ImportExec,
});

export interface SourceAvailability {
  available: boolean;
  /** Human reason when unavailable; shown greyed out in the wizard. */
  reason?: string;
}

export interface VocabImportSource {
  id: ImportSourceId;
  /** Shown in the wizard checklist, e.g. "macOS Contacts". */
  label: string;
  /** One line naming exactly what is read. Shown before the user opts in. */
  privacy: string;
  /** False for sources the wizard knows about but does not implement (email, slack). */
  implemented: boolean;
  checkAvailable(deps?: ImportSourceDeps): Promise<SourceAvailability>;
  harvest(deps?: ImportSourceDeps): Promise<HarvestCandidate[]>;
}

/** Fill in the defaults for the fields the caller did not inject. Exported for the CLI, which adds its own `--home`. */
export function resolveImportSourceDeps(deps: ImportSourceDeps = {}): Required<ImportSourceDeps> {
  const d = defaultDeps();
  return {
    platform: deps.platform ?? d.platform,
    home: deps.home ?? d.home,
    exists: deps.exists ?? d.exists,
    readText: deps.readText ?? d.readText,
    readDir: deps.readDir ?? d.readDir,
    isDirectory: deps.isDirectory ?? d.isDirectory,
    fileSize: deps.fileSize ?? d.fileSize,
    exec: deps.exec ?? d.exec,
  };
}

function resolved(deps: ImportSourceDeps = {}): Required<ImportSourceDeps> {
  return resolveImportSourceDeps(deps);
}

function tryExec(deps: Required<ImportSourceDeps>, file: string, args: readonly string[]): string | undefined {
  try {
    return deps.exec(file, args);
  } catch {
    return undefined;
  }
}

/**
 * Alias policy for imported candidates. `harvestAliases` gives identifiers no
 * aliases at all, which is right for a code symbol (splitting one yields
 * ordinary English) but wrong for a GitHub handle or a repo name: those are
 * dictated as words ("ping octocat", "clone lexicon"), so they keep the
 * single-word suggestions and lose only the guessed multi-word splits.
 */
function importAliases(canonical: string, category: TermCategory): string[] {
  if (category === 'identifier') {
    return harvestAliases(canonical, 'person').filter((a) => !/\s/.test(a));
  }
  return harvestAliases(canonical, category);
}

function personCandidate(
  name: string,
  source: TermSource,
  evidence: string,
  count = 1,
): HarvestCandidate | undefined {
  const canonical = name.trim().replace(/\s+/g, ' ');
  if (canonical.length < 2 || canonical.length > 80) return undefined;
  // Email-shaped, bot-shaped or bot-named strings are not people.
  if (/@/.test(canonical) || /\[bot\]$/i.test(canonical) || /\bbot\b/i.test(canonical)) return undefined;
  return {
    canonical,
    category: 'person',
    source,
    evidence: [evidence],
    count,
    suggestedAliases: importAliases(canonical, 'person'),
  };
}

/** Merge candidates that spell the same name (case-insensitive): counts and evidence add up, aliases union. */
export function mergeCandidates(candidates: readonly HarvestCandidate[]): HarvestCandidate[] {
  const byKey = new Map<string, HarvestCandidate>();
  for (const c of candidates) {
    const key = c.canonical.toLowerCase();
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...c, evidence: [...c.evidence], suggestedAliases: [...c.suggestedAliases] });
      continue;
    }
    // Conflicting canonicals (McCann vs Mccann): the higher count wins the
    // spelling; the loser survives as an alias so the name still matches.
    if (c.count > prev.count) {
      const demoted = prev.canonical;
      prev.canonical = c.canonical;
      prev.category = c.category;
      prev.source = c.source;
      if (!prev.suggestedAliases.some((a) => a.toLowerCase() === demoted.toLowerCase())) {
        prev.suggestedAliases.push(demoted);
      }
    }
    prev.count += c.count;
    for (const e of c.evidence) if (!prev.evidence.includes(e)) prev.evidence.push(e);
    for (const a of c.suggestedAliases) {
      if (a.toLowerCase() !== prev.canonical.toLowerCase() && !prev.suggestedAliases.some((x) => x.toLowerCase() === a.toLowerCase())) {
        prev.suggestedAliases.push(a);
      }
    }
  }
  const out = [...byKey.values()];
  out.sort((a, b) => b.count - a.count || a.canonical.localeCompare(b.canonical));
  return out;
}

// ---------------------------------------------------------------------------
// contacts: macOS AddressBook
// ---------------------------------------------------------------------------

function addressBookDirs(deps: Required<ImportSourceDeps>): string[] {
  const base = path.join(deps.home, 'Library', 'Application Support', 'AddressBook');
  const dirs = [base];
  // Synced accounts live under Sources/<uuid>/.
  try {
    for (const entry of deps.readDir(path.join(base, 'Sources'))) {
      const full = path.join(base, 'Sources', entry);
      if (deps.isDirectory(full)) dirs.push(full);
    }
  } catch {
    // No Sources directory; the local book is enough.
  }
  return dirs;
}

function addressBookDb(deps: Required<ImportSourceDeps>): string | undefined {
  for (const dir of addressBookDirs(deps)) {
    for (const name of ['AddressBook-v22.abcddb', 'AddressBook.abcddb']) {
      const p = path.join(dir, name);
      if (deps.exists(p)) return p;
    }
  }
  return undefined;
}

const CONTACTS_QUERY =
  'SELECT ZFIRSTNAME, ZLASTNAME, ZORGANIZATION FROM ZABCDCONTACT WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL;';

const contactsSource: VocabImportSource = {
  id: 'contacts',
  label: 'macOS Contacts',
  privacy: 'Reads first/last names and organizations from your local macOS Contacts database. Lexicon adds no automatic upload or telemetry. Candidate previews are returned to your CLI/MCP client and may reach its model provider.',
  implemented: true,
  async checkAvailable(deps = {}): Promise<SourceAvailability> {
    const d = resolved(deps);
    if (d.platform !== 'darwin') return { available: false, reason: 'macOS Contacts only exists on macOS' };
    if (!addressBookDb(d)) return { available: false, reason: 'no AddressBook database found under ~/Library/Application Support/AddressBook' };
    if (tryExec(d, 'sqlite3', ['--version']) === undefined) {
      return { available: false, reason: 'the sqlite3 command-line tool is not on PATH' };
    }
    return { available: true };
  },
  async harvest(deps = {}): Promise<HarvestCandidate[]> {
    const d = resolved(deps);
    const db = addressBookDb(d);
    if (!db) return [];
    const out = tryExec(d, 'sqlite3', ['-separator', '\t', db, CONTACTS_QUERY]);
    if (out === undefined) return [];
    const candidates: HarvestCandidate[] = [];
    for (const line of out.split('\n')) {
      const [first = '', last = '', org = ''] = line.split('\t');
      const name = `${first} ${last}`.trim();
      const person = personCandidate(name, 'import:contacts', 'macOS Contacts');
      if (person) candidates.push(person);
      const organization = org.trim();
      if (organization.length >= 3 && organization.length <= 80 && !/@/.test(organization)) {
        candidates.push({
          canonical: organization,
          category: 'brand',
          source: 'import:contacts',
          evidence: ['macOS Contacts organization'],
          count: 1,
          suggestedAliases: importAliases(organization, 'brand'),
        });
      }
    }
    return mergeCandidates(candidates);
  },
};

// ---------------------------------------------------------------------------
// calendar: macOS Calendar .ics files
// ---------------------------------------------------------------------------

const MAX_ICS_FILES = 2000;
const MAX_ICS_BYTES = 512 * 1024;

/** Unfold RFC 5545 line folding and split into content lines. */
function unfoldIcs(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length > 0) out[out.length - 1] += raw.slice(1);
    else out.push(raw);
  }
  return out;
}

function icsParamCN(line: string): string | undefined {
  const m = /;CN=([^;:]+)/i.exec(line);
  return m ? m[1].trim() : undefined;
}

interface IcsEvent {
  summary?: string;
  attendees: string[];
  organizer?: string;
}

function parseIcsEvents(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: IcsEvent | undefined;
  for (const line of unfoldIcs(text)) {
    if (/^BEGIN:VEVENT/i.test(line)) current = { attendees: [] };
    else if (/^END:VEVENT/i.test(line)) {
      if (current) events.push(current);
      current = undefined;
    } else if (current) {
      if (/^SUMMARY[:;]/i.test(line)) current.summary = line.replace(/^SUMMARY[^:]*:/i, '').trim();
      else if (/^ATTENDEE/i.test(line)) {
        const cn = icsParamCN(line);
        if (cn) current.attendees.push(cn);
      } else if (/^ORGANIZER/i.test(line)) {
        const cn = icsParamCN(line);
        if (cn) current.organizer = cn;
      }
    }
  }
  return events;
}

/**
 * Proper-noun-ish words from an event title. Titles are noisy ("Standup",
 * "Dentist", "Flight to Denver"), so only multi-word capitalized phrases and
 * single capitalized words of length 4+ that are not on the harvest stoplist
 * survive; a lone generic word never becomes a term.
 */
function titleProperNouns(summary: string): string[] {
  const out: string[] = [];
  const words = summary.split(/\s+/).map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''));
  let phrase: string[] = [];
  const flush = (): void => {
    if (phrase.length >= 2) out.push(phrase.join(' '));
    else if (phrase.length === 1) {
      const [w] = phrase;
      if (w.length >= 4 && !HARVEST_STOPLIST.has(w)) out.push(w);
    }
    phrase = [];
  };
  for (const w of words) {
    if (/^[A-Z][a-z]+$/.test(w) && !HARVEST_STOPLIST.has(w)) phrase.push(w);
    else flush();
  }
  flush();
  return out;
}

function calendarDir(deps: Required<ImportSourceDeps>): string | undefined {
  const dir = path.join(deps.home, 'Library', 'Calendars');
  return deps.exists(dir) ? dir : undefined;
}

function icsFiles(deps: Required<ImportSourceDeps>, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= MAX_ICS_FILES) return;
    let entries: string[];
    try {
      entries = deps.readDir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_ICS_FILES) return;
      const full = path.join(d, entry);
      if (entry.endsWith('.ics')) {
        const size = deps.fileSize(full);
        if (size !== undefined && size <= MAX_ICS_BYTES) out.push(full);
      } else if (!entry.startsWith('.')) {
        // Calendars nest one level (uuid.calendar/Events); recurse shallowly.
        if (deps.isDirectory(full)) walk(full);
      }
    }
  };
  walk(dir);
  return out;
}

const calendarSource: VocabImportSource = {
  id: 'calendar',
  label: 'macOS Calendar',
  privacy: 'Reads event titles, attendee and organizer names from your locally synced calendars (~/Library/Calendars). Lexicon adds no automatic upload or telemetry. Candidate previews are returned to your CLI/MCP client and may reach its model provider.',
  implemented: true,
  async checkAvailable(deps = {}): Promise<SourceAvailability> {
    const d = resolved(deps);
    if (d.platform !== 'darwin') return { available: false, reason: 'macOS Calendar only exists on macOS' };
    if (!calendarDir(d)) return { available: false, reason: 'no ~/Library/Calendars directory found' };
    return { available: true };
  },
  async harvest(deps = {}): Promise<HarvestCandidate[]> {
    const d = resolved(deps);
    const dir = calendarDir(d);
    if (!dir) return [];
    const candidates: HarvestCandidate[] = [];
    for (const file of icsFiles(d, dir)) {
      let text: string;
      try {
        text = d.readText(file);
      } catch {
        continue;
      }
      for (const event of parseIcsEvents(text)) {
        for (const name of event.attendees) {
          const c = personCandidate(name, 'import:calendar', event.summary ? `calendar: ${event.summary}` : 'calendar attendee');
          if (c) candidates.push(c);
        }
        if (event.organizer) {
          const c = personCandidate(event.organizer, 'import:calendar', event.summary ? `calendar: ${event.summary}` : 'calendar organizer');
          if (c) candidates.push(c);
        }
        if (event.summary) {
          for (const noun of titleProperNouns(event.summary)) {
            candidates.push({
              canonical: noun,
              category: 'other',
              source: 'import:calendar',
              evidence: [`calendar event title: ${event.summary.slice(0, 60)}`],
              count: 1,
              suggestedAliases: importAliases(noun, 'other'),
            });
          }
        }
      }
    }
    const merged = mergeCandidates(candidates);
    // Event titles are noisy ("Dentist", "1:1"), so a single-word title noun
    // is only proposed when it recurs across events. People are always
    // proposed: an attendee name is high-precision by construction.
    return merged.filter((c) => c.category !== 'other' || /\s/.test(c.canonical) || c.count >= 2);
  },
};

// ---------------------------------------------------------------------------
// github: the gh CLI
// ---------------------------------------------------------------------------

function ghJson(d: Required<ImportSourceDeps>, args: readonly string[]): unknown {
  const paginated = args.includes('--paginate');
  const out = tryExec(d, 'gh', [...args, ...(paginated ? ['--slurp'] : []), '--jq', '.']);
  if (out === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(out);
    return paginated && Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed.flat() : parsed;
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A GitHub login is dictated as a word; keep it, but never invent word boundaries for one. */
function loginCandidate(login: string, evidence: string): HarvestCandidate | undefined {
  const canonical = login.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,38}$/.test(canonical)) return undefined;
  return {
    canonical,
    category: 'identifier',
    source: 'import:github',
    evidence: [evidence],
    count: 1,
    suggestedAliases: importAliases(canonical, 'identifier'),
  };
}

const githubSource: VocabImportSource = {
  id: 'github',
  label: 'GitHub (gh CLI)',
  privacy: 'Calls api.github.com with your existing gh login: your username, org memberships, member logins and repo names. No new OAuth scopes.',
  implemented: true,
  async checkAvailable(deps = {}): Promise<SourceAvailability> {
    const d = resolved(deps);
    const status = tryExec(d, 'gh', ['auth', 'status']);
    if (status === undefined) return { available: false, reason: 'gh is not installed or not logged in (run gh auth login)' };
    return { available: true };
  },
  async harvest(deps = {}): Promise<HarvestCandidate[]> {
    const d = resolved(deps);
    const candidates: HarvestCandidate[] = [];
    const user = ghJson(d, ['api', 'user']);
    if (isRecord(user)) {
      if (typeof user.name === 'string' && user.name.trim()) {
        const c = personCandidate(user.name, 'import:github', 'GitHub profile name');
        if (c) candidates.push(c);
      }
      if (typeof user.login === 'string') {
        const c = loginCandidate(user.login, 'GitHub username');
        if (c) candidates.push(c);
      }
    }
    const orgs = ghJson(d, ['api', 'user/orgs']);
    const orgLogins = Array.isArray(orgs)
      ? orgs.filter(isRecord).map((o) => o.login).filter((l): l is string => typeof l === 'string')
      : [];
    for (const org of orgLogins.slice(0, 20)) {
      const members = ghJson(d, ['api', `orgs/${org}/members`, '--paginate']);
      if (Array.isArray(members)) {
        for (const m of members.filter(isRecord)) {
          if (typeof m.login === 'string') {
            const c = loginCandidate(m.login, `GitHub org ${org} member`);
            if (c) candidates.push(c);
          }
        }
      }
      const orgRepos = ghJson(d, ['api', `orgs/${org}/repos`, '--paginate']);
      if (Array.isArray(orgRepos)) {
        for (const r of orgRepos.filter(isRecord)) {
          if (typeof r.name === 'string' && r.name.trim()) {
            candidates.push({
              canonical: r.name,
              category: 'product',
              source: 'import:github',
              evidence: [`GitHub repo ${org}/${r.name}`],
              count: 1,
              suggestedAliases: importAliases(r.name, 'product'),
            });
          }
        }
      }
    }
    const repos = ghJson(d, ['api', 'user/repos', '--paginate']);
    if (Array.isArray(repos)) {
      for (const r of repos.filter(isRecord).slice(0, 200)) {
        if (typeof r.name === 'string' && r.name.trim()) {
          const owner = isRecord(r.owner) && typeof r.owner.login === 'string' ? r.owner.login : undefined;
          candidates.push({
            canonical: r.name,
            category: 'product',
            source: 'import:github',
            evidence: [`GitHub repo ${owner ? `${owner}/` : ''}${r.name}`],
            count: 1,
            suggestedAliases: importAliases(r.name, 'product'),
          });
        }
      }
    }
    return mergeCandidates(candidates);
  },
};

// ---------------------------------------------------------------------------
// email / slack: known, not implemented
// ---------------------------------------------------------------------------

function unimplemented(id: ImportSourceId, label: string, privacy: string, reason: string): VocabImportSource {
  return {
    id,
    label,
    privacy,
    implemented: false,
    checkAvailable: async () => ({ available: false, reason }),
    harvest: async () => [],
  };
}

const SOURCES: Record<ImportSourceId, VocabImportSource> = {
  contacts: contactsSource,
  calendar: calendarSource,
  github: githubSource,
  email: unimplemented(
    'email',
    'Email correspondents',
    'Would read sender and recipient names from recent threads. Not implemented: that needs new OAuth scopes, which is a conversation, not a default.',
    'not yet supported: reading mail needs new OAuth scopes; local-only sources ship first',
  ),
  slack: unimplemented(
    'slack',
    'Slack / Discord workspace',
    'Would read workspace member and channel names. Not implemented: that needs a workspace token, which is a conversation, not a default.',
    'not yet supported: needs a workspace token; local-only sources ship first',
  ),
};

/** Every known source, in wizard order. */
export function listImportSources(): VocabImportSource[] {
  return IMPORT_SOURCE_IDS.map((id) => SOURCES[id]);
}

/** Look up one source by id; throws for an unknown id. */
export function getImportSource(id: string): VocabImportSource {
  const found = (Object.values(SOURCES) as VocabImportSource[]).find((s) => s.id === id);
  if (!found) throw new Error(`unknown import source "${id}" (expected one of: ${IMPORT_SOURCE_IDS.join(', ')})`);
  return found;
}

/** Harvest every chosen source and merge the candidates across them. */
export async function harvestImportSources(
  ids: readonly ImportSourceId[],
  deps: ImportSourceDeps = {},
  opts: { limit?: number } = {},
): Promise<HarvestCandidate[]> {
  const all: HarvestCandidate[] = [];
  for (const id of ids) {
    const source = getImportSource(id);
    if (!source.implemented) continue;
    const availability = await source.checkAvailable(deps);
    if (!availability.available) continue;
    all.push(...(await source.harvest(deps)));
  }
  const merged = mergeCandidates(all);
  const limit = opts.limit ?? 50;
  return merged.slice(0, Math.max(0, limit));
}

export interface ApplyImportResult {
  added: number;
  merged: number;
  skipped: number;
  /** The lexicon file written. */
  path?: string;
}

/**
 * Write accepted candidates into the lexicon through `addTerm`, so the merge
 * rules are the familiar ones: an existing term keeps its own spelling and
 * aliases and only gains the candidate's. New terms are stamped with the
 * `import:<source>` source tag; merged ones keep the source they already had.
 */
export async function applyImportCandidates(
  candidates: readonly HarvestCandidate[],
  opts: StoreOptions & { scope?: TermScope } = {},
): Promise<ApplyImportResult> {
  const scope: TermScope = opts.scope ?? 'global';
  let added = 0;
  let merged = 0;
  let path: string | undefined;
  for (const c of candidates) {
    const term: Term = {
      canonical: c.canonical,
      aliases: c.suggestedAliases,
      category: c.category,
      source: c.source,
    };
    const result = await addTerm(term, { ...opts, scope });
    path ??= result.file.path;
    if (result.created) added += 1;
    else merged += 1;
  }
  return { added, merged, skipped: 0, ...(path !== undefined ? { path } : {}) };
}
