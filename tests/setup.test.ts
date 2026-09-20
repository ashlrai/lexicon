/**
 * `lexicon setup` against a temp HOME with every process interaction injected:
 * git (exec), the filesystem probe used for client detection, the client and
 * serve installers, and the repo harvester. Nothing here touches the machine.
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLexiconFile } from '../src/core/index.js';
import type { HarvestCandidate } from '../src/core/index.js';
import {
  SETUP_CLIENTS,
  detectClients,
  parseClientList,
  registerSetupCommands,
  runSetup,
  suggestCompany,
} from '../src/cli/cmd-setup.js';
import type { SetupDeps, SetupOptions, SetupPlan, SetupSummary } from '../src/cli/cmd-setup.js';
import type { InstallOptions } from '../src/cli/cmd-install.js';
import { runServeInstall } from '../src/cli/cmd-serve.js';
import type { ServeDeps } from '../src/cli/cmd-serve.js';
import { makeIO, scripted } from './helpers.js';



let home: string;
let cwd: string;
let globalPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-setup-home-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-setup-cwd-'));
  globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  for (const key of ['HOME', 'USERPROFILE', 'LEXICON_PATH', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  // os.homedir() reads USERPROFILE on Windows and ignores HOME.
  process.env.USERPROFILE = home;
  process.env.LEXICON_PATH = globalPath;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  for (const key of ['HOME', 'LEXICON_PATH', 'XDG_CONFIG_HOME']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface Fakes {
  deps: SetupDeps;
  installed: { client: string; opts: InstallOptions }[];
  serveCalls: number;
  present: Set<string>;
}

function fakes(overrides: Partial<SetupDeps> = {}, present: string[] = []): Fakes {
  const f: Fakes = { installed: [], serveCalls: 0, present: new Set(present), deps: {} };
  f.deps = {
    platform: 'darwin',
    env: { PATH: '/fake/bin' },
    home,
    // Real files under the temp dirs (the lexicon, .git), fake everything else.
    exists: (p) => f.present.has(p) || ((p.startsWith(cwd) || p.startsWith(home)) && existsSync(p)),
    exec: (file, args) => {
      if (file === 'git' && args.join(' ') === 'config --global user.name') return 'Mason Wyatt';
      if (file === 'git' && args.includes('get-url')) return 'https://github.com/ashlrai/lexicon.git';
      throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
    },
    isInteractive: () => false,
    installClient: async (client, opts, io, onWritten) => {
      f.installed.push({ client, opts });
      io.stdout(`   updated ${path.join(home, '.fake', client)}: mcpServers.lexicon\n`);
      onWritten(path.join(home, '.fake', client), client === 'cursor' ? 'unchanged' : 'updated');
      return 0;
    },
    installServe: async (_opts, io) => {
      f.serveCalls += 1;
      io.stdout('installed ai.ashlr.lexicon.serve; check with: lexicon serve --status\n');
      return 0;
    },
    harvest: async () => [],
    ...overrides,
  };
  return f;
}

async function run(
  opts: Partial<SetupOptions>,
  f: Fakes,
): Promise<{ code: number; summary: SetupSummary; plan?: SetupPlan; io: ReturnType<typeof makeIO> }> {
  const io = makeIO();
  const { code, summary, plan } = await runSetup({ cwd, ...opts }, io, f.deps);
  return { code, summary, io, ...(plan ? { plan } : {}) };
}

describe('runSetup --yes', () => {
  it('creates the global lexicon, seeds person + company and installs into the selected clients', async () => {
    const f = fakes();
    const { code, summary, io } = await run({ yes: true, clients: 'claude,cursor', company: 'Ashlr.AI', phonetic: 'ASH-ler', serve: true }, f);
    expect(code).toBe(0);
    expect(summary.lexiconPath).toBe(globalPath);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.exists).toBe(true);
    const company = file.lexicon.terms.find((t) => t.canonical === 'Ashlr.AI');
    expect(company?.category).toBe('brand');
    expect(company?.phonetic).toBe('ASH-ler');
    expect(company?.aliases.length).toBeGreaterThan(0);
    expect(file.lexicon.terms.find((t) => t.canonical === 'Mason Wyatt')?.category).toBe('person');

    expect(f.installed.map((i) => i.client)).toEqual(['claude', 'cursor']);
    expect(f.installed.every((i) => i.opts.apply === true && i.opts.home === home)).toBe(true);
    // detail is the file the installer wrote (from its onWritten report), not its export hint.
    expect(summary.clients).toEqual([
      { name: 'claude', status: 'installed', detail: '~/.fake/claude' },
      { name: 'cursor', status: 'installed', detail: '~/.fake/cursor (unchanged)' },
    ]);
    expect(summary.serve).toBe('installed');
    expect(f.serveCalls).toBe(1);
    expect(summary.exports).toEqual([]);
    expect(io.out).toContain('created ~/.config/lexicon/lexicon.yaml');
    expect(io.out).toContain('claude: installed');
    expect(io.out).toContain('Next:');
    expect(io.out).toContain('"Ashlr.AI"');
    expect(io.err).toBe('');
  });

  it('is idempotent: a second run adds nothing and reports no new terms', async () => {
    const f = fakes();
    await run({ yes: true, clients: 'claude', company: 'Ashlr.AI' }, f);
    const first = (await readLexiconFile(globalPath, 'global')).lexicon.terms;
    const { code, summary } = await run({ yes: true, clients: 'claude', company: 'Ashlr.AI' }, f);
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual([]);
    const second = (await readLexiconFile(globalPath, 'global')).lexicon.terms;
    expect(second).toEqual(first);
    expect(f.installed).toHaveLength(2);
  });

  it('--clients none skips the client step entirely', async () => {
    const f = fakes();
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(summary.clients).toEqual([]);
    expect(f.installed).toEqual([]);
    expect(io.out).toContain('skipped (--clients none)');
  });

  it('--no-serve, --no-harvest and no --app leave those steps skipped', async () => {
    const f = fakes();
    const { summary, io } = await run({ yes: true, clients: 'none', serve: false, harvest: false }, f);
    expect(summary.serve).toBe('skipped');
    expect(f.serveCalls).toBe(0);
    expect(io.out).toContain('skipped (--no-harvest)');
    expect(io.out).toContain('skipped (--no-serve)');
    expect(summary.exports).toEqual([]);
  });

  it('--yes never installs the login service unless --serve is passed explicitly', async () => {
    const f = fakes();
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(summary.serve).toBe('skipped');
    expect(f.serveCalls).toBe(0);
    expect(io.out).toContain('skipped (not requested); add --serve to install it');

    // Off a terminal without --yes the same rule applies.
    const quiet = fakes();
    const { summary: s2 } = await run({ clients: 'none', company: 'Ashlr.AI' }, quiet);
    expect(s2.serve).toBe('skipped');
    expect(quiet.serveCalls).toBe(0);

    const explicit = fakes();
    const { summary: s3 } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', serve: true }, explicit);
    expect(s3.serve).toBe('installed');
    expect(explicit.serveCalls).toBe(1);
  });

  it('skips the seed when the lexicon already has 3 terms unless --reseed', async () => {
    const f = fakes();
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(
      globalPath,
      'version: 1\nterms:\n  - canonical: A\n    aliases: []\n  - canonical: B\n    aliases: []\n  - canonical: C\n    aliases: []\n',
    );
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(summary.termsAdded).toEqual([]);
    expect(io.out).toContain('already has 3 terms');

    const again = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', reseed: true }, f);
    expect(again.summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
  });

  it('suggests the company from the git remote when nothing is passed and seeds it', async () => {
    const f = fakes();
    const { summary } = await run({ yes: true, clients: 'none' }, f);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'ashlrai']);
  });

  it('uses --person over git and skips the person term when git has no name', async () => {
    const f = fakes({ exec: () => { throw new Error('no git'); } });
    const { summary, io } = await run({ yes: true, clients: 'none', person: 'Jane Doe', company: 'Acme' }, f);
    expect(summary.termsAdded).toEqual(['Jane Doe', 'Acme']);
    const none = await run({ yes: true, clients: 'none', reseed: true }, fakes({ exec: () => { throw new Error('no git'); } }));
    expect(none.io.out).toContain('no person term');
    expect(none.io.out).toContain('no company term');
    expect(io.err).toBe('');
  });

  it('installs into every detected client when --clients is omitted', async () => {
    const f = fakes({}, [path.join(home, '.claude'), '/Applications/Cursor.app', '/fake/bin/codex']);
    const { summary } = await run({ yes: true, company: 'Ashlr.AI' }, f);
    expect(f.installed.map((i) => i.client)).toEqual(['claude', 'codex', 'cursor']);
    expect(summary.clients.map((c) => c.status)).toEqual(['installed', 'installed', 'installed']);
  });

  it('reports a failing installer as failed, keeps going and exits 1', async () => {
    const f = fakes({
      installClient: async (client, _opts, io) => {
        if (client === 'claude') {
          io.stderr('   failed: claude: command not found\n');
          return 1;
        }
        if (client === 'codex') throw new Error('boom');
        io.stdout('   created x: mcpServers.lexicon\n');
        return 0;
      },
    });
    const { code, summary, io } = await run({ yes: true, clients: 'claude,codex,cursor', company: 'Ashlr.AI', serve: true }, f);
    expect(code).toBe(1);
    expect(summary.clients).toEqual([
      { name: 'claude', status: 'failed', detail: 'failed: claude: command not found' },
      { name: 'codex', status: 'failed', detail: 'boom' },
      { name: 'cursor', status: 'installed', detail: 'created x: mcpServers.lexicon' },
    ]);
    expect(io.err).toContain('claude: failed');
    expect(io.err).toContain('lexicon install claude --apply');
    expect(summary.serve).toBe('installed');
  });

  it('marks serve as failed when the installer fails and skips it on Windows', async () => {
    const f = fakes({ installServe: async (_o, io) => { io.stderr('launchctl: nope\n'); return 1; } });
    const { code, summary } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', serve: true }, f);
    expect(code).toBe(1);
    expect(summary.serve).toBe('failed');

    const win = fakes({ platform: 'win32' });
    const { summary: s2, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', serve: true }, win);
    expect(s2.serve).toBe('skipped');
    expect(win.serveCalls).toBe(0);
    expect(io.out).toContain('not automated on win32');
  });

  it('harvests a git repo into its project lexicon (auto-trusted) and counts the terms', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const candidates: HarvestCandidate[] = [
      { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: ['package.json'], count: 9, suggestedAliases: ['play right'] },
      { canonical: 'Kubernetes', category: 'product', source: 'harvest:repo', evidence: ['README.md'], count: 6, suggestedAliases: [] },
    ];
    let harvestArgs: unknown[] = [];
    const f = fakes({
      harvest: async (root, opts) => {
        harvestArgs = [root, opts];
        return candidates;
      },
    });
    // Under --yes the harvest is opt-in: without --harvest nothing is written to the repo.
    const quiet = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(quiet.summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
    expect(quiet.io.out).toContain('skipped (not requested); add --harvest');
    expect(existsSync(path.join(cwd, '.lexicon.yaml'))).toBe(false);
    expect(harvestArgs).toEqual([]);

    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', harvest: true }, f);
    expect(harvestArgs).toEqual([cwd, { limit: 10, minCount: 5 }]);
    expect(summary.termsAdded).toEqual(['Playwright', 'Kubernetes']);
    const project = await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project');
    expect(project.lexicon.terms.map((t) => t.canonical)).toEqual(['Playwright', 'Kubernetes']);
    expect(io.out).toContain('added 2 new terms, merged 0');

    // Second run merges instead of duplicating.
    const again = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', harvest: true }, f);
    expect(again.summary.termsAdded).toEqual([]);
    expect((await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project')).lexicon.terms).toHaveLength(2);
  });

  it('never seeds a person or company that is already in the global lexicon, and the harvest skips names the global lexicon covers', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: mason wyatt\n    aliases: [mason wyeth]\n    category: person\n', 'utf8');
    const f = fakes({
      harvest: async () => [
        { canonical: 'Mason Wyatt', category: 'person', source: 'harvest:git', evidence: ['git log'], count: 40, suggestedAliases: [] },
        { canonical: 'ASHLR.AI', category: 'brand', source: 'harvest:package', evidence: ['package.json'], count: 9, suggestedAliases: [] },
        { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: ['package.json'], count: 9, suggestedAliases: [] },
      ],
    });
    // --person equals git user.name (differently cased) and the lexicon already has it: added once, never twice.
    const { summary, io } = await run({ yes: true, clients: 'none', person: 'Mason Wyatt', company: 'Ashlr.AI', harvest: true, reseed: true }, f);
    expect(io.out).toContain('already present: mason wyatt (person)');
    expect(summary.termsAdded).toEqual(['Ashlr.AI', 'Playwright']);
    const globalTerms = (await readLexiconFile(globalPath, 'global')).lexicon.terms.map((t) => t.canonical);
    expect(globalTerms).toEqual(['mason wyatt', 'Ashlr.AI']);
    expect(io.out).toContain('already in the global lexicon: Mason Wyatt, ASHLR.AI');
    const project = (await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project')).lexicon.terms.map((t) => t.canonical);
    expect(project).toEqual(['Playwright']);

    // A second seed of the same company is reported, not merged into a second term, and the plan agrees.
    const again = await run({ yes: true, clients: 'none', company: 'ashlr.ai', harvest: false, reseed: true }, f);
    expect(again.summary.termsAdded).toEqual([]);
    expect(again.io.out).toContain('already present: Ashlr.AI (brand)');
    const planned = await run({ yes: true, dryRun: true, clients: 'none', company: 'ashlr.ai', person: 'MASON WYATT', reseed: true }, f);
    expect(planned.plan?.wouldSeed).toEqual([]);
    // the developer pack already covers Playwright, so the planned harvest leaves it out
    expect(planned.plan?.wouldHarvest).toEqual([]);
  });

  it('hands the serve installer the CLI next to deps.cliDir, and the plist it writes points at an existing dist/cli/index.js', async () => {
    const cliDir = path.join(home, 'pkg', 'dist', 'cli');
    await fs.mkdir(cliDir, { recursive: true });
    await fs.writeFile(path.join(cliDir, 'index.js'), '#!/usr/bin/env node\n');
    const calls: string[][] = [];
    let seen: ServeDeps | undefined;
    const f = fakes({
      cliDir,
      installServe: (opts, io, serveDeps) => {
        seen = serveDeps;
        return runServeInstall(opts, io, { ...serveDeps, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; }, nodePath: '/usr/local/bin/node', uid: 501 });
      },
    });
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', serve: true }, f);
    expect(summary.serve).toBe('installed');
    expect(seen?.cliPath).toBe(path.join(cliDir, 'index.js'));
    expect(seen?.home).toBe(home);
    const plist = await fs.readFile(path.join(home, 'Library', 'LaunchAgents', 'ai.ashlr.lexicon.serve.plist'), 'utf8');
    const args = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(args[2]).toBe(path.join(cliDir, 'index.js'));
    expect(args[2].endsWith(path.join('dist', 'cli', 'index.js'))).toBe(true);
    expect(existsSync(args[2])).toBe(true);
    expect(calls[0]).toEqual(['launchctl', 'bootout', 'gui/501/ai.ashlr.lexicon.serve']);
    expect(io.out).toContain('installed ai.ashlr.lexicon.serve');

    // A cliDir without a built index.js (the plugin bundle's "next to me" mistake): refused, nothing written, no bootout.
    const broken = path.join(home, 'plugin');
    await fs.rm(path.join(home, 'Library'), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    const calls2: string[][] = [];
    const g = fakes({
      cliDir: broken,
      installServe: (opts, io, serveDeps) =>
        runServeInstall(opts, io, { ...serveDeps, exec: async (cmd, args) => { calls2.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; }, uid: 501 }),
    });
    const refused = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', serve: true }, g);
    expect(refused.code).toBe(1);
    expect(refused.summary.serve).toBe('failed');
    expect(refused.io.err).toContain(`refusing to install the login service: ${path.join(broken, 'index.js')} does not exist`);
    expect(calls2).toEqual([]);
    expect(existsSync(path.join(home, 'Library', 'LaunchAgents', 'ai.ashlr.lexicon.serve.plist'))).toBe(false);
  });

  it('writes the dictation export with --app and reports where to import it', async () => {
    const exportDir = path.join(home, 'Desktop');
    const f = fakes();
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', app: 'wispr', exportDir }, f);
    expect(summary.exports).toEqual([{ format: 'wispr', path: path.join(exportDir, 'lexicon-wispr.csv') }]);
    const csv = await fs.readFile(path.join(exportDir, 'lexicon-wispr.csv'), 'utf8');
    expect(csv).toContain('Ashlr.AI');
    expect(io.out).toContain('Wispr Flow > Dictionary > Import');
    await expect(run({ yes: true, clients: 'none', app: 'dragon' }, f)).rejects.toThrow(/unknown app "dragon"/);
  });

  it('rejects bad --clients / --app before touching anything', async () => {
    const f = fakes();
    await expect(run({ yes: true, clients: 'emacs' }, f)).rejects.toThrow(/unknown client "emacs"/);
    await expect(run({ yes: true, clients: 'none', app: 'dragon' }, f)).rejects.toThrow(/unknown app "dragon"/);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('--json prints only the summary on stdout and progress on stderr', async () => {
    const f = fakes();
    const { summary, io } = await run({ yes: true, json: true, clients: 'claude', company: 'Ashlr.AI' }, f);
    const parsed = JSON.parse(io.out) as SetupSummary;
    expect(parsed).toEqual(summary);
    expect(Object.keys(parsed).sort()).toEqual(['clients', 'demo', 'exports', 'lexiconPath', 'packs', 'serve', 'termsAdded']);
    expect(io.err).toContain('lexicon setup');
    expect(io.err).toContain('claude: installed');
    // The run ends in a correction the caller can show, not just a file list.
    expect(parsed.demo?.corrected).toContain('Ashlr.AI');
    expect(parsed.demo?.heard).not.toBe(parsed.demo?.corrected);
  });

  it('takes the defaults off a terminal without --yes and says so', async () => {
    const f = fakes();
    const { summary, io } = await run({ clients: 'none', company: 'Ashlr.AI' }, f);
    expect(io.out).toContain('no terminal: taking the defaults');
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
  });
});

describe('runSetup --dry-run', () => {
  it('runs every detection and suggestion, writes nothing and returns the plan', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const exportDir = path.join(home, 'Desktop');
    const f = fakes(
      {
        harvest: async () => [
          { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: [], count: 9, suggestedAliases: ['play right'] },
        ],
      },
      [path.join(home, '.claude'), '/Applications/Cursor.app', '/fake/bin/codex'],
    );
    const { code, summary, plan, io } = await run({ yes: true, dryRun: true, company: 'Ashlr.AI', app: 'wispr', exportDir, serve: true }, f);
    expect(code).toBe(0);
    expect(plan).toEqual({
      plan: true,
      lexiconPath: globalPath,
      lexiconExists: false,
      wouldSeed: ['Mason Wyatt', 'Ashlr.AI'],
      wouldInstallPacks: ['developer', 'ai', 'voice-tools'],
      wouldHarvest: [],
      detectedClients: ['claude', 'codex', 'cursor'],
      wouldInstallClients: ['claude', 'codex', 'cursor'],
      wouldInstallServe: true,
      wouldExport: [{ format: 'wispr', path: path.join(exportDir, 'lexicon-wispr.csv') }],
      // A dry run writes nothing, so there is no lexicon to demonstrate from:
      // the example terms stand in, and the plan carries what a real run would show.
      demo: {
        heard: 'can you check whether the Ashler migration landed yet',
        corrected: 'can you check whether the Ashlr.AI migration landed yet',
        terms: ['Ashlr.AI'],
        usedExample: true,
      },
    });
    // Nothing on disk, nothing installed, the summary untouched.
    expect(existsSync(globalPath)).toBe(false);
    expect(existsSync(path.join(cwd, '.lexicon.yaml'))).toBe(false);
    expect(existsSync(exportDir)).toBe(false);
    expect(f.installed).toEqual([]);
    expect(f.serveCalls).toBe(0);
    expect(summary).toEqual({ lexiconPath: globalPath, termsAdded: [], packs: [], clients: [], serve: 'skipped', exports: [] });
    expect(io.out).toContain('lexicon setup (dry run)');
    expect(io.out).toContain('would create ~/.config/lexicon/lexicon.yaml');
    // the developer pack covers the only candidate, so the harvest has nothing left
    expect(io.out).toContain('nothing worth adding in');
    expect(io.out).toContain('Playwright');
    expect(io.out).toContain('Plan (nothing written)');
    expect(io.err).toBe('');
  });

  it('still lists the detected clients under --clients none, and serve/export stay off unless asked', async () => {
    const f = fakes({}, [path.join(home, '.claude'), '/Applications/Cursor.app']);
    const { plan } = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(plan).toMatchObject({ detectedClients: ['claude', 'cursor'], wouldInstallClients: [], wouldInstallServe: false, wouldExport: [] });
    const picked = await run({ yes: true, dryRun: true, clients: 'cursor', company: 'Ashlr.AI' }, f);
    expect(picked.plan?.wouldInstallClients).toEqual(['cursor']);
    expect(f.installed).toEqual([]);
  });

  it('reports an already seeded lexicon as nothing to seed and never prompts', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    const before = 'version: 1\nterms:\n  - canonical: A\n    aliases: []\n  - canonical: B\n    aliases: []\n  - canonical: C\n    aliases: []\n';
    await fs.writeFile(globalPath, before);
    const p = scripted([]);
    const f = fakes({ isInteractive: () => true, createPrompter: () => p });
    const { plan, io } = await run({ dryRun: true }, f);
    expect(plan).toMatchObject({ lexiconExists: true, wouldSeed: [] });
    expect(p.asked).toEqual([]);
    expect(io.out).toContain('already has 3 terms');
    expect(await fs.readFile(globalPath, 'utf8')).toBe(before);
  });

  it('--json prints the plan instead of the summary', async () => {
    const f = fakes();
    const { plan, io } = await run({ yes: true, dryRun: true, json: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(JSON.parse(io.out)).toEqual(plan);
    expect(io.err).toContain('dry run');
  });
});

describe('runSetup interactive', () => {
  it('walks every prompt: person, company, phonetic, another term, packs, harvest, clients, serve, app', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const exportDir = path.join(home, 'Desktop');
    const p = scripted([
      'y', // add "Mason Wyatt" as a person term?
      'Ashlr.AI', // company (suggestion from remote: ashlrai)
      'ASH-ler', // phonetic hint
      'y', // add another term?
      'Locus', // name
      '', // phonetic
      'product', // category
      'n', // add another term?
      [], // starter packs checklist: none
      'n', // also add business?
      'n', // add harvest candidates? -> skipped
      [1], // clients checklist: pick the first detected (claude)
      'y', // install serve?
      2, // dictation app: Superwhisper
    ]);
    const f = fakes(
      {
        isInteractive: () => true,
        createPrompter: () => p,
        harvest: async () => [
          { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: [], count: 9, suggestedAliases: [] },
        ],
      },
      [path.join(home, '.claude'), '/Applications/Cursor.app'],
    );
    const { code, summary, io } = await run({ exportDir }, f);
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI', 'Locus']);
    const terms = (await readLexiconFile(globalPath, 'global')).lexicon.terms;
    expect(terms.find((t) => t.canonical === 'Ashlr.AI')?.phonetic).toBe('ASH-ler');
    expect(terms.find((t) => t.canonical === 'Locus')?.category).toBe('product');
    expect(io.out).toContain('pick them one by one later');
    expect(f.installed.map((i) => i.client)).toEqual(['claude']);
    expect(summary.serve).toBe('installed');
    expect(summary.exports).toEqual([{ format: 'superwhisper', path: path.join(exportDir, 'lexicon-superwhisper.json') }]);
    expect(p.asked[1]).toContain('company or product name');
    expect(p.closed).toBe(false); // the caller owns an injected prompter
  });

  it('Enter everywhere takes the defaults: person yes, suggested company, default packs, harvest yes, all clients, serve yes, first app', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const exportDir = path.join(home, 'Desktop');
    // The packs checklist starts with developer, ai and voice-tools checked; business is a separate no-by-default question.
    const p = scripted(['', '', '', '', [1, 2, 3], '', '', [1, 2], '', 1]);
    const f = fakes(
      {
        isInteractive: () => true,
        createPrompter: () => p,
        harvest: async () => [
          { canonical: 'LexiconStore', category: 'identifier', source: 'harvest:repo', evidence: [], count: 9, suggestedAliases: [] },
        ],
      },
      [path.join(home, '.claude'), '/Applications/Cursor.app'],
    );
    const { summary } = await run({ exportDir }, f);
    expect(summary.packs.map((x) => x.name)).toEqual(['developer', 'ai', 'voice-tools']);
    expect(summary.packs.every((x) => x.added > 0 && x.merged === 0)).toBe(true);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'ashlrai', 'LexiconStore']);
    expect(f.installed.map((i) => i.client)).toEqual(['claude', 'cursor']);
    expect(summary.serve).toBe('installed');
    expect(summary.exports[0]?.format).toBe('wispr');
  });
});

describe('detectClients', () => {
  const ctx = (present: string[], platform: NodeJS.Platform = 'darwin'): SetupDeps => ({
    platform,
    home: '/home/u',
    env: { PATH: '/usr/local/bin:/opt/bin' },
    // detectClients probes config dirs and app bundles with the *host's*
    // path.join (backslashes on a Windows runner) but probes PATH through
    // which.ts, which uses the injected platform and so stays POSIX. Accept
    // either spelling so the fixture reads the same on all three platforms.
    exists: (p) => present.includes(p) || present.some((x) => path.join(x) === p),
  });

  it('finds clients by config dir, app bundle or CLI on PATH', async () => {
    const found = await detectClients(
      ctx([
        '/home/u/.claude',
        '/opt/bin/codex',
        '/Applications/Cursor.app',
        '/home/u/.codeium/windsurf',
        '/usr/local/bin/gemini',
        '/Applications/Visual Studio Code.app',
        '/home/u/Library/Application Support/Claude',
      ]),
      '/work',
    );
    const j = (p: string) => path.join(p);
    expect(found.map((c) => [c.name, c.detected, c.evidence])).toEqual([
      ['claude', true, j('/home/u/.claude')],
      ['codex', true, '/opt/bin/codex'],
      ['cursor', true, j('/Applications/Cursor.app')],
      ['windsurf', true, j('/home/u/.codeium/windsurf')],
      ['gemini', true, '/usr/local/bin/gemini'],
      ['claude-desktop', true, j('/home/u/Library/Application Support/Claude')],
      ['vscode', true, j('/Applications/Visual Studio Code.app')],
    ]);
  });

  it('reports nothing on an empty machine and ignores /Applications off macOS', async () => {
    const none = await detectClients(ctx([]), '/work');
    expect(none.every((c) => !c.detected)).toBe(true);
    expect(none.map((c) => c.name)).toEqual([...SETUP_CLIENTS]);
    const linux = await detectClients(ctx(['/Applications/Cursor.app', '/home/u/.config/Code'], 'linux'), '/work');
    expect(linux.find((c) => c.name === 'cursor')?.detected).toBe(false);
    expect(linux.find((c) => c.name === 'vscode')?.evidence).toBe(path.join('/home/u/.config/Code'));
  });
});

describe('helpers', () => {
  it('suggestCompany prefers the package scope, then the remote org', () => {
    expect(suggestCompany('@ashlr/lexicon', 'https://github.com/ashlrai/lexicon.git')).toBe('Ashlr');
    expect(suggestCompany('lexicon', 'https://github.com/ashlrai/lexicon.git')).toBe('ashlrai');
    expect(suggestCompany(undefined, 'git@github.com:ashlrai/lexicon.git')).toBe('ashlrai');
    expect(suggestCompany(undefined, 'ssh://git@gitlab.com/acme/tools/')).toBe('acme');
    expect(suggestCompany(undefined, undefined)).toBeUndefined();
    expect(suggestCompany('plain', 'not a url')).toBeUndefined();
  });

  it('parseClientList validates and dedupes', () => {
    expect(parseClientList('claude, cursor,claude')).toEqual(['claude', 'cursor']);
    expect(parseClientList('none')).toEqual([]);
    expect(() => parseClientList('claude,emacs')).toThrow(/unknown client "emacs"/);
  });

  it('registerSetupCommands wires `setup` with its flags', async () => {
    const io = makeIO();
    const program = new Command().exitOverride().option('--cwd <dir>');
    registerSetupCommands(program, io);
    await program.parseAsync(['setup', '--yes', '--clients', 'none', '--no-serve', '--no-harvest', '--company', 'Acme', '--json', '--cwd', cwd], {
      from: 'user',
    });
    const parsed = JSON.parse(io.out) as SetupSummary;
    expect(parsed.lexiconPath).toBe(globalPath);
    expect(parsed.termsAdded).toContain('Acme');
    expect(parsed.serve).toBe('skipped');
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('registerSetupCommands wires --dry-run (writes nothing) and leaves serve undefined without --serve/--no-serve', async () => {
    const io = makeIO();
    const program = new Command().exitOverride().option('--cwd <dir>');
    registerSetupCommands(program, io);
    // Real detection against the temp home is read-only; only the shape is asserted.
    await program.parseAsync(['setup', '--dry-run', '--json', '--clients', 'none', '--no-harvest', '--company', 'Acme', '--home', home, '--cwd', cwd], {
      from: 'user',
    });
    const parsed = JSON.parse(io.out) as SetupPlan;
    expect(parsed.plan).toBe(true);
    expect(parsed.lexiconPath).toBe(globalPath);
    expect(parsed.wouldSeed).toContain('Acme');
    expect(parsed.wouldInstallClients).toEqual([]);
    expect(parsed.wouldInstallServe).toBe(false);
    expect(existsSync(globalPath)).toBe(false);

    const flags = new Command().exitOverride();
    let seen: SetupOptions | undefined;
    flags.command('setup').option('--serve').option('--no-serve').option('--harvest').option('--no-harvest').action((o: SetupOptions) => {
      seen = o;
    });
    await flags.parseAsync(['setup'], { from: 'user' });
    expect(seen?.serve).toBeUndefined();
    expect(seen?.harvest).toBeUndefined();
    await flags.parseAsync(['setup', '--serve', '--harvest'], { from: 'user' });
    expect(seen?.serve).toBe(true);
    expect(seen?.harvest).toBe(true);
    await flags.parseAsync(['setup', '--no-harvest'], { from: 'user' });
    expect(seen?.harvest).toBe(false);

    // The real command accepts --harvest (and --yes without it writes nothing to the repo).
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    const io2 = makeIO();
    const program2 = new Command().exitOverride().option('--cwd <dir>');
    registerSetupCommands(program2, io2);
    await program2.parseAsync(['setup', '--yes', '--json', '--clients', 'none', '--no-serve', '--company', 'Acme', '--home', home, '--cwd', cwd], { from: 'user' });
    expect(io2.err).toContain('skipped (not requested); add --harvest');
  });
});

// ---------------------------------------------------------------------------
// Starter packs (step 2)
// ---------------------------------------------------------------------------

describe('runSetup starter packs', () => {
  it('--packs installs exactly the listed packs into the global lexicon and reports them apart from termsAdded', async () => {
    const f = fakes();
    const { code, summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: 'developer, ai' }, f);
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
    expect(summary.packs.map((p) => p.name)).toEqual(['developer', 'ai']);
    expect(summary.packs.every((p) => p.added > 0 && p.merged === 0)).toBe(true);
    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.settings?.packs).toEqual(['developer', 'ai']);
    expect(file.lexicon.terms.filter((t) => t.source === 'pack')).toHaveLength(summary.packs.reduce((n, p) => n + p.added, 0));
    expect(file.lexicon.terms.find((t) => t.canonical === 'Kubernetes')?.source).toBe('pack');
    expect(io.out).toContain('2. Starter packs');
    expect(io.out).toMatch(/installed developer: \d+ added, 0 merged/);
    expect(io.out).toContain('3. Repo harvest');
    expect(io.err).toBe('');

    // A second run with the same list re-adds nothing and says why.
    const again = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: 'developer,ai,business' }, f);
    expect(again.summary.packs.map((p) => p.name)).toEqual(['business']);
    expect(again.io.out).toContain('already installed: developer');
    expect(again.io.out).toContain('already installed: ai');
    expect((await readLexiconFile(globalPath, 'global')).lexicon.settings?.packs).toEqual(['developer', 'ai', 'business']);
  });

  it('--yes without --packs installs nothing and says how to; --no-packs and --packs none skip quietly', async () => {
    const f = fakes();
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(summary.packs).toEqual([]);
    expect(io.out).toContain('skipped (not requested); add --packs developer,ai,voice-tools');
    expect(await fs.readFile(globalPath, 'utf8')).not.toContain('packs:');

    const off = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: false }, f);
    expect(off.io.out).toContain('skipped (--no-packs)');
    const none = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: 'none' }, f);
    expect(none.io.out).toContain('skipped (--packs none)');
    expect(none.summary.packs).toEqual([]);
  });

  it('rejects an unknown pack before anything is written', async () => {
    const f = fakes();
    await expect(run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: 'developer,nope' }, f)).rejects.toThrow(/unknown pack "nope" \(expected one of: ai, business, developer, voice-tools, none\)/);
    expect(existsSync(globalPath)).toBe(false);
  });

  it('a dry run lists the defaults (or the --packs list) in wouldInstallPacks, installs nothing and keeps pack names out of wouldHarvest', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const f = fakes({
      harvest: async () => [
        { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: [], count: 9, suggestedAliases: [] },
        { canonical: 'LexiconStore', category: 'identifier', source: 'harvest:repo', evidence: [], count: 6, suggestedAliases: [] },
      ],
    });
    const defaults = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(defaults.plan?.wouldInstallPacks).toEqual(['developer', 'ai', 'voice-tools']);
    expect(defaults.plan?.wouldHarvest).toEqual(['LexiconStore']);
    expect(defaults.io.out).toContain('would install: developer');
    expect(defaults.io.out).toContain('pass --packs <list>');
    expect(defaults.io.out).toContain('already in the global lexicon: Playwright');
    expect(defaults.io.out).toContain('would install packs: developer, ai, voice-tools');
    expect(existsSync(globalPath)).toBe(false);

    const picked = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: 'business' }, f);
    expect(picked.plan?.wouldInstallPacks).toEqual(['business']);
    expect(picked.plan?.wouldHarvest).toEqual(['Playwright', 'LexiconStore']);
    const off = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: false }, f);
    expect(off.plan?.wouldInstallPacks).toEqual([]);
    expect(off.io.out).toContain('skipped (--no-packs)');
    expect(off.io.out).toContain('would install packs: none');
  });

  it('goes through deps.listPacks / deps.installPack when injected, with global scope', async () => {
    const calls: { name: string; opts: unknown }[] = [];
    const f = fakes({
      listPacks: async () => [
        { name: 'developer', title: 'Dev', description: 'd', version: 1, terms: 2, aliases: 3, path: '/fake/developer.yaml' },
        { name: 'custom', title: 'Custom', description: 'c', version: 1, terms: 1, aliases: 1, path: '/fake/custom.yaml' },
      ],
      installPack: async (name, opts) => {
        calls.push({ name, opts });
        return { pack: { name, title: 'x', description: '', version: 1, terms: 2, aliases: 3, path: '/fake' }, added: 2, merged: 0, path: globalPath, scope: 'global' };
      },
    });
    const { summary } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: 'custom,developer' }, f);
    expect(calls).toEqual([
      { name: 'custom', opts: { cwd, scope: 'global' } },
      { name: 'developer', opts: { cwd, scope: 'global' } },
    ]);
    expect(summary.packs).toEqual([
      { name: 'custom', added: 2, merged: 0 },
      { name: 'developer', added: 2, merged: 0 },
    ]);
    await expect(run({ yes: true, clients: 'none', packs: 'ai' }, f)).rejects.toThrow(/unknown pack "ai" \(expected one of: developer, custom, none\)/);
    // Only the defaults that exist are offered in a plan.
    const planned = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(planned.plan?.wouldInstallPacks).toEqual(['developer']);
  });

  it('interactive: the checklist shows the default packs checked and asks about the others one by one', async () => {
    const calls: string[] = [];
    const p = scripted([
      'y', // person
      'Ashlr.AI', // company
      '', // phonetic
      'n', // another term?
      [1], // packs checklist: developer only
      'y', // also add business?
      [], // clients: none detected -> not asked; this answer is for serve
      'n', // app: handled below
    ]);
    const f = fakes({
      isInteractive: () => true,
      createPrompter: () => p,
      installPack: async (name) => {
        calls.push(name);
        return { pack: { name, title: 'x', description: '', version: 1, terms: 1, aliases: 1, path: '/fake' }, added: 1, merged: 0, path: globalPath, scope: 'global' };
      },
    });
    // No git repo (no harvest prompt), no clients detected, serve prompt answered by '[]' -> confirm reads '' -> default yes.
    p.asked.length = 0;
    const { summary, io } = await run({ app: 'none', serve: false }, f);
    expect(calls).toEqual(['developer', 'business']);
    expect(summary.packs.map((x) => x.name)).toEqual(['developer', 'business']);
    const checklist = p.asked.find((q) => q.includes('starter packs'));
    expect(checklist).toBeDefined();
    expect(p.asked.some((q) => q.includes('also add business'))).toBe(true);
    expect(p.asked.some((q) => q.includes('also add developer'))).toBe(false);
    expect(io.out).toContain('installed developer: 1 added, 0 merged');
  });

  it('interactive: an empty checklist and no to the rest skips the step', async () => {
    const p = scripted(['y', 'Ashlr.AI', '', 'n', [], 'n']);
    const f = fakes({ isInteractive: () => true, createPrompter: () => p });
    const { summary, io } = await run({ app: 'none', serve: false }, f);
    expect(summary.packs).toEqual([]);
    expect(io.out).toContain('skipped; later: lexicon pack add developer');
    expect(await fs.readFile(globalPath, 'utf8')).not.toContain('packs:');
  });

  it('registerSetupCommands wires --packs <list> and --no-packs', async () => {
    const flags = new Command().exitOverride();
    let seen: SetupOptions | undefined;
    flags.command('setup').option('--packs <list>').option('--no-packs').action((o: SetupOptions) => {
      seen = o;
    });
    await flags.parseAsync(['setup'], { from: 'user' });
    expect(seen?.packs).toBeUndefined();
    await flags.parseAsync(['setup', '--packs', 'developer,ai'], { from: 'user' });
    expect(seen?.packs).toBe('developer,ai');
    await flags.parseAsync(['setup', '--no-packs'], { from: 'user' });
    expect(seen?.packs).toBe(false);

    const io = makeIO();
    const program = new Command().exitOverride().option('--cwd <dir>');
    registerSetupCommands(program, io);
    await program.parseAsync(['setup', '--yes', '--json', '--clients', 'none', '--no-serve', '--no-harvest', '--packs', 'voice-tools', '--company', 'Acme', '--home', home, '--cwd', cwd], { from: 'user' });
    const parsed = JSON.parse(io.out) as SetupSummary;
    expect(parsed.packs.map((x) => x.name)).toEqual(['voice-tools']);
    expect(process.exitCode ?? 0).toBe(0);
  });
});
