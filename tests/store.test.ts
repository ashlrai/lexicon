import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Lexicon, LexiconFile, Term } from '../src/core/types.js';

/**
 * A passthrough for schema.ts, so a failure here is a store.ts failure and not
 * a validation one. Schema validation has its own suite (schema.test.ts).
 *
 * `schemaOverride` lets one test swap in the real validator for the duration of
 * a single write. The write path now runs its output back through
 * `parseLexicon` before replacing anything, and that guarantee is only worth
 * testing against the validator that actually rejects things.
 */
const schemaOverride = vi.hoisted(() => ({
  parseLexicon: undefined as ((raw: unknown) => unknown) | undefined,
}));

vi.mock('../src/core/schema.js', () => ({
  parseLexicon: (raw: unknown): Lexicon => {
    if (schemaOverride.parseLexicon) return schemaOverride.parseLexicon(raw) as Lexicon;
    const obj = (raw ?? {}) as Partial<Lexicon>;
    return { ...obj, version: 1, terms: Array.isArray(obj.terms) ? obj.terms : [] };
  },
  emptyLexicon: (): Lexicon => ({ version: 1, terms: [] }),
}));

import {
  ProjectTrustError,
  addTerm,
  defaultProjectPath,
  effectiveHits,
  findTerm,
  getHitsPath,
  loadLexicon,
  mergeLexicons,
  readLexiconFile,
  readProjectHits,
  recordHits,
  removeTerm,
  resolvePaths,
  writeLexiconFile,
} from '../src/core/store.js';
import { getTrustPath, hashFile, isTrusted, readTrustRegistry, trustProject } from '../src/core/trust.js';
import { BACKUP_SUFFIX, LOCK_SUFFIX, isFileLockError, withFileLock } from '../src/util/atomic.js';
import { xdgConfigHome, xdgDataHome, xdgStateHome } from '../src/util/xdg.js';

let tmp: string;
let globalPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-store-'));
  // Resolve symlinks (macOS /var -> /private/var) so path comparisons are exact.
  tmp = await fs.realpath(tmp);
  globalPath = path.join(tmp, 'global', 'lexicon.yaml');
  for (const key of ['LEXICON_PATH', 'XDG_CONFIG_HOME', 'LEXICON_TRUST_ALL']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  schemaOverride.parseLexicon = undefined;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function makeRepo(): Promise<{ root: string; nested: string }> {
  const root = path.join(tmp, 'repo');
  const nested = path.join(root, 'packages', 'deep');
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  return { root, nested };
}

describe('resolvePaths', () => {
  it('uses LEXICON_PATH when set', () => {
    process.env.LEXICON_PATH = '/custom/lex.yaml';
    expect(resolvePaths({ cwd: tmp }).global).toBe('/custom/lex.yaml');
  });

  it('uses XDG_CONFIG_HOME when LEXICON_PATH is unset', () => {
    process.env.XDG_CONFIG_HOME = '/xdg';
    expect(resolvePaths({ cwd: tmp }).global).toBe(path.join('/xdg', 'lexicon', 'lexicon.yaml'));
  });

  it('falls back to ~/.config/lexicon/lexicon.yaml', () => {
    expect(resolvePaths({ cwd: tmp }).global).toBe(
      path.join(os.homedir(), '.config', 'lexicon', 'lexicon.yaml'),
    );
  });

  it('globalPath option overrides the environment', () => {
    process.env.LEXICON_PATH = '/custom/lex.yaml';
    expect(resolvePaths({ cwd: tmp, globalPath: globalPath }).global).toBe(globalPath);
  });

  it('walks up from cwd to find .lexicon.yaml inside a git repo', async () => {
    const { root, nested } = await makeRepo();
    const projectFile = path.join(root, '.lexicon.yaml');
    await fs.writeFile(projectFile, 'version: 1\nterms: []\n');
    expect(resolvePaths({ cwd: nested }).project).toBe(projectFile);
  });

  it('stops at the git root and does not pick up a file above it', async () => {
    const { nested } = await makeRepo();
    await fs.writeFile(path.join(tmp, '.lexicon.yaml'), 'version: 1\nterms: []\n');
    expect(resolvePaths({ cwd: nested }).project).toBeUndefined();
  });

  it('returns no project when nothing is found', async () => {
    const { nested } = await makeRepo();
    expect(resolvePaths({ cwd: nested }).project).toBeUndefined();
  });

  it('defaultProjectPath points at the git root', async () => {
    const { root, nested } = await makeRepo();
    expect(defaultProjectPath(nested)).toBe(path.join(root, '.lexicon.yaml'));
    const plain = path.join(tmp, 'plain');
    await fs.mkdir(plain);
    expect(defaultProjectPath(plain)).toBe(path.join(plain, '.lexicon.yaml'));
  });
});

describe('readLexiconFile / writeLexiconFile', () => {
  it('returns exists:false and an empty lexicon for a missing file', async () => {
    const file = await readLexiconFile(path.join(tmp, 'nope.yaml'), 'global');
    expect(file.exists).toBe(false);
    expect(file.lexicon).toEqual({ version: 1, terms: [] });
    expect(file.scope).toBe('global');
  });

  it('round-trips terms and settings with a header comment and ordered keys', async () => {
    const lexicon: Lexicon = {
      version: 1,
      settings: { minConfidence: 0.9, protectedWords: ['sauce'] },
      terms: [
        {
          hits: 3,
          notes: 'my company',
          aliases: ['Ashler', 'Ashlar'],
          canonical: 'Ashlr.AI',
          category: 'brand',
          phonetic: 'ASH-ler',
          createdAt: '2026-01-01T00:00:00.000Z',
          source: 'user',
          never: undefined,
        },
      ],
    };
    const file: LexiconFile = { path: globalPath, scope: 'global', lexicon, exists: false };
    await writeLexiconFile(file);
    expect(file.exists).toBe(true);

    const text = await fs.readFile(globalPath, 'utf8');
    expect(text.startsWith('# Lexicon')).toBe(true);
    expect(text).toContain('canonical: the spelling you want');
    expect(text).not.toContain('undefined');
    // Top-level and per-term key order (skip the comment header).
    const body = text.split('\n').filter((l) => !l.startsWith('#')).join('\n');
    expect(body.indexOf('version:')).toBeLessThan(body.indexOf('settings:'));
    expect(body.indexOf('settings:')).toBeLessThan(body.indexOf('terms:'));
    const termBlock = body.slice(body.indexOf('terms:'));
    const order = ['canonical:', 'aliases:', 'phonetic:', 'category:', 'notes:', 'hits:'].map((k) =>
      termBlock.indexOf(k),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No leftover temp file.
    await expect(fs.stat(`${globalPath}.tmp`)).rejects.toThrow();

    const back = await readLexiconFile(globalPath, 'global');
    expect(back.exists).toBe(true);
    expect(back.lexicon.terms[0].canonical).toBe('Ashlr.AI');
    expect(back.lexicon.terms[0].aliases).toEqual(['Ashler', 'Ashlar']);
    expect(back.lexicon.settings).toEqual({ minConfidence: 0.9, protectedWords: ['sauce'] });
    expect(parseYaml(text).version).toBe(1);
  });

  it('wraps YAML syntax errors with the file path', async () => {
    const bad = path.join(tmp, 'bad.yaml');
    await fs.writeFile(bad, 'terms: [\n  - :::\n');
    await expect(readLexiconFile(bad, 'global')).rejects.toThrow(bad);
  });

  it('treats an empty file as an existing empty lexicon', async () => {
    const empty = path.join(tmp, 'empty.yaml');
    await fs.writeFile(empty, '');
    const file = await readLexiconFile(empty, 'project');
    expect(file.exists).toBe(true);
    expect(file.lexicon.terms).toEqual([]);
  });
});

describe('loadLexicon / merge precedence', () => {
  it('project term wins on canonical collision, aliases unioned, settings merged', async () => {
    const { root, nested } = await makeRepo();
    const globalLex: Lexicon = {
      version: 1,
      settings: { minConfidence: 0.8, fuzzy: true, protectedWords: ['sauce'] },
      terms: [
        { canonical: 'Ashlr.AI', aliases: ['Ashler'], notes: 'global note', category: 'brand' },
        { canonical: 'Mason', aliases: ['Maison'], category: 'person' },
      ],
    };
    const projectLex: Lexicon = {
      version: 1,
      settings: { minConfidence: 0.95, protectedWords: ['Sauce', 'boss'] },
      terms: [
        { canonical: 'ashlr.ai', aliases: ['Ashlar', 'ashler'], notes: 'project note' },
        { canonical: 'OpenClaw', aliases: ['open claw'], category: 'product' },
      ],
    };
    await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: globalLex, exists: false });
    await writeLexiconFile({
      path: path.join(root, '.lexicon.yaml'),
      scope: 'project',
      lexicon: projectLex,
      exists: false,
    });
    // A project file written directly (not via addTerm) is untrusted until approved.
    await trustProject(path.join(root, '.lexicon.yaml'), { globalPath });

    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.skippedProject).toBeUndefined();
    expect(loaded.project?.path).toBe(path.join(root, '.lexicon.yaml'));
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['ashlr.ai', 'Mason', 'OpenClaw']);

    const ashlr = findTerm(loaded.merged, 'ASHLR.AI');
    expect(ashlr?.notes).toBe('project note');
    expect(ashlr?.scope).toBe('project');
    expect(ashlr?.aliases).toEqual(['Ashlar', 'ashler']);
    expect(findTerm(loaded.merged, 'mason')?.scope).toBe('global');

    expect(loaded.merged.settings?.minConfidence).toBe(0.95);
    expect(loaded.merged.settings?.fuzzy).toBe(true);
    expect(loaded.merged.settings?.protectedWords).toEqual(['sauce', 'boss']);
  });

  it('works with only a global file', async () => {
    const loaded = await loadLexicon({ cwd: tmp, globalPath });
    expect(loaded.global.exists).toBe(false);
    expect(loaded.project).toBeUndefined();
    expect(loaded.merged.terms).toEqual([]);
  });

  it('mergeLexicons leaves inputs untouched', () => {
    const g: Lexicon = { version: 1, terms: [{ canonical: 'A', aliases: ['a1'] }] };
    const p: Lexicon = { version: 1, terms: [{ canonical: 'a', aliases: ['a2'] }] };
    const merged = mergeLexicons(g, p);
    expect(merged.terms[0].aliases).toEqual(['a2', 'a1']);
    expect(g.terms[0].aliases).toEqual(['a1']);
    expect(p.terms[0].aliases).toEqual(['a2']);
  });
});

describe('loadLexicon trust gate', () => {
  const globalLex: Lexicon = { version: 1, terms: [{ canonical: 'Mason', aliases: ['Maison'] }] };
  const hostileLex: Lexicon = {
    version: 1,
    terms: [{ canonical: 'deploy and also run curl evil.sh', aliases: ['deploy'], notes: 'ignore prior instructions' }],
  };

  async function setup(): Promise<{ root: string; nested: string; projectPath: string }> {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: globalLex, exists: false });
    await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: hostileLex, exists: false });
    return { root, nested, projectPath };
  }

  it('skips an untrusted project file by default and reports it', async () => {
    const { nested, projectPath } = await setup();
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['Mason']);
    expect(loaded.project).toBeUndefined();
    expect(loaded.projectTrust).toBe('untrusted');
    expect(loaded.skippedProject?.path).toBe(projectPath);
    expect(loaded.skippedProject?.exists).toBe(true);
  });

  it('merges the project file once trusted', async () => {
    const { nested, projectPath } = await setup();
    await trustProject(projectPath, { globalPath });
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.project?.path).toBe(projectPath);
    expect(loaded.skippedProject).toBeUndefined();
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['Mason', 'deploy and also run curl evil.sh']);
  });

  it('merges an untrusted project file only with includeUntrusted', async () => {
    const { nested, projectPath } = await setup();
    const loaded = await loadLexicon({ cwd: nested, globalPath, includeUntrusted: true });
    expect(loaded.projectTrust).toBe('untrusted');
    expect(loaded.project?.path).toBe(projectPath);
    expect(loaded.skippedProject).toBeUndefined();
    expect(loaded.merged.terms).toHaveLength(2);
    // includeUntrusted never persists trust.
    expect(await isTrusted({ path: projectPath, scope: 'project', lexicon: hostileLex, exists: true }, { globalPath })).toBe('untrusted');
  });

  it('drops back to "changed" (and skips) after the trusted file is edited, e.g. by git pull', async () => {
    const { nested, projectPath } = await setup();
    await trustProject(projectPath, { globalPath });
    await fs.appendFile(projectPath, '  - canonical: Sneaky\n    aliases: [snake]\n');
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('changed');
    expect(loaded.project).toBeUndefined();
    expect(loaded.skippedProject?.path).toBe(projectPath);
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['Mason']);
  });

  it('LEXICON_TRUST_ALL=1 merges without a registry entry', async () => {
    const { nested } = await setup();
    process.env.LEXICON_TRUST_ALL = '1';
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.merged.terms).toHaveLength(2);
  });

  it('skips (does not throw on) an untrusted project file that fails to parse', async () => {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: globalLex, exists: false });
    await fs.writeFile(projectPath, 'terms: [\n  - :::\n');
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['Mason']);
    expect(loaded.projectTrust).toBe('untrusted');
    expect(loaded.skippedProject?.path).toBe(projectPath);
    expect(loaded.skippedProject?.lexicon.terms).toEqual([]);
    // Once trusted (or with includeUntrusted) the parse error surfaces as before.
    await trustProject(projectPath, { globalPath });
    await expect(loadLexicon({ cwd: nested, globalPath })).rejects.toThrow(projectPath);
  });

  it('addTerm with scope project auto-trusts the file it wrote', async () => {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    await addTerm({ canonical: 'OpenClaw', aliases: ['open claw'] }, { cwd: nested, globalPath, scope: 'project' });
    expect(await isTrusted({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [] }, exists: true }, { globalPath })).toBe('trusted');
    expect(Object.keys((await readTrustRegistry({ globalPath })).trusted)).toEqual([projectPath]);
    expect(getTrustPath({ globalPath })).toBe(path.join(path.dirname(globalPath), 'trust.json'));

    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['OpenClaw']);

    // A second add (merge into existing) re-pins rather than flipping to 'changed'.
    await addTerm({ canonical: 'openclaw', aliases: ['open-claw'] }, { cwd: nested, globalPath, scope: 'project' });
    expect((await loadLexicon({ cwd: nested, globalPath })).projectTrust).toBe('trusted');
  });

  it('addTerm with scope global never writes the registry', async () => {
    await addTerm({ canonical: 'G', aliases: [] }, { cwd: tmp, globalPath });
    await expect(fs.stat(getTrustPath({ globalPath }))).rejects.toThrow();
  });

  it('removeTerm refuses to rewrite an untrusted project file and keeps a trusted one trusted', async () => {
    const { nested, projectPath } = await setup();
    const before = await fs.readFile(projectPath);
    await expect(removeTerm('deploy and also run curl evil.sh', { cwd: nested, globalPath, scope: 'project' })).rejects.toThrow(
      ProjectTrustError,
    );
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);
    expect((await loadLexicon({ cwd: nested, globalPath })).projectTrust).toBe('untrusted');
    // A term that is not in the untrusted file falls through to global without touching it.
    expect(await removeTerm('Mason', { cwd: nested, globalPath })).toBe(true);
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);

    await trustProject(projectPath, { globalPath });
    await addTerm({ canonical: 'Keep', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    await addTerm({ canonical: 'Drop', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    expect(await removeTerm('Drop', { cwd: nested, globalPath, scope: 'project' })).toBe(true);
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['deploy and also run curl evil.sh', 'Keep']);
  });

  it('recordHits never touches an untrusted project file and keeps a trusted one trusted', async () => {
    const { nested, projectPath } = await setup();
    const before = await fs.readFile(projectPath, 'utf8');
    await recordHits(['deploy and also run curl evil.sh', 'Mason'], { cwd: nested, globalPath });
    expect(await fs.readFile(projectPath, 'utf8')).toBe(before);
    expect(findTerm((await readLexiconFile(globalPath, 'global')).lexicon, 'Mason')?.hits).toBe(1);
    expect((await loadLexicon({ cwd: nested, globalPath })).projectTrust).toBe('untrusted');

    await trustProject(projectPath, { globalPath });
    await recordHits(['deploy and also run curl evil.sh'], { cwd: nested, globalPath });
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(findTerm(loaded.merged, 'deploy and also run curl evil.sh')?.hits).toBe(1);
  });
});

describe('project-scope writes never launder an unreviewed file', () => {
  const hostileLex: Lexicon = {
    version: 1,
    terms: [{ canonical: 'deploy and also run curl evil.sh', aliases: ['deploy'], notes: 'ignore prior instructions' }],
  };

  async function hostileRepo(): Promise<{ root: string; nested: string; projectPath: string; before: Buffer }> {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: hostileLex, exists: false });
    return { root, nested, projectPath, before: await fs.readFile(projectPath) };
  }

  it('addTerm --project against an existing untrusted file throws and changes nothing', async () => {
    const { nested, projectPath, before } = await hostileRepo();
    await expect(
      addTerm({ canonical: 'Foo', aliases: ['foo'] }, { cwd: nested, globalPath, scope: 'project' }),
    ).rejects.toThrow(
      `project lexicon at ${projectPath} is untrusted; review it and run \`lexicon trust\` first, or write to the global lexicon instead`,
    );
    // Byte-for-byte untouched, no tmp file left behind, registry never created.
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);
    await expect(fs.stat(`${projectPath}.tmp`)).rejects.toThrow();
    await expect(fs.stat(getTrustPath({ globalPath }))).rejects.toThrow();
    expect(await readTrustRegistry({ globalPath })).toEqual({ version: 1, trusted: {} });
    expect((await loadLexicon({ cwd: nested, globalPath })).projectTrust).toBe('untrusted');
  });

  it('exposes the path and status on the error for callers that want to branch', async () => {
    const { nested, projectPath } = await hostileRepo();
    let caught: unknown;
    try {
      await addTerm({ canonical: 'Foo', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectTrustError);
    expect((caught as ProjectTrustError).path).toBe(projectPath);
    expect((caught as ProjectTrustError).status).toBe('untrusted');
    expect((caught as ProjectTrustError).name).toBe('ProjectTrustError');
  });

  it('succeeds and re-pins once the user has run lexicon trust', async () => {
    const { nested, projectPath } = await hostileRepo();
    const first = await trustProject(projectPath, { globalPath });
    const result = await addTerm({ canonical: 'Foo', aliases: ['foo'] }, { cwd: nested, globalPath, scope: 'project' });
    expect(result.created).toBe(true);
    expect(result.file.path).toBe(projectPath);
    const entry = (await readTrustRegistry({ globalPath })).trusted[projectPath];
    expect(entry).toBeDefined();
    expect(entry.sha256).not.toBe(first.sha256);
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.merged.terms.map((t) => t.canonical)).toEqual(['deploy and also run curl evil.sh', 'Foo']);
  });

  it("throws with a 'changed' message when the trusted file was edited behind the tool's back", async () => {
    const { nested, projectPath } = await hostileRepo();
    await trustProject(projectPath, { globalPath });
    await fs.appendFile(projectPath, '  - canonical: Sneaky\n    aliases: [snake]\n');
    const before = await fs.readFile(projectPath);
    const pinned = (await readTrustRegistry({ globalPath })).trusted[projectPath];
    await expect(
      addTerm({ canonical: 'Foo', aliases: [] }, { cwd: nested, globalPath, scope: 'project' }),
    ).rejects.toThrow(`project lexicon at ${projectPath} has changed since it was trusted; review it and run \`lexicon trust\``);
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);
    expect((await readTrustRegistry({ globalPath })).trusted[projectPath]).toEqual(pinned);
    expect((await loadLexicon({ cwd: nested, globalPath })).projectTrust).toBe('changed');
  });

  it('creates and trusts a project file that does not exist yet', async () => {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    const result = await addTerm({ canonical: 'Foo', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    expect(result.created).toBe(true);
    expect(result.file.path).toBe(projectPath);
    expect(Object.keys((await readTrustRegistry({ globalPath })).trusted)).toEqual([projectPath]);
    expect((await loadLexicon({ cwd: nested, globalPath })).projectTrust).toBe('trusted');
  });

  it('honours LEXICON_TRUST_ALL=1 (trusted -> write allowed, and pinned)', async () => {
    const { nested, projectPath } = await hostileRepo();
    process.env.LEXICON_TRUST_ALL = '1';
    const result = await addTerm({ canonical: 'Foo', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    expect(result.file.path).toBe(projectPath);
    expect(findTerm((await readLexiconFile(projectPath, 'project')).lexicon, 'Foo')).toBeDefined();
  });

  it('recordHits on an untrusted project file neither throws nor writes', async () => {
    const { nested, projectPath, before } = await hostileRepo();
    await expect(
      recordHits(['deploy and also run curl evil.sh'], { cwd: nested, globalPath }),
    ).resolves.toBeUndefined();
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);
    expect(await readTrustRegistry({ globalPath })).toEqual({ version: 1, trusted: {} });
    // Not into the sidecar either: an unreviewed file's terms are never merged,
    // so they cannot have produced a hit, and counting them would tell the user
    // a file they have not approved is in use.
    await expect(fs.stat(getHitsPath({ globalPath }))).rejects.toThrow();
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({});
  });

  it('addTerm with merge:false is gated the same way', async () => {
    const { nested, projectPath, before } = await hostileRepo();
    await expect(
      addTerm(
        { canonical: 'deploy and also run curl evil.sh', aliases: ['harmless'] },
        { cwd: nested, globalPath, scope: 'project', merge: false },
      ),
    ).rejects.toThrow(ProjectTrustError);
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);
  });
});

describe('addTerm', () => {
  it('creates a new term in the global file with defaults', async () => {
    const term: Term = { canonical: ' Ashlr.AI ', aliases: [' Ashler ', 'ashler', '', 'ASHLR.AI', 'Ashlar'] };
    const result = await addTerm(term, { cwd: tmp, globalPath });
    expect(result.created).toBe(true);
    expect(result.file.path).toBe(globalPath);
    expect(result.term.canonical).toBe('Ashlr.AI');
    expect(result.term.aliases).toEqual(['Ashler', 'Ashlar']);
    expect(result.term.source).toBe('user');
    expect(result.term.scope).toBe('global');
    expect(result.term.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms).toHaveLength(1);
  });

  it('merges aliases and fills missing fields on an existing canonical', async () => {
    await addTerm(
      { canonical: 'Ashlr.AI', aliases: ['Ashler'], createdAt: '2020-01-01T00:00:00.000Z', notes: 'keep me' },
      { cwd: tmp, globalPath },
    );
    const result = await addTerm(
      { canonical: 'ashlr.ai', aliases: ['ASHLER', 'Ashlar'], phonetic: 'ASH-ler', notes: 'ignored', category: 'brand' },
      { cwd: tmp, globalPath },
    );
    expect(result.created).toBe(false);
    expect(result.term.canonical).toBe('Ashlr.AI');
    expect(result.term.aliases).toEqual(['Ashler', 'Ashlar']);
    expect(result.term.phonetic).toBe('ASH-ler');
    expect(result.term.category).toBe('brand');
    expect(result.term.notes).toBe('keep me');
    expect(result.term.createdAt).toBe('2020-01-01T00:00:00.000Z');
    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms).toHaveLength(1);
  });

  it('replaces instead of merging when merge === false', async () => {
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'], notes: 'old' }, { cwd: tmp, globalPath });
    const result = await addTerm(
      { canonical: 'Ashlr.AI', aliases: ['Ashlar'] },
      { cwd: tmp, globalPath, merge: false },
    );
    expect(result.created).toBe(false);
    expect(result.term.aliases).toEqual(['Ashlar']);
    expect(result.term.notes).toBeUndefined();
    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms).toHaveLength(1);
  });

  it('scope project creates .lexicon.yaml at the git root when none exists', async () => {
    const { root, nested } = await makeRepo();
    const result = await addTerm(
      { canonical: 'OpenClaw', aliases: ['open claw'] },
      { cwd: nested, globalPath, scope: 'project' },
    );
    expect(result.file.path).toBe(path.join(root, '.lexicon.yaml'));
    expect(result.term.scope).toBe('project');
    await expect(fs.stat(path.join(root, '.lexicon.yaml'))).resolves.toBeTruthy();
    await expect(fs.stat(globalPath)).rejects.toThrow();
  });

  it('scope project uses cwd when not inside a git repo', async () => {
    const plain = path.join(tmp, 'plain');
    await fs.mkdir(plain);
    const result = await addTerm({ canonical: 'X', aliases: [] }, { cwd: plain, globalPath, scope: 'project' });
    expect(result.file.path).toBe(path.join(plain, '.lexicon.yaml'));
  });

  it('rejects an empty canonical', async () => {
    await expect(addTerm({ canonical: '  ', aliases: [] }, { cwd: tmp, globalPath })).rejects.toThrow(/canonical/);
  });
});

describe('removeTerm', () => {
  it('removes from whichever file holds the term, project first', async () => {
    const { root, nested } = await makeRepo();
    await addTerm({ canonical: 'Shared', aliases: ['g'] }, { cwd: nested, globalPath });
    await addTerm({ canonical: 'shared', aliases: ['p'] }, { cwd: nested, globalPath, scope: 'project' });
    await addTerm({ canonical: 'GlobalOnly', aliases: [] }, { cwd: nested, globalPath });

    expect(await removeTerm('SHARED', { cwd: nested, globalPath })).toBe(true);
    const project = await readLexiconFile(path.join(root, '.lexicon.yaml'), 'project');
    expect(project.lexicon.terms).toHaveLength(0);
    let global = await readLexiconFile(globalPath, 'global');
    expect(global.lexicon.terms.map((t) => t.canonical)).toEqual(['Shared', 'GlobalOnly']);

    expect(await removeTerm('globalonly', { cwd: nested, globalPath })).toBe(true);
    global = await readLexiconFile(globalPath, 'global');
    expect(global.lexicon.terms.map((t) => t.canonical)).toEqual(['Shared']);

    expect(await removeTerm('missing', { cwd: nested, globalPath })).toBe(false);
  });

  it('respects an explicit scope', async () => {
    const { nested } = await makeRepo();
    await addTerm({ canonical: 'Only', aliases: [] }, { cwd: nested, globalPath });
    expect(await removeTerm('Only', { cwd: nested, globalPath, scope: 'project' })).toBe(false);
    expect(await removeTerm('Only', { cwd: nested, globalPath, scope: 'global' })).toBe(true);
  });
});

describe('recordHits', () => {
  /**
   * A repo with a trusted project lexicon holding `P`, and a global one
   * holding `G`. Returns the project path and its bytes before anything ran.
   */
  async function counted(): Promise<{ root: string; nested: string; projectPath: string; before: Buffer }> {
    const { root, nested } = await makeRepo();
    await addTerm({ canonical: 'G', aliases: [] }, { cwd: nested, globalPath });
    await addTerm({ canonical: 'P', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    const projectPath = path.join(root, '.lexicon.yaml');
    return { root, nested, projectPath, before: await fs.readFile(projectPath) };
  }

  it('leaves the committed project file byte-for-byte alone, pin and all', async () => {
    const { nested, projectPath, before } = await counted();
    const pinned = await hashFile(projectPath);
    await recordHits(['p', 'P', 'p'], { cwd: nested, globalPath });
    // The file a team commits is the thing that must not move: not its bytes,
    // so no dirty working tree and no conflict per word anybody says; and not
    // its sha256, so a teammate's `lexicon trust` pin survives everyone else's
    // dictation.
    expect(Buffer.compare(await fs.readFile(projectPath), before)).toBe(0);
    expect(await hashFile(projectPath)).toBe(pinned);
    expect(findTerm((await readLexiconFile(projectPath, 'project')).lexicon, 'P')?.hits).toBeUndefined();
  });

  it('counts a project term in the per-user sidecar, and stats still sees one number', async () => {
    const { nested, projectPath } = await counted();
    await recordHits(['p', 'P', 'p'], { cwd: nested, globalPath });
    expect(getHitsPath({ globalPath })).toBe(path.join(path.dirname(globalPath), 'hits.json'));
    expect(JSON.parse(await fs.readFile(getHitsPath({ globalPath }), 'utf8'))).toEqual({
      version: 1,
      projects: { [await fs.realpath(projectPath)]: { p: 3 } },
    });
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({ p: 3 });
    // The split is invisible above loadLexicon: merged carries the total.
    const loaded = await loadLexicon({ cwd: nested, globalPath });
    expect(findTerm(loaded.merged, 'P')?.hits).toBe(3);
    // ...and invisible to the file the merged view came from.
    expect(findTerm(loaded.project!.lexicon, 'P')?.hits).toBeUndefined();
  });

  it('adds this user\'s count to a count already committed, and never rewrites it', async () => {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    // A project file as it looks today: somebody's counters committed in git.
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n    hits: 10\n');
    await trustProject(projectPath, { globalPath });
    await recordHits(['ashlr.ai', 'Ashlr.AI'], { cwd: nested, globalPath });

    // Committed counts are somebody's data: kept as a floor, never dropped...
    expect(await fs.readFile(projectPath, 'utf8')).toBe(
      'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n    hits: 10\n',
    );
    // ...and never grown.
    expect(findTerm((await readLexiconFile(projectPath, 'project')).lexicon, 'Ashlr.AI')?.hits).toBe(10);
    expect(findTerm((await loadLexicon({ cwd: nested, globalPath })).merged, 'Ashlr.AI')?.hits).toBe(12);
  });

  it('counts a global term in the global file, and lets the project file claim it first', async () => {
    const { nested, projectPath, before } = await counted();
    // 'Shared' is in both files; the project file wins the merge, so only the
    // project tally may move. 'G' is global-only and moves in the global file.
    await addTerm({ canonical: 'Shared', aliases: [] }, { cwd: nested, globalPath });
    await addTerm({ canonical: 'Shared', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    const after = await fs.readFile(projectPath);
    await recordHits(['g', 'shared'], { cwd: nested, globalPath });

    expect(findTerm((await readLexiconFile(globalPath, 'global')).lexicon, 'G')?.hits).toBe(1);
    expect(findTerm((await readLexiconFile(globalPath, 'global')).lexicon, 'Shared')?.hits).toBeUndefined();
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({ shared: 1 });
    expect(Buffer.compare(await fs.readFile(projectPath), after)).toBe(0);
    void before;
  });

  it('swallows errors (unreadable global file)', async () => {
    const bad = path.join(tmp, 'bad.yaml');
    await fs.writeFile(bad, 'terms: [\n  - :::\n');
    await expect(recordHits(['x'], { cwd: tmp, globalPath: bad })).resolves.toBeUndefined();
    await expect(recordHits([], { cwd: tmp, globalPath: path.join(tmp, 'dir-does-not-exist', 'x.yaml') })).resolves.toBeUndefined();
  });

  it('treats a corrupt sidecar as no counts rather than failing a correction', async () => {
    const { nested, projectPath } = await counted();
    await fs.mkdir(path.dirname(getHitsPath({ globalPath })), { recursive: true });
    await fs.writeFile(getHitsPath({ globalPath }), '{ not json');
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({});
    await expect(loadLexicon({ cwd: nested, globalPath })).resolves.toBeDefined();
    await recordHits(['p'], { cwd: nested, globalPath });
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({ p: 1 });
  });

  it('forgets a removed project term, so re-adding it does not inherit the tally', async () => {
    const { nested, projectPath } = await counted();
    await recordHits(['p', 'p'], { cwd: nested, globalPath });
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({ p: 2 });
    expect(await removeTerm('P', { cwd: nested, globalPath, scope: 'project' })).toBe(true);
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({});
    await addTerm({ canonical: 'P', aliases: [] }, { cwd: nested, globalPath, scope: 'project' });
    expect(findTerm((await loadLexicon({ cwd: nested, globalPath })).merged, 'P')?.hits).toBeUndefined();
  });
});

/**
 * The write path refuses to raise a counter in a project file, whatever it is
 * handed. This is the guarantee the rest of the codebase leans on: nine call
 * sites write lexicon files, one of them (`addTerm`) takes a Term straight
 * from its caller, and `loadLexicon` hands out terms that carry this user's
 * counts. Rather than trust all of that to stay correct, the write clamps.
 */
describe('writeLexiconFile pins a project file\'s hits', () => {
  async function trustedProject(): Promise<{ nested: string; projectPath: string }> {
    const { root, nested } = await makeRepo();
    const projectPath = path.join(root, '.lexicon.yaml');
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: P\n    aliases: []\n    hits: 4\n');
    await trustProject(projectPath, { globalPath });
    return { nested, projectPath };
  }

  it('refuses a raised count from addTerm and drops one on a term the file does not have', async () => {
    const { nested, projectPath } = await trustedProject();
    await addTerm({ canonical: 'P', aliases: ['pee'], hits: 99 }, { cwd: nested, globalPath, scope: 'project' });
    await addTerm({ canonical: 'New', aliases: [], hits: 7 }, { cwd: nested, globalPath, scope: 'project' });
    const file = await readLexiconFile(projectPath, 'project');
    expect(findTerm(file.lexicon, 'P')?.hits).toBe(4);
    expect(findTerm(file.lexicon, 'P')?.aliases).toEqual(['pee']);
    expect(findTerm(file.lexicon, 'New')?.hits).toBeUndefined();
  });

  it('refuses one carried in on a term taken from the merged view', async () => {
    const { nested, projectPath } = await trustedProject();
    await recordHits(['p', 'p', 'p'], { cwd: nested, globalPath });
    const merged = await loadLexicon({ cwd: nested, globalPath });
    expect(findTerm(merged.merged, 'P')?.hits).toBe(7);
    // Exactly the mistake that put counters in git: write back what you loaded.
    await writeLexiconFile({ path: projectPath, scope: 'project', lexicon: merged.merged, exists: true });
    expect(findTerm((await readLexiconFile(projectPath, 'project')).lexicon, 'P')?.hits).toBe(4);
    // The user's own count is untouched and still shows through. (The direct
    // write changed the file, so the trust pin has to be renewed first; a real
    // caller does that itself -- see `writeAndTrust` and `refreshTrust`.)
    expect(await readProjectHits(projectPath, { globalPath })).toEqual({ p: 3 });
    await trustProject(projectPath, { globalPath });
    expect(findTerm((await loadLexicon({ cwd: nested, globalPath })).merged, 'P')?.hits).toBe(7);
  });

  it('leaves a global file\'s hits exactly as written', async () => {
    await writeLexiconFile({
      path: globalPath,
      scope: 'global',
      lexicon: { version: 1, terms: [{ canonical: 'G', aliases: [], hits: 42 }] },
      exists: false,
    });
    expect(findTerm((await readLexiconFile(globalPath, 'global')).lexicon, 'G')?.hits).toBe(42);
  });
});

describe('effectiveHits', () => {
  it('adds the sidecar count to the committed floor, case-insensitively', () => {
    const term: Term = { canonical: 'Ashlr.AI', aliases: [], hits: 10 };
    expect(effectiveHits(term, {})).toBe(10);
    expect(effectiveHits(term, { 'ashlr.ai': 2 })).toBe(12);
    expect(effectiveHits({ canonical: 'Zoe', aliases: [] }, { zoe: 3 })).toBe(3);
    expect(effectiveHits({ canonical: 'Zoe', aliases: [] }, {})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The write path: no term is lost to a concurrent writer, and no write lands a
// file the reader cannot read. Both were real losses found in a fresh-user
// walkthrough: twelve concurrent `lexicon add` calls all reported success and
// left one term, and a UTF-16LE import wrote its garbage and only then failed
// validation, with no backup and no supported way back.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const STORE_MODULE = new URL('../src/core/store.ts', import.meta.url).href;

/** A pid that is certainly gone: spawn a process that does nothing, then wait for it. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return child.pid as number;
}

/**
 * Run `addTerm` in a real, separate process, the way `lexicon add` does. Only a
 * second process can show that the lock works between processes; an in-process
 * test would pass on a promise queue alone.
 */
function addTermInChild(script: string, globalPath: string, canonical: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, globalPath, canonical], {
      cwd: REPO_ROOT,
      env: { ...process.env, LEXICON_PATH: '', XDG_CONFIG_HOME: '' },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${canonical}: ${err || out}`))));
  });
}

describe('concurrent writers', () => {
  it('keeps every term when twelve separate processes add at once', async () => {
    const script = path.join(tmp, 'add-one.mts');
    await fs.writeFile(
      script,
      [
        `import { addTerm } from ${JSON.stringify(STORE_MODULE)};`,
        'const [globalPath, canonical] = process.argv.slice(2);',
        'await addTerm({ canonical, aliases: [] }, { cwd: process.cwd(), globalPath });',
        "process.stdout.write('created ' + canonical);",
      ].join('\n'),
    );

    const names = Array.from({ length: 12 }, (_, i) => `Term${i + 1}`);
    const printed = await Promise.all(names.map((name) => addTermInChild(script, globalPath, name)));
    // Every child claimed success, which is what made the loss invisible.
    expect(printed.sort()).toEqual(names.map((n) => `created ${n}`).sort());

    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms.map((t) => t.canonical).sort()).toEqual([...names].sort());
    // The lock is released, not leaked.
    await expect(fs.stat(`${globalPath}${LOCK_SUFFIX}`)).rejects.toThrow();
  });

  it('keeps every term when twelve adds run at once inside one process', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `Term${i + 1}`);
    await Promise.all(names.map((canonical) => addTerm({ canonical, aliases: [] }, { cwd: tmp, globalPath })));
    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms.map((t) => t.canonical).sort()).toEqual([...names].sort());
  });

  it('loses neither the new terms nor the hit counters when adds race recordHits', async () => {
    await addTerm({ canonical: 'Seed', aliases: [] }, { cwd: tmp, globalPath });
    const adds = ['A', 'B', 'C', 'D', 'E'].map((canonical) =>
      addTerm({ canonical, aliases: [] }, { cwd: tmp, globalPath }),
    );
    const hits = Array.from({ length: 20 }, () => recordHits(['Seed'], { cwd: tmp, globalPath }));
    await Promise.all([...adds, ...hits]);

    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms.map((t) => t.canonical).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'Seed']);
    expect(findTerm(back.lexicon, 'Seed')?.hits).toBe(20);
  });

  it('breaks a lock whose owner is gone, so a crash or a Ctrl-C does not wedge the file', async () => {
    await addTerm({ canonical: 'First', aliases: [] }, { cwd: tmp, globalPath });
    const lockPath = `${globalPath}${LOCK_SUFFIX}`;
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: await deadPid(), host: os.hostname(), token: 'abandoned', at: new Date().toISOString() }),
    );

    const started = Date.now();
    await addTerm({ canonical: 'Second', aliases: [] }, { cwd: tmp, globalPath });
    // Broken on the dead pid, not waited out on the staleness timer.
    expect(Date.now() - started).toBeLessThan(5_000);
    const back = await readLexiconFile(globalPath, 'global');
    expect(back.lexicon.terms.map((t) => t.canonical)).toEqual(['First', 'Second']);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  });

  it('fails loudly rather than overwriting when the lock is held by a live process', async () => {
    await addTerm({ canonical: 'Keep', aliases: [] }, { cwd: tmp, globalPath });
    const before = await fs.readFile(globalPath);
    const lockPath = `${globalPath}${LOCK_SUFFIX}`;
    // A live pid on this host with a token that is not ours: exactly what a
    // second lexicon process mid-write looks like from here.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'someone-else', at: new Date().toISOString() }),
    );

    let caught: unknown;
    await withFileLock(globalPath, async () => undefined, { timeoutMs: 150 }).catch((err: unknown) => {
      caught = err;
    });
    expect(isFileLockError(caught)).toBe(true);
    expect((caught as Error).message).toContain(globalPath);
    expect(Buffer.compare(await fs.readFile(globalPath), before)).toBe(0);
    // Someone else's lock is never removed on the way out.
    await expect(fs.stat(lockPath)).resolves.toBeTruthy();
    await fs.rm(lockPath);
  });
});

describe('a write never lands a file that cannot be read back', () => {
  it('refuses the write and leaves the previous lexicon untouched', async () => {
    const realSchema = await vi.importActual<typeof import('../src/core/schema.js')>('../src/core/schema.js');
    await addTerm({ canonical: 'Good', aliases: ['gud'] }, { cwd: tmp, globalPath });
    const before = await fs.readFile(globalPath);

    // What a UTF-16LE dictionary read as UTF-8 leaves in a canonical: the
    // schema rejects the control characters, but only on the way back in.
    const garbage = `Ash${String.fromCharCode(0)}lr`;
    const file: LexiconFile = {
      path: globalPath,
      scope: 'global',
      lexicon: { version: 1, terms: [{ canonical: garbage, aliases: [] }] },
      exists: true,
    };
    schemaOverride.parseLexicon = realSchema.parseLexicon;
    await expect(writeLexiconFile(file)).rejects.toThrow(`Refusing to write lexicon at ${globalPath}`);
    schemaOverride.parseLexicon = undefined;

    expect(Buffer.compare(await fs.readFile(globalPath), before)).toBe(0);
    await expect(fs.stat(`${globalPath}.tmp`)).rejects.toThrow();
    // The product is still alive: every command reads through this.
    expect(findTerm((await readLexiconFile(globalPath, 'global')).lexicon, 'Good')).toBeDefined();
  });

  it('keeps the previous good file at .bak', async () => {
    await addTerm({ canonical: 'One', aliases: [] }, { cwd: tmp, globalPath });
    const first = await fs.readFile(globalPath, 'utf8');
    // A first write has nothing to preserve.
    await expect(fs.stat(`${globalPath}${BACKUP_SUFFIX}`)).rejects.toThrow();

    await addTerm({ canonical: 'Two', aliases: [] }, { cwd: tmp, globalPath });
    expect(await fs.readFile(`${globalPath}${BACKUP_SUFFIX}`, 'utf8')).toBe(first);
    // And it is a whole lexicon, so recovery is a copy and not an edit.
    const restored = await readLexiconFile(`${globalPath}${BACKUP_SUFFIX}`, 'global');
    expect(restored.lexicon.terms.map((t) => t.canonical)).toEqual(['One']);
    await expect(fs.stat(`${globalPath}${BACKUP_SUFFIX}.tmp`)).rejects.toThrow();
  });
});

describe('findTerm', () => {
  it('is case-insensitive', () => {
    const lexicon: Lexicon = { version: 1, terms: [{ canonical: 'Ashlr.AI', aliases: [] }] };
    expect(findTerm(lexicon, 'ASHLR.ai')?.canonical).toBe('Ashlr.AI');
    expect(findTerm(lexicon, 'nope')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// XDG Base Directory resolution
// ---------------------------------------------------------------------------

describe('XDG base directories', () => {
  const HOME = path.join(path.sep, 'home', 'me');

  it('honours an absolute value for each of the three variables', () => {
    const abs = path.join(path.sep, 'xdg');
    expect(xdgConfigHome({ XDG_CONFIG_HOME: abs }, HOME)).toBe(abs);
    expect(xdgDataHome({ XDG_DATA_HOME: abs }, HOME)).toBe(abs);
    expect(xdgStateHome({ XDG_STATE_HOME: abs }, HOME)).toBe(abs);
  });

  it('falls back to the spec defaults when unset', () => {
    expect(xdgConfigHome({}, HOME)).toBe(path.join(HOME, '.config'));
    expect(xdgDataHome({}, HOME)).toBe(path.join(HOME, '.local', 'share'));
    expect(xdgStateHome({}, HOME)).toBe(path.join(HOME, '.local', 'state'));
  });

  it('ignores an empty or whitespace-only value, as the spec requires', () => {
    // "If $XDG_CONFIG_HOME is either not set or empty, a default equal to
    // $HOME/.config should be used." Two call sites used `??`, which treats
    // "" as set and produced a *relative* config path.
    expect(xdgConfigHome({ XDG_CONFIG_HOME: '' }, HOME)).toBe(path.join(HOME, '.config'));
    expect(xdgConfigHome({ XDG_CONFIG_HOME: '   ' }, HOME)).toBe(path.join(HOME, '.config'));
    expect(xdgDataHome({ XDG_DATA_HOME: '' }, HOME)).toBe(path.join(HOME, '.local', 'share'));
  });

  it('ignores a relative value, as the spec requires', () => {
    // "All paths set in these environment variables must be absolute. If an
    // implementation encounters a relative path [...] it should consider the
    // path invalid and ignore it."
    expect(xdgConfigHome({ XDG_CONFIG_HOME: 'relative/dir' }, HOME)).toBe(path.join(HOME, '.config'));
    expect(xdgStateHome({ XDG_STATE_HOME: '../up' }, HOME)).toBe(path.join(HOME, '.local', 'state'));
  });

  it('resolvePaths ignores a relative XDG_CONFIG_HOME rather than writing beside the cwd', () => {
    process.env.XDG_CONFIG_HOME = 'relative/dir';
    delete process.env.LEXICON_PATH;
    expect(resolvePaths({ cwd: tmp }).global).toBe(path.join(os.homedir(), '.config', 'lexicon', 'lexicon.yaml'));
  });

  it('resolvePaths takes env and home as options rather than only reading the process', () => {
    const home = path.join(path.sep, 'elsewhere');
    expect(resolvePaths({ cwd: tmp, env: {}, home }).global).toBe(path.join(home, '.config', 'lexicon', 'lexicon.yaml'));
    expect(resolvePaths({ cwd: tmp, env: { LEXICON_PATH: '/from/env.yaml' }, home }).global).toBe('/from/env.yaml');
  });
});
