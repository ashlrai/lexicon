/**
 * import-sources: the local-first vocabulary harvesters behind
 * `lexicon import --guided`. Every source is tested with injected deps; no
 * test touches the real machine (no AddressBook, no Calendars, no gh).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  IMPLEMENTED_IMPORT_SOURCES,
  IMPORT_SOURCE_IDS,
  applyImportCandidates,
  getImportSource,
  harvestImportSources,
  listImportSources,
  mergeCandidates,
} from '../src/core/import-sources.js';
import type { HarvestCandidate, ImportSourceDeps } from '../src/core/index.js';

function deps(overrides: ImportSourceDeps = {}): Required<ImportSourceDeps> {
  return {
    platform: 'darwin',
    home: '/fake/home',
    exists: () => false,
    readText: () => {
      throw new Error('unexpected read');
    },
    readDir: () => [],
    isDirectory: () => false,
    fileSize: () => undefined,
    exec: () => {
      throw new Error('unexpected exec');
    },
    ...overrides,
  };
}

const DB = '/fake/home/Library/Application Support/AddressBook/AddressBook-v22.abcddb';

function contactsDeps(rows: string): Required<ImportSourceDeps> {
  return deps({
    exists: (p) => p === DB || p === '/fake/home/Library/Application Support/AddressBook/Sources',
    readDir: (p) => (p.endsWith('Sources') ? [] : []),
    exec: (file, args) => {
      if (file === 'sqlite3' && args[0] === '--version') return '3.46.1';
      if (file === 'sqlite3') return rows;
      throw new Error(`unexpected exec ${file}`);
    },
  });
}

describe('listImportSources', () => {
  it('knows five sources in wizard order, three implemented', () => {
    expect(IMPORT_SOURCE_IDS).toEqual(['contacts', 'calendar', 'github', 'email', 'slack']);
    expect(IMPLEMENTED_IMPORT_SOURCES).toEqual(['contacts', 'calendar', 'github']);
    const sources = listImportSources();
    expect(sources.map((s) => s.id)).toEqual([...IMPORT_SOURCE_IDS]);
    for (const s of sources) {
      expect(s.label).toBeTruthy();
      expect(s.privacy).toBeTruthy();
    }
    expect(sources.find((s) => s.id === 'email')?.implemented).toBe(false);
    expect(sources.find((s) => s.id === 'slack')?.implemented).toBe(false);
  });

  it('getImportSource throws on an unknown id', () => {
    expect(() => getImportSource('carrier-pigeon')).toThrow(/unknown import source/);
  });
});

describe('contacts source', () => {
  const source = getImportSource('contacts');

  it('is unavailable off macOS', async () => {
    const d = contactsDeps('');
    expect(await source.checkAvailable({ ...d, platform: 'linux' })).toEqual({
      available: false,
      reason: expect.stringContaining('macOS'),
    });
  });

  it('is unavailable without the AddressBook database', async () => {
    expect(await source.checkAvailable(deps())).toEqual({
      available: false,
      reason: expect.stringContaining('AddressBook'),
    });
  });

  it('is unavailable without sqlite3', async () => {
    const d = contactsDeps('');
    d.exec = () => {
      throw new Error('not found');
    };
    expect(await source.checkAvailable(d)).toEqual({
      available: false,
      reason: expect.stringContaining('sqlite3'),
    });
  });

  it('harvests names and organizations, skipping email-shaped rows', async () => {
    const d = contactsDeps('Ada\tLovelace\t\nGrace\tHopper\t\nbot\t\t\n\t\t\nnoreply@example.com\t\t\n');
    const candidates = await source.harvest(d);
    const canonicals = candidates.map((c) => c.canonical);
    expect(canonicals).toContain('Ada Lovelace');
    expect(canonicals).toContain('Grace Hopper');
    expect(canonicals).not.toContain('bot');
    expect(canonicals.some((c) => c.includes('@'))).toBe(false);
    const ada = candidates.find((c) => c.canonical === 'Ada Lovelace');
    expect(ada?.category).toBe('person');
    expect(ada?.source).toBe('import:contacts');
  });

  it('requests a read-only Contacts database connection', async () => {
    let queryArgs: readonly string[] = [];
    await source.harvest({ ...contactsDeps(''), exec: (_file, args) => { queryArgs = args; return ''; } });
    expect(queryArgs).toEqual(['-init', '/dev/null', '-readonly', '-separator', '\t', DB, expect.stringContaining('SELECT')]);
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sqlite3'))('never creates a Contacts database if it disappears before the query', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-contacts-race-'));
    const missing = path.join(home, 'Library', 'Application Support', 'AddressBook', 'AddressBook-v22.abcddb');
    mkdirSync(path.dirname(missing), { recursive: true });
    try {
      const result = await source.harvest(deps({ home, exists: (file) => file === missing,
        exec: (_file, args) => execFileSync('/usr/bin/sqlite3', [...args], {
          env: { ...process.env, HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin' },
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }),
      }));
      expect(result).toEqual([]);
      expect(existsSync(missing)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'darwin' || !existsSync('/usr/bin/sqlite3'))('never executes a user SQLite startup file during Contacts preview', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-contacts-init-'));
    const database = path.join(home, 'Library', 'Application Support', 'AddressBook', 'AddressBook-v22.abcddb');
    const marker = path.join(home, 'startup-output.txt');
    const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: '/usr/bin:/bin' };
    mkdirSync(path.dirname(database), { recursive: true });
    try {
      execFileSync('/usr/bin/sqlite3', ['-init', '/dev/null', database,
        'CREATE TABLE ZABCDCONTACT (ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZORGANIZATION TEXT);'], { env });
      writeFileSync(path.join(home, '.sqliterc'), `.output "${marker}"\nSELECT 1;\n`);
      expect(await source.harvest(deps({ home, exists: (file) => file === database,
        exec: (_file, args) => execFileSync('/usr/bin/sqlite3', [...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
      }))).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('harvests organizations as brands', async () => {
    const d = contactsDeps('\t\tAshlr.AI\n');
    const candidates = await source.harvest(d);
    const org = candidates.find((c) => c.canonical === 'Ashlr.AI');
    expect(org?.category).toBe('brand');
    expect(org?.source).toBe('import:contacts');
  });
});

const ICS = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:1
SUMMARY:Acme kickoff with Siobhan
DTSTART:20261001T100000Z
ATTENDEE;CN=Siobhan O'Brien:mailto:siobhan@example.com
ATTENDEE;CN=Standup Bot:mailto:bot@example.com
ORGANIZER;CN=Mason Wyatt:mailto:mason@example.com
END:VEVENT
BEGIN:VEVENT
UID:2
SUMMARY:Acme kickoff follow-up
DTSTART:20261008T100000Z
ATTENDEE;CN=Siobhan O'Brien:mailto:siobhan@example.com
END:VEVENT
BEGIN:VEVENT
UID:3
SUMMARY:Dentist
DTSTART:20261009T100000Z
END:VEVENT
END:VCALENDAR
`;

function calendarDeps(): Required<ImportSourceDeps> {
  const calDir = '/fake/home/Library/Calendars';
  const icsPath = `${calDir}/ABC.calendar/Events/1.ics`;
  return deps({
    exists: (p) => p === calDir,
    readDir: (p) => {
      if (p === calDir) return ['ABC.calendar'];
      if (p === `${calDir}/ABC.calendar`) return ['Events'];
      if (p === `${calDir}/ABC.calendar/Events`) return ['1.ics'];
      return [];
    },
    isDirectory: (p) => p === `${calDir}/ABC.calendar` || p === `${calDir}/ABC.calendar/Events`,
    fileSize: (p) => (p === icsPath ? ICS.length : undefined),
    readText: (p) => {
      if (p === icsPath) return ICS;
      throw new Error(`unexpected read ${p}`);
    },
  });
}

describe('calendar source', () => {
  const source = getImportSource('calendar');

  it('is unavailable without ~/Library/Calendars', async () => {
    expect(await source.checkAvailable(deps())).toEqual({
      available: false,
      reason: expect.stringContaining('Calendars'),
    });
  });

  it('harvests attendees and organizers as people, counted across events', async () => {
    const candidates = await source.harvest(calendarDeps());
    const siobhan = candidates.find((c) => c.canonical === "Siobhan O'Brien");
    expect(siobhan?.category).toBe('person');
    expect(siobhan?.source).toBe('import:calendar');
    expect(siobhan?.count).toBe(2);
    const mason = candidates.find((c) => c.canonical === 'Mason Wyatt');
    expect(mason?.category).toBe('person');
    // Bot-named attendees are not people.
    expect(candidates.some((c) => c.canonical === 'Standup Bot')).toBe(false);
  });

  it('proposes recurring title nouns but not one-off generic words', async () => {
    const candidates = await source.harvest(calendarDeps());
    const canonicals = candidates.map((c) => c.canonical);
    // "Acme" recurs across two events; "Dentist" is a one-off generic word.
    expect(canonicals).toContain('Acme');
    expect(canonicals).not.toContain('Dentist');
  });
});

function githubDeps(): Required<ImportSourceDeps> {
  return deps({
    platform: 'linux',
    exec: (file, args) => {
      if (file !== 'gh') throw new Error(`unexpected exec ${file}`);
      const api = args[1] as string;
      if (args[0] === 'auth') return 'Logged in';
      if (api === 'user') return JSON.stringify({ login: 'masonwyatt23', name: 'Mason Wyatt' });
      if (api === 'user/orgs') return JSON.stringify([{ login: 'ashlrai' }]);
      if (api === 'orgs/ashlrai/members') return JSON.stringify([{ login: 'masonwyatt23' }, { login: 'evan-d' }]);
      if (api === 'orgs/ashlrai/repos') return JSON.stringify([{ name: 'lexicon' }]);
      if (api === 'user/repos') return JSON.stringify([{ name: 'dotfiles', owner: { login: 'masonwyatt23' } }]);
      throw new Error(`unexpected gh api ${api}`);
    },
  });
}

describe('github source', () => {
  const source = getImportSource('github');

  it('slurps and flattens multiple actual gh pagination arrays', async () => {
    const base = githubDeps();
    const paged = { ...base, exec: (file: string, args: readonly string[]) => {
      if (args.includes('--paginate')) {
        expect(args).toContain('--slurp');
        if (args[1] === 'orgs/ashlrai/members') return JSON.stringify([[{ login: 'first-member' }], [{ login: 'second-member' }]]);
        if (args[1] === 'orgs/ashlrai/repos') return JSON.stringify([[{ name: 'FirstRepo' }], [{ name: 'SecondRepo' }]]);
        return JSON.stringify([[{ name: 'FirstPersonalRepo' }], [{ name: 'SecondPersonalRepo' }]]);
      }
      return base.exec(file, args);
    } };
    const names = (await source.harvest(paged)).map((c) => c.canonical);
    expect(names).toEqual(expect.arrayContaining(['first-member', 'second-member', 'FirstRepo', 'SecondRepo', 'FirstPersonalRepo', 'SecondPersonalRepo']));
  });

  it('is unavailable without gh auth', async () => {
    const d = deps({ platform: 'linux', exec: () => { throw new Error('not found'); } });
    expect(await source.checkAvailable(d)).toEqual({
      available: false,
      reason: expect.stringContaining('gh auth login'),
    });
  });

  it('harvests the profile name, logins and repo names', async () => {
    const candidates = await source.harvest(githubDeps());
    const byCanonical = new Map(candidates.map((c) => [c.canonical, c]));
    expect(byCanonical.get('Mason Wyatt')?.category).toBe('person');
    expect(byCanonical.get('Mason Wyatt')?.source).toBe('import:github');
    // Logins are identifiers, but unlike code symbols they keep single-word
    // aliases: they are dictated as words. A guessed word boundary
    // ("evan d") is still dropped; a single-word suggestion is kept.
    const login = byCanonical.get('evan-d');
    expect(login?.category).toBe('identifier');
    expect(login?.suggestedAliases.every((a) => !/\s/.test(a))).toBe(true);
    const own = byCanonical.get('masonwyatt23');
    expect(own?.suggestedAliases.length).toBeGreaterThan(0);
    expect(own?.suggestedAliases.every((a) => !/\s/.test(a))).toBe(true);
    const repo = byCanonical.get('lexicon');
    expect(repo?.category).toBe('product');
    expect(repo?.evidence[0]).toContain('ashlrai/lexicon');
    expect(byCanonical.get('dotfiles')?.evidence[0]).toContain('masonwyatt23/dotfiles');
  });

  it('dedupes the user login across org members', async () => {
    const candidates = await source.harvest(githubDeps());
    expect(candidates.filter((c) => c.canonical === 'masonwyatt23').length).toBe(1);
  });
});

describe('mergeCandidates', () => {
  const cand = (canonical: string, count: number, source: 'import:contacts' | 'import:github' = 'import:contacts'): HarvestCandidate => ({
    canonical,
    category: 'person',
    source,
    evidence: [`seen ${canonical}`],
    count,
    suggestedAliases: [],
  });

  it('merges case-insensitive duplicates, higher count winning the spelling', () => {
    const merged = mergeCandidates([cand('Mccann', 1), cand('McCann', 3, 'import:github')]);
    expect(merged.length).toBe(1);
    expect(merged[0].canonical).toBe('McCann');
    expect(merged[0].count).toBe(4);
    // The losing spelling survives as an alias so the name still matches.
    expect(merged[0].suggestedAliases).toContain('Mccann');
    expect(merged[0].evidence.length).toBe(2);
  });

  it('sorts by count then name', () => {
    const merged = mergeCandidates([cand('b', 1), cand('a', 1), cand('c', 5)]);
    expect(merged.map((c) => c.canonical)).toEqual(['c', 'a', 'b']);
  });
});

describe('harvestImportSources', () => {
  it('skips unimplemented and unavailable sources', async () => {
    const d = deps({ platform: 'linux' });
    const out = await harvestImportSources(['contacts', 'email', 'github'], d);
    // contacts unavailable on linux without the db; email unimplemented;
    // github unavailable without gh auth.
    expect(out).toEqual([]);
  });

  it('harvests the github source end to end', async () => {
    const out = await harvestImportSources(['github'], githubDeps(), { limit: 10 });
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(10);
  });

  it('throws on an unknown source id', async () => {
    await expect(harvestImportSources(['nope' as never], deps())).rejects.toThrow(/unknown import source/);
  });
});

describe('applyImportCandidates', () => {
  it('writes candidates through addTerm with the import source tag', async () => {
    const dir = `/tmp/lexicon-import-test-${process.pid}`;
    const globalPath = `${dir}/lexicon.yaml`;
    const candidates: HarvestCandidate[] = [
      { canonical: 'Ada Lovelace', category: 'person', source: 'import:contacts', evidence: [], count: 1, suggestedAliases: [] },
    ];
    const result = await applyImportCandidates(candidates, { globalPath });
    expect(result.added).toBe(1);
    expect(result.merged).toBe(0);
    expect(result.path).toBe(globalPath);
    // A second apply merges rather than duplicating.
    const again = await applyImportCandidates(candidates, { globalPath });
    expect(again.added).toBe(0);
    expect(again.merged).toBe(1);
  });
});
