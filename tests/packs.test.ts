/**
 * Starter packs: the shipped YAML files parse and stay free of ordinary words,
 * and installPack / uninstallPack keep their promises against a temp lexicon
 * (merge without clobbering, idempotence, keep what the user edited, the
 * project trust gate). The CLI handlers run against the same temp files.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pass-through wrappers that count YAML parses, so the install-cost test can
 * check that a pack is installed with a bounded number of reads and writes
 * rather than one read-parse-write per term. Behaviour is unchanged.
 */
const yamlParses = vi.hoisted(() => ({ count: 0 }));
vi.mock('yaml', async (importOriginal) => {
  const real = await importOriginal<typeof import('yaml')>();
  return {
    ...real,
    parse: (...args: Parameters<typeof real.parse>) => {
      yamlParses.count += 1;
      return real.parse(...args);
    },
    parseDocument: (...args: Parameters<typeof real.parseDocument>) => {
      yamlParses.count += 1;
      return real.parseDocument(...args);
    },
  };
});
import {
  DEFAULT_PACKS,
  PACK_NAME_RE,
  PackNotFoundError,
  addTerm,
  findPackageRoot,
  installPack,
  installedPacks,
  listPacks,
  loadLexicon,
  loadPack,
  loadPackFile,
  normalize,
  packsDir,
  parseLexicon,
  parsePackText,
  findTerm,
  readGlobalHits,
  readLexiconFile,
  recordHits,
  isTrusted,
  trustProject,
  uninstallPack,
} from '../src/core/index.js';
import { STOPLIST } from '../src/core/stoplist.js';
import { registerPackCommands, runPackAdd, runPackList, runPackRemove, runPackShow } from '../src/cli/cmd-pack.js';
import { Command } from 'commander';
import { makeIO } from './helpers.js';

const PACK_NAMES = ['ai', 'business', 'cloud-devops', 'developer', 'profession-q8', 'voice-tools'];

/** Minimum sizes the packs promise (docs/PACKS.md). */
const MIN_TERMS: Record<string, number> = { developer: 50, 'cloud-devops': 20, ai: 30, business: 30, 'voice-tools': 12, 'profession-q8': 25 };

/**
 * Aliases that ARE an ordinary word, on purpose. Each entry is a real STT
 * spelling worth more than the prose it could hit, and the pack protects the
 * obvious collision with `never`. Anything else on the stoplist fails the test.
 */
const STOPLIST_ALIAS_ALLOWLIST: Record<string, string[]> = {
  SaaS: ['sass'],
};

/**
 * Multi-word aliases made only of stoplist words. Every one is a split STT
 * really produces ("Cloud floor" for Cloudflare, "super base" for Supabase)
 * and reads as nothing in prose; a new one has to be added here, deliberately.
 */
const STOPLIST_PHRASE_ALLOWLIST: Record<string, string[]> = {
  OpenAI: ['open a i', 'open eye'],
  'Claude Code': ['cloud code'],
  DeepSeek: ['deep seek'],
  QuickBooks: ['quick books'],
  Webflow: ['web flow'],
  Squarespace: ['square space'],
  DigitalOcean: ['digital ocean'],
  Cloudflare: ['cloud floor'],
  Supabase: ['super base'],
  Neon: ['knee on'],
  OAuth: ['oh auth', 'oh off'],
  TypeScript: ['type script'],
  Playwright: ['play write'],
  Datadog: ['data dog'],
  Auth0: ['auth zero', 'off zero'],
  Fireflies: ['fire flies'],
  OpenRouter: ['open router'],
  CrewAI: ['crew a i'],
  ClickHouse: ['click house'],
  Elasticsearch: ['elastic search'],
  PlanetScale: ['planet scale'],
  Mixpanel: ['mix panel'],
  '1Password': ['one password'],
};


// ---------------------------------------------------------------------------
// The shipped packs
// ---------------------------------------------------------------------------

describe('shipped packs', () => {
  it('offers legal vocabulary only by opt-in and preserves exact ambiguous words', async () => {
    const pack = await loadPack('profession-q8');
    expect(DEFAULT_PACKS).not.toContain(pack.name);
    expect(pack.terms).toBe(25);
    expect(pack.lexicon.terms.find((term) => term.canonical === 'subpoena')?.aliases).toContain('sub poena');
    expect(normalize('file sub poena and habeus corpus through lexis nexis', pack.lexicon).output)
      .toBe('file subpoena and habeas corpus through LexisNexis');
    const exclusions = {
      tort: ['taught', 'taut', 'tart'],
      lien: ['lean', 'line', 'lion'],
      counsel: ['council', 'councils'],
      writ: ['write', 'right', 'rite'],
      PACER: ['pacer'],
      HIPAA: ['hippo'],
      FOIA: ['foyer'],
      LexisNexis: ['lexis', 'nexus'],
    };
    for (const [canonical, words] of Object.entries(exclusions)) {
      const term = pack.lexicon.terms.find((entry) => entry.canonical === canonical);
      expect(term?.never).toEqual(words);
      for (const word of words) {
        expect(term?.aliases).not.toContain(word);
        const result = normalize(word, pack.lexicon);
        expect(result.output).toBe(word);
        expect(result.replacements).toEqual([]);
      }
    }
    const prose = 'the council taught us to write a line in the foyer';
    expect(normalize(prose, pack.lexicon).output).toBe(prose);
  });

  it('installs cloud/DevOps vocabulary and corrects a deployment sentence without changing prose', async () => {
    const pack = await loadPack('cloud-devops');
    expect(pack.terms).toBe(20);
    expect(pack.lexicon.terms.find((term) => term.canonical === 'kubectl')?.aliases).toContain('kube control');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-devops-'));
    try {
      const opts = { globalPath: path.join(dir, 'lexicon.yaml'), cwd: dir };
      expect((await installPack('cloud-devops', opts)).added).toBe(20);
      expect((await installPack('cloud-devops', opts)).alreadyInstalled).toBe(true);
      const { merged: lexicon } = await loadLexicon(opts);
      expect(normalize('deploy with kube control and argo c d using open tofu', lexicon).output)
        .toBe('deploy with kubectl and Argo CD using OpenTofu');
      const prose = 'take the helm and keep the cloud under control';
      expect(normalize(prose, lexicon).output).toBe(prose);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('protects ordinary vellum prose while correcting spelled-out vLLM', async () => {
    const pack = await loadPack('ai');
    const prose = 'print the invitation on vellum';
    expect(normalize(prose, pack.lexicon).output).toBe(prose);
    expect(normalize('serve this model with v l l m', pack.lexicon).output).toBe('serve this model with vLLM');
  });

  it('live in <package root>/packs and are all listed, sorted', async () => {
    const root = findPackageRoot();
    expect(root).toBeDefined();
    expect(packsDir()).toBe(path.join(root as string, 'packs'));
    const packs = await listPacks();
    expect(packs.map((p) => p.name)).toEqual(PACK_NAMES);
    for (const p of packs) {
      expect(p.version).toBe(1);
      expect(p.title.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
      expect(p.path).toBe(path.join(packsDir(), `${p.name}.yaml`));
      expect(p.terms).toBeGreaterThanOrEqual(MIN_TERMS[p.name]);
      expect(p.aliases).toBeGreaterThan(p.terms);
    }
    expect(DEFAULT_PACKS.every((name) => PACK_NAMES.includes(name))).toBe(true);
    expect(DEFAULT_PACKS).not.toContain('business');
  });

  it('parse with parseLexicon, name matches the file, every term has a category, no duplicates within or across packs', async () => {
    const seen = new Map<string, string>();
    for (const name of PACK_NAMES) {
      const pack = await loadPack(name);
      expect(pack.name).toBe(name);
      const raw = { version: 1, terms: pack.lexicon.terms };
      expect(() => parseLexicon(raw)).not.toThrow();
      for (const term of pack.lexicon.terms) {
        expect(term.category, `${name}: ${term.canonical} has no category`).toBeDefined();
        expect(term.source, `${name}: ${term.canonical} must not carry a source (installPack sets it)`).toBeUndefined();
        expect(term.scope).toBeUndefined();
        expect(term.hits).toBeUndefined();
        const key = term.canonical.toLowerCase();
        expect(seen.has(key), `${term.canonical} is in both ${seen.get(key)} and ${name}`).toBe(false);
        seen.set(key, name);
        const lowered = term.aliases.map((a) => a.toLowerCase());
        expect(new Set(lowered).size, `${name}: ${term.canonical} repeats an alias`).toBe(lowered.length);
        expect(lowered, `${name}: ${term.canonical} lists itself as an alias`).not.toContain(key);
        for (const alias of term.aliases) expect(alias).toBe(alias.trim());
        for (const word of term.never ?? []) {
          expect(lowered, `${name}: ${term.canonical} has "${word}" as both alias and never`).not.toContain(word.toLowerCase());
        }
      }
    }
  });

  it('never uses an ordinary English word as an alias except the documented allowlist', async () => {
    const offenders: string[] = [];
    const phrases: string[] = [];
    for (const name of PACK_NAMES) {
      const pack = await loadPack(name);
      for (const term of pack.lexicon.terms) {
        for (const alias of term.aliases) {
          const lower = alias.toLowerCase();
          if (STOPLIST.has(lower) && !STOPLIST_ALIAS_ALLOWLIST[term.canonical]?.includes(lower)) {
            offenders.push(`${name}: ${term.canonical}: "${alias}"`);
          }
          const words = lower.split(/\s+/);
          if (words.length > 1 && words.every((w) => STOPLIST.has(w)) && !STOPLIST_PHRASE_ALLOWLIST[term.canonical]?.includes(lower)) {
            phrases.push(`${name}: ${term.canonical}: "${alias}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(phrases).toEqual([]);
    // The allowlisted word carries its own guard.
    const business = await loadPack('business');
    expect(business.lexicon.terms.find((t) => t.canonical === 'SaaS')?.never).toContain('sauce');
  });

  it('holds the misspellings the real-audio benchmark recorded', async () => {
    const dev = await loadPack('developer');
    const ai = await loadPack('ai');
    const aliasesOf = (pack: typeof dev, canonical: string): string[] =>
      (pack.lexicon.terms.find((t) => t.canonical === canonical)?.aliases ?? []).map((a) => a.toLowerCase());
    expect(aliasesOf(dev, 'Kubernetes')).toEqual(expect.arrayContaining(['cuban eats', 'cuban needs', 'cuba needs']));
    expect(aliasesOf(dev, 'Supabase')).toContain('superbase');
    expect(aliasesOf(dev, 'Vercel')).toContain('versal');
    expect(aliasesOf(dev, 'Vercel')).not.toContain('vessel');
    expect(aliasesOf(dev, 'Kafka')).toContain('calf care');
    expect(aliasesOf(dev, 'Grafana')).toContain('gra fauna');
    expect(aliasesOf(dev, 'Nginx')).toContain('engine x');
    expect(aliasesOf(dev, 'JWT')).toEqual(expect.arrayContaining(['jot', 'j w t']));
    expect(aliasesOf(dev, 'OAuth')).toContain('oh auth');
    expect(aliasesOf(dev, 'tRPC')).toContain('t r p c');
    expect(aliasesOf(dev, 'YAML')).toContain('yammel');
    expect(aliasesOf(ai, 'Anthropic')).toContain('and tropic');
    expect(aliasesOf(ai, 'MCP')).toContain('em see pee');
    expect(aliasesOf(ai, 'Claude Code')).toContain('cloud code');
    expect(aliasesOf(ai, 'Claude')).not.toContain('cloud');
    expect(aliasesOf(ai, 'Codex')).toContain('code x');
    const voice = await loadPack('voice-tools');
    expect(aliasesOf(voice, 'Superwhisper')).toContain('super whisper');
    expect(aliasesOf(voice, 'Wispr Flow')).toContain('whisper flow');
  });

  it('corrects the demo sentence once the developer pack is the lexicon', async () => {
    const dev = await loadPack('developer');
    const result = normalize('deploy to cuban eats on versal with superbase', dev.lexicon);
    expect(result.output).toBe('deploy to Kubernetes on Vercel with Supabase');
    expect(result.replacements.map((r) => r.reason)).toEqual(['alias', 'alias', 'alias']);
    // Prose that the packs must leave alone.
    const prose = normalize('zoom in on the rust on the gate, then ramp up the linear plan and slack off', dev.lexicon);
    expect(prose.changed).toBe(false);
    const pedantic = normalize('he can be a bit pedantic and graphical about it', dev.lexicon);
    expect(pedantic.changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadPack / listPacks on a scratch directory
// ---------------------------------------------------------------------------

describe('loadPack', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-packs-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('rejects unknown and unsafe names before touching the filesystem', async () => {
    await fs.writeFile(path.join(dir, 'good.yaml'), 'name: good\ntitle: Good\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
    await expect(loadPack('nope', { dir })).rejects.toThrow(PackNotFoundError);
    await expect(loadPack('nope', { dir })).rejects.toThrow(/unknown pack "nope" \(available: good\)/);
    for (const bad of ['../good', 'Good', 'good.yaml', 'a b', '', '-lead']) {
      await expect(loadPack(bad, { dir })).rejects.toThrow(PackNotFoundError);
      expect(PACK_NAME_RE.test(bad)).toBe(false);
    }
    const good = await loadPack('good', { dir });
    expect(good).toMatchObject({ name: 'good', title: 'Good', description: '', version: 1, terms: 1, aliases: 1 });
    expect(good.lexicon.terms[0]).toMatchObject({ canonical: 'Ashlr.AI', aliases: ['Ashler'] });
  });

  it('reports a broken pack with its path and the reason', async () => {
    await fs.writeFile(path.join(dir, 'wrong-name.yaml'), 'name: other\ntitle: X\nterms:\n  - canonical: A\n');
    await expect(loadPack('wrong-name', { dir })).rejects.toThrow(/name "other" does not match the file name "wrong-name"/);
    await fs.writeFile(path.join(dir, 'empty.yaml'), 'name: empty\ntitle: X\nterms: []\n');
    await expect(loadPack('empty', { dir })).rejects.toThrow(/at least one term/);
    await fs.writeFile(path.join(dir, 'dupe.yaml'), 'name: dupe\ntitle: X\nterms:\n  - canonical: A\n  - canonical: a\n');
    await expect(loadPack('dupe', { dir })).rejects.toThrow(/"a" is listed twice/);
    await fs.writeFile(path.join(dir, 'bad-term.yaml'), 'name: bad-term\ntitle: X\nterms:\n  - canonical: ""\n');
    await expect(loadPack('bad-term', { dir })).rejects.toThrow(/Invalid pack at .*bad-term\.yaml: Invalid lexicon/);
    await fs.writeFile(path.join(dir, 'syntax.yaml'), 'name: [\n');
    await expect(loadPack('syntax', { dir })).rejects.toThrow(/Invalid pack at .*syntax\.yaml/);
    // listPacks surfaces the first broken file rather than hiding it; an empty dir lists nothing.
    await expect(listPacks({ dir })).rejects.toThrow(/Invalid pack/);
    expect(await listPacks({ dir: path.join(dir, 'missing') })).toEqual([]);
  });

  it('reads community manifest fields and defaults them for the vendored packs', async () => {
    await fs.writeFile(
      path.join(dir, 'community.yaml'),
      'name: community\ntitle: Community\nauthor: example\nhomepage: https://example.com\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n',
    );
    const community = await loadPack('community', { dir });
    expect(community).toMatchObject({ author: 'example', homepage: 'https://example.com' });
    await fs.writeFile(path.join(dir, 'plain.yaml'), 'name: plain\ntitle: Plain\nterms:\n  - canonical: A\n    aliases: [b]\n');
    const plain = await loadPackFile(path.join(dir, 'plain.yaml'));
    expect(plain).toMatchObject({ author: '', homepage: '' });
    expect(parsePackText('name: plain\ntitle: Plain\nauthor: x\nterms:\n  - canonical: A\n    aliases: [b]\n', 'inline', 'plain').author).toBe('x');
  });

  it('ignores files that are not packs', async () => {
    await fs.writeFile(path.join(dir, 'README.md'), '# not a pack\n');
    await fs.writeFile(path.join(dir, 'Bad Name.yaml'), 'name: x\n');
    await fs.writeFile(path.join(dir, 'ok.yaml'), 'name: ok\ntitle: Ok\ndescription: d\nterms:\n  - canonical: A\n    aliases: [b]\n');
    expect((await listPacks({ dir })).map((p) => p.name)).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// installPack / uninstallPack
// ---------------------------------------------------------------------------

describe('installPack / uninstallPack', () => {
  let home: string;
  let cwd: string;
  let globalPath: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-packs-home-')));
    cwd = path.join(home, 'work');
    await fs.mkdir(cwd, { recursive: true });
    globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
    for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'LEXICON_PATH', 'LEXICON_TRUST_ALL']) savedEnv[key] = process.env[key];
    process.env.HOME = home;
    // os.homedir() reads USERPROFILE on Windows and ignores HOME.
    process.env.USERPROFILE = home;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    process.env.LEXICON_PATH = globalPath;
    delete process.env.LEXICON_TRUST_ALL;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('adds every term with source pack, records the pack in settings, and is idempotent', async () => {
    const pack = await loadPack('developer');
    const first = await installPack('developer', { cwd, globalPath });
    expect(first).toMatchObject({ added: pack.terms, merged: 0, path: globalPath, scope: 'global', alreadyInstalled: false });
    expect(first.pack.name).toBe('developer');
    expect(first.pack).not.toHaveProperty('lexicon');

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms).toHaveLength(pack.terms);
    expect(file.lexicon.terms.every((t) => t.source === 'pack' && t.scope === 'global' && typeof t.createdAt === 'string')).toBe(true);
    expect(file.lexicon.settings?.packs).toEqual(['developer']);
    const kube = file.lexicon.terms.find((t) => t.canonical === 'Kubernetes');
    expect(kube?.aliases).toEqual(pack.lexicon.terms.find((t) => t.canonical === 'Kubernetes')?.aliases);
    expect(kube?.phonetic).toBe('koo-ber-NET-eez');
    expect(file.lexicon.terms.find((t) => t.canonical === 'GraphQL')?.never).toEqual(['graphical']);
    expect(installedPacks(await loadLexicon({ cwd, globalPath }))).toEqual(['developer']);

    const again = await installPack('developer', { cwd, globalPath });
    expect(again).toMatchObject({ added: 0, merged: pack.terms });
    const second = await readLexiconFile(globalPath, 'global');
    expect(second.lexicon.terms).toEqual(file.lexicon.terms);
    expect(second.lexicon.settings?.packs).toEqual(['developer']);

    const ai = await installPack('ai', { cwd, globalPath });
    expect(ai.added).toBe((await loadPack('ai')).terms);
    expect((await readLexiconFile(globalPath, 'global')).lexicon.settings?.packs).toEqual(['developer', 'ai']);
    expect(installedPacks(await loadLexicon({ cwd, globalPath }))).toEqual(['developer', 'ai']);

    // The demo sentence, end to end through the store.
    const loaded = await loadLexicon({ cwd, globalPath });
    expect(normalize('deploy to cuban eats on versal with superbase', loaded.merged).output).toBe('deploy to Kubernetes on Vercel with Supabase');
    expect(normalize('ask and tropic about em see pee', loaded.merged).output).toBe('ask Anthropic about MCP');
  });

  it('installs a pack with a bounded number of YAML parses, not a read and write per term', async () => {
    // Each write re-parses the whole file to edit it in place and to check it
    // reads back, so one addTerm per term was quadratic: the 82-term developer
    // pack parsed the growing file about 250 times and took seconds, enough
    // to hit this suite's timeout under full-suite load.
    const pack = await loadPack('developer');
    yamlParses.count = 0;
    await installPack('developer', { cwd, globalPath });
    const fresh = yamlParses.count;
    yamlParses.count = 0;
    await installPack('developer', { cwd, globalPath });
    const again = yamlParses.count;
    expect(pack.terms).toBeGreaterThan(50);
    expect(fresh).toBeLessThan(15);
    expect(again).toBeLessThan(15);
  });

  it('merges into a term the user already has without touching their aliases, source or phonetic', async () => {
    await addTerm(
      { canonical: 'kubernetes', aliases: ['kube', 'k8s'], phonetic: 'my way', category: 'other', notes: 'mine', never: ['cubes'] },
      { globalPath },
    );
    await addTerm({ canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand' }, { globalPath });
    const result = await installPack('developer', { cwd, globalPath });
    const pack = await loadPack('developer');
    expect(result).toMatchObject({ added: pack.terms - 1, merged: 1 });
    const file = await readLexiconFile(globalPath, 'global');
    const kube = file.lexicon.terms.find((t) => t.canonical === 'kubernetes');
    expect(kube).toBeDefined();
    expect(kube?.source).toBe('user');
    expect(kube?.phonetic).toBe('my way');
    expect(kube?.category).toBe('other');
    expect(kube?.notes).toBe('mine');
    expect(kube?.aliases.slice(0, 2)).toEqual(['kube', 'k8s']);
    expect(kube?.aliases).toContain('cuban eats');
    expect(kube?.never).toEqual(['cubes']);
    expect(file.lexicon.terms.filter((t) => t.canonical.toLowerCase() === 'kubernetes')).toHaveLength(1);
    expect(file.lexicon.terms[0]?.canonical).toBe('kubernetes');
    expect(file.lexicon.terms[1]?.canonical).toBe('Ashlr.AI');
    expect(file.lexicon.terms).toHaveLength(pack.terms + 1);
  });

  it('uninstall removes the pack terms, keeps what the user edited or owned, and drops the settings entry', async () => {
    await addTerm({ canonical: 'Kubernetes', aliases: ['kube'] }, { globalPath });
    await installPack('developer', { cwd, globalPath });
    // Edits since the install: a hit, an extra alias, an extra never-word.
    await recordHits(['Vercel'], { cwd, globalPath });
    await addTerm({ canonical: 'Supabase', aliases: ['soup base'] }, { globalPath });
    await addTerm({ canonical: 'Neon', aliases: [], never: ['neon sign'] }, { globalPath });

    const result = await uninstallPack('developer', { cwd, globalPath });
    const pack = await loadPack('developer');
    expect(result.pack.name).toBe('developer');
    expect(result.files).toEqual([globalPath]);
    expect(result.kept.sort()).toEqual(['Neon', 'Supabase', 'Vercel']);
    expect(result.removed).toHaveLength(pack.terms - 1 - 3);
    expect(result.removed).not.toContain('Kubernetes');

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms.map((t) => t.canonical).sort()).toEqual(['Kubernetes', 'Neon', 'Supabase', 'Vercel']);
    expect(file.lexicon.terms.find((t) => t.canonical === 'Kubernetes')?.source).toBe('user');
    // The hit lives in the sidecar, not the file; uninstall still saw it.
    expect(file.lexicon.terms.find((t) => t.canonical === 'Vercel')?.hits).toBeUndefined();
    expect(await readGlobalHits({ globalPath })).toEqual({ vercel: 1 });
    expect(findTerm((await loadLexicon({ cwd, globalPath })).merged, 'Vercel')?.hits).toBe(1);
    expect(file.lexicon.settings).toBeUndefined();
    expect(installedPacks(await loadLexicon({ cwd, globalPath }))).toEqual([]);

    // Removing again is a no-op that rewrites nothing.
    const again = await uninstallPack('developer', { cwd, globalPath });
    expect(again).toMatchObject({ removed: [], files: [] });
    expect(again.kept.sort()).toEqual(['Neon', 'Supabase', 'Vercel']);
    // A pack that was never installed: nothing to do, no error.
    expect(await uninstallPack('business', { cwd, globalPath })).toMatchObject({ removed: [], kept: [], files: [] });
  });

  // Catches: removing one pack took a term another installed pack also has, so that pack, still installed, lost it.
  it('uninstall keeps a term another installed pack also has, and removes it with the last one', async () => {
    const dir = path.join(home, 'packs');
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, 'alpha.yaml'), 'name: alpha\ntitle: Alpha\nterms:\n  - canonical: Shared Term\n    aliases: [shared turm]\n  - canonical: Alphaword\n    aliases: [alfa word]\n');
    await fs.writeFile(path.join(dir, 'beta.yaml'), 'name: beta\ntitle: Beta\nterms:\n  - canonical: shared term\n    aliases: [shared turm]\n  - canonical: Betaword\n    aliases: [beta werd]\n');
    await installPack('alpha', { cwd, globalPath, dir });
    await installPack('beta', { cwd, globalPath, dir });

    const io = makeIO();
    expect(await runPackRemove('alpha', { cwd, globalPath }, io, { dir })).toBe(0);
    expect(io.out).toContain('kept 1 another installed pack also has: Shared Term');
    await installPack('alpha', { cwd, globalPath, dir });
    const first = await uninstallPack('alpha', { cwd, globalPath, dir });
    expect(first).toMatchObject({ removed: ['Alphaword'], kept: [], shared: ['Shared Term'] });
    const after = await readLexiconFile(globalPath, 'global');
    expect(after.lexicon.terms.map((t) => t.canonical).sort()).toEqual(['Betaword', 'Shared Term']);
    expect(after.lexicon.settings?.packs).toEqual(['beta']);

    const last = await uninstallPack('beta', { cwd, globalPath, dir });
    expect(last).toMatchObject({ kept: [], shared: [] });
    expect(last.removed.sort()).toEqual(['Betaword', 'Shared Term']);
  });

  it('keeps other settings and other packs when one pack is removed', async () => {
    await installPack('ai', { cwd, globalPath });
    await installPack('voice-tools', { cwd, globalPath });
    const file = await readLexiconFile(globalPath, 'global');
    file.lexicon.settings = { ...file.lexicon.settings, minConfidence: 0.9 };
    const { writeLexiconFile } = await import('../src/core/index.js');
    await writeLexiconFile(file);
    await uninstallPack('ai', { cwd, globalPath });
    const after = await readLexiconFile(globalPath, 'global');
    expect(after.lexicon.settings).toMatchObject({ minConfidence: 0.9, packs: ['voice-tools'] });
    expect(after.lexicon.terms).toHaveLength((await loadPack('voice-tools')).terms);
  });

  it('drops an explicit empty list left in settings when the packs entry is rewritten', async () => {
    // A hand-edited file can hold an explicit empty list (the parser keeps
    // it; only the writer declines to add new ones). The packs rewrite
    // prunes empty values, so a settings left with nothing to say is gone.
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nsettings:\n  packs: [ai]\n  protectedWords: []\nterms: []\n');
    expect((await readLexiconFile(globalPath, 'global')).lexicon.settings).toMatchObject({ packs: ['ai'], protectedWords: [] });

    await uninstallPack('ai', { cwd, globalPath });
    const after = await readLexiconFile(globalPath, 'global');
    expect(after.lexicon.settings).toBeUndefined();
  });

  it('keeps a project pack term this user has actually used, though the file shows no hits', async () => {
    const repo = path.join(home, 'repo-used');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await installPack('voice-tools', { cwd: repo, globalPath, scope: 'project' });
    const projectPath = path.join(repo, '.lexicon.yaml');
    await recordHits(['Superwhisper'], { cwd: repo, globalPath });

    // The counter is in this user's sidecar, not in the committed file. The
    // "you have edited this, keep it" guard has to look there, or `pack
    // remove` deletes the terms the user relies on most.
    const onDisk = await readLexiconFile(projectPath, 'project');
    expect(onDisk.lexicon.terms.find((t) => t.canonical === 'Superwhisper')?.hits).toBeUndefined();

    const removed = await uninstallPack('voice-tools', { cwd: repo, globalPath });
    expect(removed.kept).toContain('Superwhisper');
    expect(removed.removed).not.toContain('Superwhisper');
    const after = await readLexiconFile(projectPath, 'project');
    expect(after.lexicon.terms.map((t) => t.canonical)).toEqual(['Superwhisper']);
  });

  // Catches: with leaveUntrusted the terms were written unpinned, but the
  // settings.packs rewrite then ran refreshTrust, which re-pinned a file
  // that had changed since it was trusted: the side door the flag closes.
  it('with leaveUntrusted creates a new project file untrusted and leaves a changed one changed', async () => {
    const repo = path.join(home, 'repo-unpinned');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const projectPath = path.join(repo, '.lexicon.yaml');
    const opts = { cwd: repo, globalPath, scope: 'project' as const, leaveUntrusted: true };
    const status = async () => isTrusted(await readLexiconFile(projectPath, 'project'), { cwd: repo, globalPath });

    await installPack('voice-tools', opts);
    expect(await status()).toBe('untrusted');

    await trustProject(projectPath, { cwd: repo, globalPath });
    await fs.appendFile(projectPath, '# edited after trust\n');
    expect(await status()).toBe('changed');
    await installPack('developer', opts);
    expect(await status()).toBe('changed');
    expect((await readLexiconFile(projectPath, 'project')).lexicon.settings?.packs).toEqual(['voice-tools', 'developer']);
  });

  it('installs into a project lexicon (created and trusted) and removes from it under the trust gate', async () => {
    const repo = path.join(home, 'repo');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const result = await installPack('voice-tools', { cwd: repo, globalPath, scope: 'project' });
    const projectPath = path.join(repo, '.lexicon.yaml');
    expect(result).toMatchObject({ path: projectPath, scope: 'project' });
    const loaded = await loadLexicon({ cwd: repo, globalPath });
    expect(loaded.projectTrust).toBe('trusted');
    expect(loaded.project?.lexicon.settings?.packs).toEqual(['voice-tools']);
    expect(installedPacks(loaded)).toEqual(['voice-tools']);
    expect(loaded.merged.terms.find((t) => t.canonical === 'Superwhisper')?.scope).toBe('project');

    // Scope-less uninstall looks at the project file first, then global.
    const removed = await uninstallPack('voice-tools', { cwd: repo, globalPath });
    expect(removed.files).toEqual([projectPath]);
    expect((await loadLexicon({ cwd: repo, globalPath })).projectTrust).toBe('trusted');

    // A hand edit makes the file 'changed': both directions are refused.
    await installPack('voice-tools', { cwd: repo, globalPath, scope: 'project' });
    await fs.appendFile(projectPath, '# edited by hand\n');
    await expect(installPack('ai', { cwd: repo, globalPath, scope: 'project' })).rejects.toThrow(/has changed since it was trusted/);
    await expect(uninstallPack('voice-tools', { cwd: repo, globalPath })).rejects.toThrow(/has changed since it was trusted/);
    await expect(uninstallPack('voice-tools', { cwd: repo, globalPath, scope: 'global' })).resolves.toMatchObject({ files: [] });
  });

  it('CLI: pack list, add, show, remove', async () => {
    const io = makeIO();
    expect(await runPackList({ cwd }, io)).toBe(0);
    expect(io.out).toMatch(/^name\s+title\s+terms\s+aliases\s+installed\s+description/);
    expect(io.out).toContain('developer');
    expect(io.out).toContain('voice-tools');
    expect(io.out).not.toMatch(/\byes\b/);

    const add = makeIO();
    expect(await runPackAdd(['developer', 'ai'], { cwd }, add)).toBe(0);
    expect(add.out).toMatch(/installed developer \(Developer tools\): \d+ added, 0 merged into /);
    expect(add.out).toMatch(/installed ai \(AI models and tools\): \d+ added, 0 merged/);
    expect(add.err).toBe('');
    // Catches: a person at a shell was told about normalize_transcript, an MCP tool they cannot call.
    expect(add.out).toContain('the terms are live: lexicon normalize, the prompt hook and lexicon serve use them from the next call');
    expect(add.out).not.toContain('normalize_transcript');

    // Catches: a reinstall that changed nothing printed "0 added, N merged" and "the terms are live".
    const dev = await loadPack('developer');
    const before = await fs.readFile(globalPath, 'utf8');
    const again = makeIO();
    expect(await runPackAdd(['developer'], { cwd }, again)).toBe(0);
    expect(again.out).toBe(`developer is already installed in ${globalPath} (${dev.terms} terms, ${dev.aliases} aliases); nothing was added\n`);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
    const againJson = makeIO();
    expect(await runPackAdd(['developer'], { cwd, json: true }, againJson)).toBe(0);
    expect(JSON.parse(againJson.out)).toMatchObject([{ added: 0, alreadyInstalled: true }]);

    const list = makeIO();
    await runPackList({ cwd, json: true }, list);
    const parsed = JSON.parse(list.out) as { packs: { name: string; installed: boolean }[]; installed: string[] };
    expect(parsed.installed).toEqual(['developer', 'ai']);
    expect(parsed.packs.find((p) => p.name === 'developer')?.installed).toBe(true);
    expect(parsed.packs.find((p) => p.name === 'business')?.installed).toBe(false);

    const show = makeIO();
    expect(await runPackShow('voice-tools', { cwd }, show)).toBe(0);
    expect(show.out).toContain('voice-tools: Voice and dictation tools');
    expect(show.out).toContain('Superwhisper');
    expect(show.out).toContain('super whisper');
    const showJson = makeIO();
    await runPackShow('business', { cwd, json: true }, showJson);
    expect(JSON.parse(showJson.out)).toMatchObject({ name: 'business', lexicon: { version: 1 } });

    const bad = makeIO();
    expect(await runPackAdd(['nope'], { cwd }, bad)).toBe(1);
    expect(bad.err).toContain('unknown pack "nope"');
    const badShow = makeIO();
    expect(await runPackShow('nope', { cwd }, badShow)).toBe(1);
    expect(badShow.err).toContain('unknown pack');
    // Catches: an unknown pack under --json got the generic nextStep, not the pack list.
    const badShowJson = makeIO();
    expect(await runPackShow('nope', { cwd, json: true }, badShowJson)).toBe(1);
    expect(JSON.parse(badShowJson.out)).toEqual({
      ok: false,
      error: expect.stringContaining('unknown pack "nope"'),
      nextStep: expect.stringContaining('run lexicon pack list'),
    });
    expect(badShowJson.err).toContain('lexicon: run lexicon pack list');
    // A ref-shaped name routes to the registry flow instead of the filesystem.
    const refShow = makeIO();
    expect(await runPackShow('../x', { cwd }, refShow)).toBe(1);
    expect(refShow.err).toContain('--registry');

    await recordHits(['Kubernetes'], { cwd, globalPath });
    const rm = makeIO();
    expect(await runPackRemove('developer', { cwd }, rm)).toBe(0);
    expect(rm.out).toMatch(/removed \d+ terms of developer from /);
    expect(rm.out).toContain('kept 1 you edited (hits, extra aliases or never-words): Kubernetes');
    const notInstalled = makeIO();
    expect(await runPackRemove('business', { cwd }, notInstalled)).toBe(0);
    expect(notInstalled.out).toContain('business is not installed');
    // Catches: under --json a pack that was not installed answered ok:true with three empty lists and no word of it.
    const notInstalledJson = makeIO();
    expect(await runPackRemove('business', { cwd, json: true }, notInstalledJson)).toBe(0);
    expect(JSON.parse(notInstalledJson.out)).toMatchObject({
      ok: true,
      notInstalled: true,
      summary: 'business is not installed; nothing was removed',
      removed: [],
      files: [],
    });
    const notInstalledProject = makeIO();
    expect(await runPackRemove('business', { cwd, json: true, project: true }, notInstalledProject)).toBe(0);
    expect(JSON.parse(notInstalledProject.out)).toMatchObject({ notInstalled: true, summary: 'business is not installed in the project lexicon; nothing was removed' });
    const rmJson = makeIO();
    expect(await runPackRemove('ai', { cwd, json: true }, rmJson)).toBe(0);
    expect(JSON.parse(rmJson.out)).toMatchObject({ kept: [], files: [globalPath] });
    expect(installedPacks(await loadLexicon({ cwd, globalPath }))).toEqual([]);
  });

  it('CLI: registerPackCommands wires pack list|add|remove|show with --json and --project', async () => {
    const io = makeIO();
    const program = new Command().exitOverride().option('--cwd <dir>');
    registerPackCommands(program, io);
    await program.parseAsync(['pack', 'add', 'voice-tools', '--json', '--cwd', cwd], { from: 'user' });
    const results = JSON.parse(io.out) as { pack: { name: string }; added: number }[];
    expect(results[0]?.pack.name).toBe('voice-tools');
    expect(results[0]?.added).toBeGreaterThan(0);
    expect(process.exitCode ?? 0).toBe(0);

    const repo = path.join(home, 'repo2');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    const io2 = makeIO();
    const program2 = new Command().exitOverride().option('--cwd <dir>');
    registerPackCommands(program2, io2);
    await program2.parseAsync(['pack', 'add', 'business', '--project', '--cwd', repo], { from: 'user' });
    expect(io2.out).toContain(path.join(repo, '.lexicon.yaml'));
    const io3 = makeIO();
    const program3 = new Command().exitOverride().option('--cwd <dir>');
    registerPackCommands(program3, io3);
    await program3.parseAsync(['pack', 'ls', '--json', '--cwd', repo], { from: 'user' });
    expect((JSON.parse(io3.out) as { installed: string[] }).installed).toEqual(['voice-tools', 'business']);
    const io4 = makeIO();
    const program4 = new Command().exitOverride().option('--cwd <dir>');
    registerPackCommands(program4, io4);
    await program4.parseAsync(['pack', 'rm', 'business', '--project', '--cwd', repo], { from: 'user' });
    expect(io4.out).toContain('removed');
    expect(io4.out).toContain(path.join(repo, '.lexicon.yaml'));
  });
});
