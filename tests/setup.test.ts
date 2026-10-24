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
import { loadLexicon, readLexiconFile, readTrustRegistry, shellWord, trustProject } from '../src/core/index.js';
import type { HarvestCandidate } from '../src/core/index.js';
import {
  SETUP_CLIENTS,
  detectClients,
  parseClientList,
  registerSetupCommands,
  runSetup,
  setupApplyCommand,
  suggestCompany,
} from '../src/cli/cmd-setup.js';
import type { SetupDeps, SetupOptions, SetupPlan, SetupSummary } from '../src/cli/cmd-setup.js';
import type { InstallOptions } from '../src/cli/cmd-install.js';
import { runServeInstall } from '../src/cli/cmd-serve.js';
import type { ServeDeps } from '../src/cli/cmd-serve.js';
import { makeIO, quotedForShell, scripted } from './helpers.js';
import { PromptClosedError, onlyStdoutRedirected } from '../src/cli/prompt.js';
import { stepExport } from '../src/cli/setup/steps.js';
import type { Ctx } from '../src/cli/setup/types.js';



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
    // `path.join(x) === p` as well as a raw hit: the `present` fixtures are
    // written POSIX-style ('/Applications/Cursor.app') while detectClients
    // probes with the host's path.join, which is backslashed on Windows.
    exists: (p) =>
      f.present.has(p) ||
      [...f.present].some((x) => path.join(x) === p) ||
      ((p.startsWith(cwd) || p.startsWith(home)) && existsSync(p)),
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
    // The plan's real check resolves this checkout's CLI entry; tests that need it pass serveBlocker: undefined.
    serveBlocker: async () => undefined,
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
    const { summary, io } = await run({ yes: true, clients: 'none' }, f);
    expect(summary.termsAdded).toEqual([]);
    expect(io.out).toContain('already has 3 terms');

    const again = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', reseed: true }, f);
    expect(again.summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
  });

  it('seeds an explicit --company / --person into a lexicon that already has terms, without the guessed defaults', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(
      globalPath,
      'version: 1\nterms:\n  - canonical: A\n    aliases: []\n  - canonical: B\n    aliases: []\n  - canonical: C\n    aliases: []\n',
    );
    // The plan (what setup_lexicon previews) names exactly the names that were passed.
    const planned = await run({ yes: true, dryRun: true, clients: 'none', company: 'Acme Robotics' }, fakes());
    expect(planned.plan?.wouldSeed).toEqual(['Acme Robotics']);

    const company = await run({ yes: true, clients: 'none', company: 'Acme Robotics' }, fakes());
    expect(company.summary.termsAdded).toEqual(['Acme Robotics']);
    const person = await run({ yes: true, clients: 'none', person: 'Jo Smith' }, fakes());
    expect(person.summary.termsAdded).toEqual(['Jo Smith']);
    expect(person.io.out).not.toContain('no company term');

    const file = await readLexiconFile(globalPath, 'global');
    expect(file.lexicon.terms.map((t) => t.canonical)).toEqual(['A', 'B', 'C', 'Acme Robotics', 'Jo Smith']);
    expect(file.lexicon.terms.find((t) => t.canonical === 'Acme Robotics')?.category).toBe('brand');
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
    // Under --json the same failure leads with ok: false (exit 1), as MCP setup_lexicon reports it.
    const failedJson = await run({ yes: true, json: true, clients: 'none', company: 'Ashlr.AI', serve: true }, f);
    expect(failedJson.code).toBe(1);
    expect(JSON.parse(failedJson.io.out)).toMatchObject({ ok: false, serve: 'failed' });

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
    expect(harvestArgs).toEqual([cwd, { limit: 10, minCount: 2 }]);
    expect(summary.termsAdded).toEqual(['Playwright', 'Kubernetes']);
    const project = await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project');
    expect(project.lexicon.terms.map((t) => t.canonical)).toEqual(['Playwright', 'Kubernetes']);
    expect(io.out).toContain('added 2 new terms, merged 0');

    // Second run merges instead of duplicating.
    const again = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', harvest: true }, f);
    expect(again.summary.termsAdded).toEqual([]);
    expect((await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project')).lexicon.terms).toHaveLength(2);
  });

  // Catches: MCP setup_lexicon with harvest: true wrote the repo names and
  // trusted the project file, so a model relaying a yes decided what every
  // later prompt in the repo is rewritten with.
  it('with harvestUntrusted writes the harvest but leaves the project file untrusted, and names it', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const f = fakes({
      harvest: async () => [
        { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: ['package.json'], count: 9, suggestedAliases: ['play right'] },
        { canonical: 'Kubernetes', category: 'product', source: 'harvest:repo', evidence: ['README.md'], count: 6, suggestedAliases: [] },
      ],
    });
    const projectPath = path.join(cwd, '.lexicon.yaml');
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', harvest: true, harvestUntrusted: true }, f);
    expect((await readLexiconFile(projectPath, 'project')).lexicon.terms.map((t) => t.canonical)).toEqual(['Playwright', 'Kubernetes']);
    expect(summary.untrustedProject).toBe(projectPath);
    expect(io.out).toContain('(not trusted: review it and run lexicon trust)');
    expect((await readTrustRegistry({ globalPath })).trusted).toEqual({});
    expect((await loadLexicon({ cwd, globalPath })).projectTrust).toBe('untrusted');
  });

  // Catches: a harvestUntrusted run never pinned, so a project file the user
  // had already trusted read as "changed" after MCP setup_lexicon harvested it.
  it('with harvestUntrusted keeps an already-trusted project file trusted', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const projectPath = path.join(cwd, '.lexicon.yaml');
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n');
    await trustProject(projectPath, { globalPath });
    const f = fakes({
      harvest: async () => [
        { canonical: 'Playwright', category: 'product', source: 'harvest:package', evidence: ['package.json'], count: 9, suggestedAliases: ['play right'] },
      ],
    });
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', harvest: true, harvestUntrusted: true }, f);
    expect((await readLexiconFile(projectPath, 'project')).lexicon.terms.map((t) => t.canonical)).toEqual(['Playwright']);
    expect(summary.untrustedProject).toBeUndefined();
    expect(io.out).toContain('(trusted)');
    expect((await loadLexicon({ cwd, globalPath })).projectTrust).toBe('trusted');
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
    // The rows Wispr Flow imports, one per alias of the two seeded terms.
    const rows = csv.trimEnd().split('\n').length - 1;
    expect(rows).toBeGreaterThan(1);
    expect(io.out).toContain(`lexicon-wispr.csv (${rows} rows)`);
    await expect(run({ yes: true, clients: 'none', app: 'dragon' }, f)).rejects.toThrow(/unknown app "dragon"/);
  });

  // Catches: a rerun wrote over ~/Desktop/lexicon-<app>.<ext> without
  // asking, so a row fixed by hand before importing was lost.
  it('a rerun keeps an export edited by hand: --yes writes the next free name, a terminal asks', async () => {
    const exportDir = path.join(home, 'Desktop');
    const f = fakes();
    await run({ yes: true, clients: 'none', company: 'Ashlr.AI', app: 'wispr', exportDir }, f);
    const file = path.join(exportDir, 'lexicon-wispr.csv');
    const fresh = await fs.readFile(file, 'utf8');

    // The same export again: rewritten in place, no second file.
    const same = await run({ yes: true, clients: 'none', app: 'wispr', exportDir }, f);
    expect(same.summary.exports).toEqual([{ format: 'wispr', path: file }]);
    expect(existsSync(path.join(exportDir, 'lexicon-wispr-2.csv'))).toBe(false);

    const edited = `${fresh}my fix,Ashlr.AI\n`;
    await fs.writeFile(file, edited);
    const kept = await run({ yes: true, clients: 'none', app: 'wispr', exportDir }, f);
    const second = path.join(exportDir, 'lexicon-wispr-2.csv');
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
    expect(await fs.readFile(second, 'utf8')).toBe(fresh);
    expect(kept.summary.exports).toEqual([{ format: 'wispr', path: second }]);
    expect(kept.io.out).toContain('kept');
    expect(kept.io.out).toContain('it differs from this export (no terminal to ask on)');
    expect(kept.io.out).toContain(`lexicon-wispr-2.csv (`);
    // Again: the -2 file already holds this export, so it is reused.
    const again = await run({ yes: true, clients: 'none', app: 'wispr', exportDir }, f);
    expect(again.summary.exports).toEqual([{ format: 'wispr', path: second }]);
    expect(existsSync(path.join(exportDir, 'lexicon-wispr-3.csv'))).toBe(false);

    // The plan says so too.
    const plan = await run({ yes: true, dryRun: true, clients: 'none', app: 'wispr', exportDir }, f);
    expect(plan.plan?.wouldExport).toEqual([{ format: 'wispr', path: path.join(exportDir, 'lexicon-wispr-3.csv') }]);
    expect(plan.io.out).toContain('exists, so it would be kept');

    // On a terminal: asked, default no; a yes replaces it.
    const ask = async (answer: string): Promise<Ctx['summary']> => {
      const io = makeIO();
      const summary: Ctx['summary'] = { lexiconPath: globalPath, termsAdded: [], packs: [], clients: [], serve: 'skipped', exports: [] };
      const ctx = {
        opts: { app: 'wispr', exportDir },
        deps: {},
        say: (t = '') => io.stdout(`${t}\n`),
        warn: (t: string) => io.stderr(`${t}\n`),
        io,
        cwd,
        home,
        platform: 'darwin',
        env: {},
        exists: existsSync,
        exec: () => '',
        prompter: scripted([answer]),
        homeOverridden: true,
        seeded: [],
        packCanonicals: [],
        plannedSeed: [],
        summary,
      } as unknown as Ctx;
      await stepExport(ctx);
      expect((ctx.prompter as ReturnType<typeof scripted>).asked[0]).toContain('exists and differs from this export');
      return summary;
    };
    await fs.writeFile(file, edited);
    expect((await ask('')).exports).toEqual([{ format: 'wispr', path: second }]);
    expect(await fs.readFile(file, 'utf8')).toBe(edited);
    expect((await ask('y')).exports).toEqual([{ format: 'wispr', path: file }]);
    expect(await fs.readFile(file, 'utf8')).toBe(fresh);
  });

  // Catches: `lexicon setup | tee log` (stdin a terminal, stdout a pipe)
  // took every default under a "(no terminal ...)" line sent into the pipe,
  // with no word of why on stderr or how to answer the questions.
  it('says on stderr that stdout is why the defaults were taken', async () => {
    expect(onlyStdoutRedirected({ stdin: { isTTY: true }, stdout: { isTTY: false } })).toBe(true);
    expect(onlyStdoutRedirected({ stdin: { isTTY: true }, stdout: { isTTY: true } })).toBe(false);
    expect(onlyStdoutRedirected({ stdin: {}, stdout: {} })).toBe(false);
    const f = fakes();
    delete f.deps.isInteractive;
    const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    try {
      const { io } = await run({ clients: 'none', serve: false, packs: false, harvest: false }, f);
      expect(io.err).toContain('lexicon setup: stdout is not a terminal (piped or redirected), so no questions were asked and the defaults were taken, as with --yes.');
      expect(io.out).toContain('(stdout is not a terminal: taking the defaults, as with --yes)');
      expect(io.out).not.toContain('(no terminal:');
    } finally {
      if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
      if (stdout) Object.defineProperty(process.stdout, 'isTTY', stdout);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  it('says "1 row", not "1 rows", for a one-row export', async () => {
    const exportDir = path.join(home, 'Desktop');
    const noGit = fakes({
      exec: () => {
        throw new Error('no git');
      },
    });
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n  - canonical: A\n    aliases: []\n  - canonical: B\n    aliases: []\n');
    const { io } = await run({ yes: true, clients: 'none', app: 'wispr', exportDir }, noGit);
    expect(io.out).toContain('lexicon-wispr.csv (1 row)');
  });

  it('rejects bad --clients / --app before touching anything', async () => {
    const f = fakes();
    await expect(run({ yes: true, clients: 'emacs' }, f)).rejects.toThrow(/unknown client "emacs"/);
    await expect(run({ yes: true, clients: 'none', app: 'dragon' }, f)).rejects.toThrow(/unknown app "dragon"/);
    expect(existsSync(globalPath)).toBe(false);
  });

  // Catches: a 100-character --company created the lexicon, then failed at the
  // write on canonical, aliases[0] and aliases[1]; a dry run planned it as seeded.
  it('refuses a blank, multi-line or over-cap --company / --person up front, in a dry run too', async () => {
    const f = fakes();
    for (const dryRun of [false, true]) {
      await expect(run({ yes: true, dryRun, clients: 'none', company: 'x'.repeat(100) }, f)).rejects.toThrow(
        /^--company must be at most 80 characters \(it has 100\); nothing was written/,
      );
      await expect(run({ yes: true, dryRun, clients: 'none', company: '   ' }, f)).rejects.toThrow(/^--company must not be blank/);
      await expect(run({ yes: true, dryRun, clients: 'none', person: 'Mason\nWyatt' }, f)).rejects.toThrow(
        /^--person must be one line, with no control characters/,
      );
      await expect(run({ yes: true, dryRun, clients: 'none', company: 'Ashlr\uFFFE' }, f)).rejects.toThrow(
        /^--company must not contain U\+FFFE \(U\+FFFE, U\+FFFF and unpaired surrogates fit no file format\); nothing was written/,
      );
      await expect(run({ yes: true, dryRun, clients: 'none', company: 'Ashlr.AI', phonetic: 'ASH\uD800' }, f)).rejects.toThrow(
        /^--phonetic must not contain U\+D800/,
      );
    }
    expect(existsSync(globalPath)).toBe(false);
    expect(f.installed).toEqual([]);
    // At the cap is fine.
    const ok = await run({ yes: true, dryRun: true, clients: 'none', company: ` ${'x'.repeat(80)} ` }, f);
    expect(ok.code).toBe(0);
  });

  // Catches: a multi-line or over-cap --phonetic created the lexicon and
  // seeded the person term, then failed at the company write.
  it('refuses a multi-line or over-cap --phonetic up front, in a dry run too', async () => {
    const f = fakes();
    for (const dryRun of [false, true]) {
      await expect(run({ yes: true, dryRun, clients: 'none', company: 'Ashlr.AI', phonetic: 'ASH\nler' }, f)).rejects.toThrow(
        /^--phonetic must be one line, with no control characters; nothing was written/,
      );
      await expect(run({ yes: true, dryRun, clients: 'none', company: 'Ashlr.AI', phonetic: 'x'.repeat(201) }, f)).rejects.toThrow(
        /^--phonetic must be at most 200 characters \(it has 201\); nothing was written/,
      );
    }
    expect(existsSync(globalPath)).toBe(false);
    expect(f.installed).toEqual([]);
  });

  it('--json prints only the summary on stdout and progress on stderr', async () => {
    const f = fakes();
    const { summary, io } = await run({ yes: true, json: true, clients: 'claude', company: 'Ashlr.AI' }, f);
    const parsed = JSON.parse(io.out) as SetupSummary & { ok: boolean };
    // Catches: the success document had no `ok`, while the refusal is `{ ok: false, error }`.
    expect(parsed).toEqual({ ok: true, ...summary });
    expect(Object.keys(parsed)[0]).toBe('ok');
    expect(Object.keys(parsed).sort()).toEqual(['clients', 'demo', 'exports', 'lexiconPath', 'nextStep', 'ok', 'packs', 'serve', 'termsAdded']);
    expect(io.err).toContain('lexicon setup');
    expect(io.err).toContain('claude: installed');
    // The run ends in a correction the caller can show, not just a file list.
    expect(parsed.demo?.corrected).toContain('Ashlr.AI');
    expect(parsed.demo?.heard).not.toBe(parsed.demo?.corrected);
  });

  // Catches: the Next line went to stderr under --json and the summary had no
  // nextStep, so an agent reading stdout never saw the "add a name" step.
  it('--json carries the Next line as nextStep, and forAgent names add_term with no CLI flags', async () => {
    const noName = (): Fakes =>
      fakes({
        exec: (file) => {
          if (file === 'git') throw new Error('exit 1');
          throw new Error(`unexpected exec: ${file}`);
        },
      });
    const json = await run({ yes: true, json: true, clients: 'none', packs: false, harvest: false }, noName());
    expect(json.io.err).toContain('Next: add a name you dictate: lexicon add "Your Co" --suggest');
    expect((JSON.parse(json.io.out) as SetupSummary).nextStep).toBe('add a name you dictate: lexicon add "Your Co" --suggest (then open your agent and say it in a sentence)');

    const named = await run({ yes: true, json: true, clients: 'claude', company: 'Ashlr.AI' }, fakes());
    expect(named.summary.nextStep).toBe('open Claude Code and dictate a sentence with "Ashlr.AI" in it');
    // The text output has the same step on its Next line.
    const text = await run({ yes: true, clients: 'claude', company: 'Ashlr.AI' }, fakes());
    expect(text.io.out).toContain('Next: open Claude Code and dictate a sentence with "Ashlr.AI" in it');
    expect(text.summary.nextStep).toBe(named.summary.nextStep);

    await fs.rm(globalPath, { force: true });
    const agent = await run({ yes: true, json: true, clients: 'none', harvest: false, forAgent: true }, noName());
    expect(agent.summary.nextStep).toBe(
      'Ask the user for a name they dictate (their company, product or a teammate) and add it with add_term; then ask them to dictate a sentence with it in it.',
    );
    // The progress (with its `add --packs developer,ai,voice-tools` hint) is not written for an agent.
    expect(agent.io.err).toBe('');
    expect(agent.io.out).not.toMatch(/--packs|--harvest|--serve/);
    expect(JSON.parse(agent.io.out)).toMatchObject({ ok: true, nextStep: agent.summary.nextStep });
    const plan = await run({ yes: true, json: true, dryRun: true, clients: 'none', forAgent: true }, noName());
    expect(plan.io.err).toBe('');
    // A failure still reaches stderr, with the retry as a tool call.
    const failing = fakes({ installClient: async () => 1, installServe: async () => 1 });
    const failed = await run({ yes: true, json: true, clients: 'claude', serve: true, company: 'Ashlr.AI', forAgent: true }, failing);
    expect(failed.io.err).toContain('(retry with: install_client with client: "claude" and apply: true)');
    expect(failed.io.err).toContain('(retry with: setup_lexicon with apply: true and serve: true)');
    expect(failed.io.err).not.toContain('lexicon install');
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
      // `isInteractive` is false in these fakes, so a real run with these flags
      // would not prompt for anything and the plan promises nothing it cannot do.
      interactive: false,
      wouldAsk: [],
      lexiconPath: globalPath,
      lexiconExists: false,
      wouldSeed: ['Mason Wyatt', 'Ashlr.AI'],
      wouldInstallPacks: ['developer', 'ai', 'voice-tools'],
      packsOnOffer: ['developer', 'ai', 'voice-tools'],
      packsToInstall: [],
      wouldHarvest: [],
      detectedClients: ['claude', 'codex', 'cursor'],
      wouldInstallClients: ['claude', 'codex', 'cursor'],
      wouldInstallServe: true,
      wouldExport: [{ format: 'wispr', path: path.join(exportDir, 'lexicon-wispr.csv') }],
      // A dry run writes nothing, so it demonstrates on the terms step 1 would
      // seed: the plan carries the same correction a real run would show.
      demo: {
        heard: 'can you ask Mason Wiatt where the Ashler migration landed',
        corrected: 'can you ask Mason Wyatt where the Ashlr.AI migration landed',
        terms: ['Mason Wyatt', 'Ashlr.AI'],
        usedExample: false,
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

  // Catches: from a plugin or npx install the plan said wouldInstallServe: true, the
  // agent asked the user, and the real run then refused the login service.
  it('a plan from a plugin cache says the login service would be refused, and how to fix it', async () => {
    const pluginCli = path.join(home, '.claude', 'plugins', 'cache', 'ashlr', 'lexicon', '0.5.6', 'dist', 'cli');
    const f = fakes({ cliDir: pluginCli, serveBlocker: undefined });
    const { code, plan, io } = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', serve: true }, f);
    expect(code).toBe(0);
    expect(plan?.wouldInstallServe).toBe(false);
    expect(plan?.serveBlocked).toContain('Claude Code plugin cache');
    expect(plan?.serveBlocked).toContain('npm i -g @ashlr/lexicon');
    expect(io.out).toContain('login service: would not install (this copy is running from an npx or Claude Code plugin cache');
    expect(f.serveCalls).toBe(0);
    // Not asked for: nothing to report.
    const quiet = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, fakes({ cliDir: pluginCli, serveBlocker: undefined }));
    expect(quiet.plan?.serveBlocked).toBeUndefined();
  });

  it('describes the run that would actually happen: the prompts, and what Enter does to them', async () => {
    // The dry run is the flag a cautious stranger reaches for first, so it has
    // to describe this same command without --dry-run. On a terminal that run
    // stops four more times, and two of those questions install a login
    // service and write a file to the Desktop: reporting them as "skipped" is
    // the opposite of what matters.
    await fs.mkdir(path.join(cwd, '.git'));
    const f = fakes(
      {
        isInteractive: () => true,
        harvest: async () => [
          { canonical: 'Fernwold', category: 'brand', source: 'harvest:repo', evidence: ['README.md'], count: 2, suggestedAliases: [] },
        ],
      },
      [path.join(home, '.claude'), path.join(home, 'Desktop')],
    );
    const { plan, io } = await run({ dryRun: true, company: 'Ashlr.AI' }, f);
    expect(plan?.interactive).toBe(true);
    expect(plan?.wouldAsk).toEqual(['packs', 'harvest', 'clients', 'serve', 'export']);
    // Taking every default installs the service and writes the export...
    expect(plan?.wouldInstallServe).toBe(true);
    expect(plan?.wouldExport).toEqual([{ format: 'wispr', path: path.join(home, 'Desktop', 'lexicon-wispr.csv') }]);
    expect(io.out).toContain('login service: asks (default yes)');
    expect(io.out).toContain('dictation export: asks which app');
    expect(io.out).toContain('lexicon-wispr.csv');
    // ...but not the repo harvest, whose prompt defaults to no.
    expect(plan?.wouldHarvest).toEqual(['Fernwold']);
    expect(io.out).toContain('repo harvest: asks (default no)');
    expect(io.out).toContain('starter packs: asks');
    expect(io.out).toContain('Enter at every prompt');
    expect(existsSync(globalPath)).toBe(false);
  });

  it('describes a non-interactive run as the opt-in one it is', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const f = fakes({
      harvest: async () => [
        { canonical: 'Fernwold', category: 'brand', source: 'harvest:repo', evidence: ['README.md'], count: 2, suggestedAliases: [] },
      ],
    });
    const { plan, io } = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(plan?.interactive).toBe(false);
    expect(plan?.wouldAsk).toEqual([]);
    expect(plan?.wouldInstallServe).toBe(false);
    expect(plan?.wouldExport).toEqual([]);
    // The names are still on offer for a caller to show; nothing would be written.
    expect(plan?.wouldHarvest).toEqual(['Fernwold']);
    expect(io.out).toContain('repo harvest: nothing added (--harvest adds them)');
    expect(io.out).toContain('login service: skipped (--serve installs it)');
    expect(io.out).toContain('nothing here is prompted for');
  });

  // Catches: with --no-harvest the plan said "repo harvest: nothing to add",
  // as if the repo had been scanned and held no names, while the run itself
  // says "skipped (--no-harvest)".
  it('a dry run with --no-harvest says the harvest is skipped, as the run does', async () => {
    const f = fakes({
      harvest: async () => [
        { canonical: 'Fernwold', category: 'brand', source: 'harvest:repo', evidence: ['README.md'], count: 2, suggestedAliases: [] },
      ],
    });
    const { io } = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', harvest: false }, f);
    expect(io.out).toContain('repo harvest: skipped (--no-harvest)');
    expect(io.out).not.toContain('repo harvest: nothing to add');
  });

  // Catches: the plan card ended "run again without --dry-run to apply", so the
  // reader had to rebuild a command with a quoted company name and five flags.
  it('ends with the exact command that applies it, keeping the flags this run was given', async () => {
    const { io } = await run(
      { yes: true, dryRun: true, clients: 'none', company: "Ashlr's AI", phonetic: 'ASH-ler', packs: false, harvest: false, serve: true, app: 'none' },
      fakes(),
    );
    expect(io.out).toContain(
      `to apply, run: lexicon --cwd ${shellWord(cwd)} setup --yes --clients none --company ${quotedForShell("Ashlr's AI")} --phonetic ASH-ler --app none --no-packs --no-harvest --serve\n`,
    );
    // An interactive dry run names the interactive command: no --yes was given.
    const asked = await run({ dryRun: true }, fakes({ isInteractive: () => true }));
    expect(asked.io.out).toMatch(new RegExp(`to apply, run: lexicon --cwd \\S+ setup\\n`));
  });

  // Catches: the command was capped at 200 characters like any displayed
  // text, so a long --cwd or --export-dir printed a command cut with an ellipsis.
  it('names the whole apply command, however long the paths', () => {
    const deep = path.join(cwd, ...Array.from({ length: 8 }, (_, i) => `a-rather-long-directory-name-${i}`));
    const command = setupApplyCommand({ cwd: deep, yes: true, exportDir: deep, packs: false });
    expect(command).toBe(`lexicon --cwd ${shellWord(deep)} setup --yes --export-dir ${shellWord(deep)} --no-packs`);
    expect(command.length).toBeGreaterThan(400);
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
    expect(JSON.parse(io.out)).toEqual({ ok: true, ...plan });
    expect(io.err).toContain('dry run');
  });
});

describe('runSetup dictation export', () => {
  // Catches: the export step wrote with exportLexicon, so a pair the format
  // left out (a cell a spreadsheet would run as a formula) vanished without
  // a word, and the line counted terms rather than the rows the app imports.
  it('names what the export left out and counts the rows written', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler, "=Ashlar"]\n  - canonical: A\n    aliases: []\n  - canonical: B\n    aliases: []\n');
    const exportDir = path.join(home, 'out');
    const f = fakes();
    const { code, summary, io } = await run({ yes: true, clients: 'none', app: 'wispr', exportDir }, f);
    expect(code).toBe(0);
    const file = path.join(exportDir, 'lexicon-wispr.csv');
    expect(summary.exports).toEqual([{ format: 'wispr', path: file }]);
    expect(await fs.readFile(file, 'utf8')).toBe('word,replacement\nAshler,Ashlr.AI\n');
    expect(io.out).toMatch(/wrote .*lexicon-wispr\.csv \(1 row\)/);
    expect(io.err).toContain('left out 1 pair a spreadsheet would run as a formula');
    expect(io.err).toContain('"=Ashlar -> Ashlr.AI"');
  });
});

describe('runSetup interactive', () => {
  // Catches: ctrl-C or ctrl-D at a prompt surfaced as `input closed before
  // the prompt was answered` and exit 1, with no word of what the steps
  // before it had already written (a created lexicon, seeded terms).
  it('a prompt cancelled mid-run stops there and says what was already written', async () => {
    const answers = scripted([
      'y', // add "Mason Wyatt" as a person term?
      'Ashlr.AI', // company
      '', // phonetic hint
      'n', // add another term?
    ]);
    // The starter pack checklist is where the input closes.
    const p = { ...answers, choose: async (): Promise<never> => { throw new PromptClosedError(); } };
    const f = fakes({ isInteractive: () => true, createPrompter: () => p });
    const { code, summary, io } = await run({}, f);
    expect(code).toBe(1);
    expect(summary.stoppedAt).toBe('Starter packs');
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
    expect(io.out).toContain('Stopped at "Starter packs" (the prompt was cancelled); nothing after it ran.');
    expect(io.out).toContain('terms added: Mason Wyatt, Ashlr.AI');
    expect(io.out).toContain('Next: run lexicon setup again to finish; every step skips what is already done');
    expect(io.out).not.toContain('3. Repo harvest');
    expect(io.out).not.toContain('Done.');
    expect(f.installed).toEqual([]);
    expect(f.serveCalls).toBe(0);
    expect((await readLexiconFile(globalPath, 'global')).lexicon.terms.map((t) => t.canonical)).toEqual(['Mason Wyatt', 'Ashlr.AI']);
  });

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
    expect(io.out).toContain('one by one with: lexicon harvest --interactive');
    expect(f.installed.map((i) => i.client)).toEqual(['claude']);
    expect(summary.serve).toBe('installed');
    expect(summary.exports).toEqual([{ format: 'superwhisper', path: path.join(exportDir, 'lexicon-superwhisper.json') }]);
    expect(p.asked[1]).toContain('company or product name');
    expect(p.closed).toBe(false); // the caller owns an injected prompter
  });

  // Catches: a company, extra term or hint typed at the prompt skipped the
  // checks --company and --phonetic get, so an over-cap name or a hint with a
  // control character failed setup at the write, after the lexicon was created
  // and the person term seeded.
  it('asks again for a typed name or hint the write would refuse, before writing it', async () => {
    const p = scripted([
      'y', // add "Mason Wyatt" as a person term?
      'x'.repeat(100), // company: over the cap -> asked again
      'Ashlr.AI',
      'ASH\u0007ler', // phonetic: a control character -> asked again
      'ASH-ler',
      'y', // add another term?
      'y'.repeat(81), // name: over the cap -> asked again
      'Locus',
      'z'.repeat(201), // hint: over the cap -> asked again
      '', // Enter: no hint
      'product',
      'n', // add another term?
    ]);
    const f = fakes({ isInteractive: () => true, createPrompter: () => p });
    const { code, summary, io } = await run({ clients: 'none', packs: false, harvest: false, serve: false, app: 'none' }, f);
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI', 'Locus']);
    const terms = (await readLexiconFile(globalPath, 'global')).lexicon.terms;
    expect(terms.find((t) => t.canonical === 'Ashlr.AI')?.phonetic).toBe('ASH-ler');
    expect(terms.find((t) => t.canonical === 'Locus')?.phonetic).toBeUndefined();
    expect(io.out).toContain('the name must be at most 80 characters (it has 100); type it again (Enter to skip)');
    expect(io.out).toContain('the hint must be one line, with no control characters; type it again (Enter to skip)');
    expect(io.out).toContain('the name must be at most 80 characters (it has 81)');
    expect(io.out).toContain('the hint must be at most 200 characters (it has 201)');
    expect(p.asked.filter((q) => q.includes('company or product name'))).toHaveLength(2);
  });

  it('Enter everywhere takes the defaults: person yes, suggested company, default packs, harvest NO, all clients, serve yes, first app', async () => {
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
    const { summary, io } = await run({ exportDir }, f);
    expect(summary.packs.map((x) => x.name)).toEqual(['developer', 'ai', 'voice-tools']);
    expect(summary.packs.every((x) => x.added > 0 && x.merged === 0)).toBe(true);
    // Step 3 is the one prompt whose default is no: a stranger pressing Enter
    // through the wizard does not end up with the repo's names rewriting their
    // prose, and nothing is written inside their repository.
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'ashlrai']);
    expect(existsSync(path.join(cwd, '.lexicon.yaml'))).toBe(false);
    expect(io.out).toContain('skipped; add them later');
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

  // Catches: `setup --json --app nope` printed the refusal on stderr only, leaving stdout empty.
  it('registerSetupCommands prints { ok: false, error } under --json when setup refuses', async () => {
    const io = makeIO();
    const program = new Command().exitOverride().option('--cwd <dir>');
    registerSetupCommands(program, io);
    const saved = process.exitCode;
    try {
      await program.parseAsync(['setup', '--yes', '--json', '--app', 'nope', '--clients', 'none', '--cwd', cwd], { from: 'user' });
      expect(JSON.parse(io.out)).toEqual({ ok: false, error: expect.stringContaining('unknown app "nope"'), nextStep: expect.stringContaining('lexicon setup --json again') });
      expect(io.err).toContain('lexicon: unknown app "nope"');
      expect(process.exitCode).toBe(1);
      expect(existsSync(globalPath)).toBe(false);

      const plain = makeIO();
      const p2 = new Command().exitOverride().option('--cwd <dir>');
      registerSetupCommands(p2, plain);
      await expect(p2.parseAsync(['setup', '--yes', '--app', 'nope', '--cwd', cwd], { from: 'user' })).rejects.toThrow('unknown app');
      expect(plain.out).toBe('');
    } finally {
      process.exitCode = saved;
    }
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
    expect(again.io.out).toContain('already installed: developer, ai');
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

  it('a dry run demonstrates the correction the real run shows, on the terms it would seed', async () => {
    const opts = { yes: true, clients: 'none', company: 'Ashlr', harvest: false } as const;
    const planned = await run({ ...opts, dryRun: true }, fakes());
    expect(planned.plan?.demo?.usedExample).toBe(false);
    expect(planned.io.out).not.toContain('built-in example terms');
    const real = await run(opts, fakes());
    expect(real.summary.demo).toEqual(planned.plan?.demo);
  });

  // Catches: when the seeded name had no misspelling to show, the demo fell
  // back to the example terms and said `lexicon add "Your Co" --suggest`,
  // a placeholder, though the user had just given the company name.
  it('the example fallback names the term this run seeds, not a "Your Co" placeholder', async () => {
    const opts = { yes: true, clients: 'none', company: 'Acme', harvest: false } as const;
    for (const dryRun of [true, false]) {
      // No git user.name, so Acme (which has no likely misspelling) is the only seed.
      const noGitName = fakes({
        exec: (file, args) => {
          if (file === 'git' && args.includes('get-url')) return 'https://github.com/ashlrai/lexicon.git';
          throw new Error(`no ${args.join(' ')}`);
        },
      });
      await fs.rm(globalPath, { force: true });
      const { io, plan, summary } = await run({ ...opts, dryRun }, noGitName);
      expect((dryRun ? plan?.demo : summary.demo)?.usedExample, String(dryRun)).toBe(true);
      expect(io.out).toContain('add one now, what speech-to-text writes for it: lexicon add "Acme" "<misspelling>"');
      expect(io.out).not.toContain('Your Co');
    }
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
    // The packs are on offer, not on their way in: --yes alone installs none,
    // and both the step line and the plan card have to say so.
    expect(defaults.io.out).toContain('would install: none (pass --packs developer,ai,voice-tools');
    expect(defaults.io.out).toContain('already in the global lexicon: Playwright');
    expect(defaults.io.out).toContain('starter packs: none (--packs developer,ai,voice-tools installs the defaults)');
    expect(existsSync(globalPath)).toBe(false);

    const picked = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: 'business' }, f);
    expect(picked.plan?.wouldInstallPacks).toEqual(['business']);
    expect(picked.plan?.wouldHarvest).toEqual(['Playwright', 'LexiconStore']);
    const off = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: false }, f);
    expect(off.plan?.wouldInstallPacks).toEqual([]);
    expect(off.io.out).toContain('skipped (--no-packs)');
    expect(off.io.out).toContain('starter packs: none');
  });

  it('a dry run says in packsToInstall what the same call installs, agreeing with its would install line', async () => {
    // wouldInstallPacks is the set on offer: under --yes it named three packs
    // while the line said `would install: none`, and an agent reading the
    // JSON told the user they were on their way in.
    const f = fakes();
    const defaults = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(defaults.plan?.packsOnOffer).toEqual(['developer', 'ai', 'voice-tools']);
    expect(defaults.plan?.packsToInstall).toEqual([]);
    expect(defaults.io.out).toContain('would install: none (pass --packs developer,ai,voice-tools');

    const picked = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: 'business' }, f);
    expect(picked.plan?.packsToInstall).toEqual(['business']);
    expect(picked.plan?.packsOnOffer).toEqual(['business']);
    expect(picked.io.out).toContain('would install: business');

    const none = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: 'none' }, f);
    expect(none.plan?.packsToInstall).toEqual([]);

    const off = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: false }, f);
    expect(off.plan?.packsOnOffer).toEqual([]);
    expect(off.plan?.packsToInstall).toEqual([]);

    // On a terminal, Enter at the checklist installs the checked defaults.
    const asked = await run({ dryRun: true, clients: 'none', company: 'Ashlr.AI' }, fakes({ isInteractive: () => true }));
    expect(asked.plan?.wouldAsk).toContain('packs');
    expect(asked.plan?.packsToInstall).toEqual(['developer', 'ai', 'voice-tools']);
  });

  it('a rerun leaves installed packs out of the plan and reports them instead', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nsettings:\n  packs: [developer, ai]\nterms: []\n');
    const f = fakes();
    const planned = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(planned.plan?.wouldInstallPacks).toEqual(['voice-tools']);
    expect(planned.plan?.alreadyInstalledPacks).toEqual(['developer', 'ai']);
    expect(planned.io.out).toContain('already installed: developer, ai');
    const explicit = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: 'ai,business' }, f);
    expect(explicit.plan?.wouldInstallPacks).toEqual(['business']);
    // A fresh lexicon has nothing installed and says nothing about it.
    await fs.rm(globalPath);
    const fresh = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(fresh.plan?.alreadyInstalledPacks).toBeUndefined();
    expect(fresh.io.out).not.toContain('already installed');
  });

  it('seeds the person from repo-level git config or GIT_AUTHOR_NAME when no global user.name is set', async () => {
    const noGlobal = (local: string | undefined, env: NodeJS.ProcessEnv = { PATH: '/fake/bin' }): Fakes =>
      fakes({
        env,
        exec: (file, args) => {
          if (file === 'git' && args.join(' ') === 'config --global user.name') throw new Error('exit 1');
          if (file === 'git' && args.join(' ') === `-C ${cwd} config user.name` && local) return local;
          if (file === 'git') throw new Error('exit 1');
          throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
        },
      });
    const viaRepo = await run({ yes: true, clients: 'none', packs: false, harvest: false }, noGlobal('Zoë Local'));
    expect(viaRepo.summary.termsAdded).toEqual(['Zoë Local']);
    const planned = await run({ yes: true, dryRun: true, clients: 'none', packs: false, reseed: true }, noGlobal(undefined, { PATH: '', GIT_AUTHOR_NAME: 'Ada Author' }));
    expect(planned.plan?.wouldSeed).toEqual(['Ada Author']);
    const nothing = await run({ yes: true, dryRun: true, clients: 'none', packs: false, reseed: true }, noGlobal(undefined));
    expect(nothing.plan?.wouldSeed).toEqual([]);
    expect(nothing.io.out).toContain('pass --person "Your Name" and --company "Your Co"');
  });

  it('skips a git user.name the write would refuse (too long, control characters) with a note instead of failing after the lexicon was created', async () => {
    for (const bad of ['x'.repeat(500), 'Mason\u0007Wyatt']) {
      await fs.rm(globalPath, { force: true });
      const f = fakes({
        exec: (file, args) => {
          if (file === 'git' && args.join(' ') === 'config --global user.name') return bad;
          if (file === 'git') throw new Error('exit 1');
          throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
        },
      });
      // The plan agrees: only the company would be seeded.
      const planned = await run({ yes: true, dryRun: true, clients: 'none', company: 'Ashlr.AI', packs: false }, f);
      expect(planned.plan?.wouldSeed).toEqual(['Ashlr.AI']);
      expect(planned.io.out).toMatch(/skipped the person term: git user\.name must be/);
      const { code, summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI', packs: false, harvest: false }, f);
      expect(code).toBe(0);
      expect(summary.termsAdded).toEqual(['Ashlr.AI']);
      expect(io.out).toMatch(/skipped the person term: git user\.name must be/);
      expect(io.out).toContain('pass --person "Your Name"');
      expect(io.out).not.toContain('git user.name is unset');
    }
  });

  it('skips a guessed company the write would refuse (too long) with a note instead of failing after the person was seeded', async () => {
    const longOrg = 'a'.repeat(120);
    const f = fakes({
      exec: (file, args) => {
        if (file === 'git' && args.join(' ') === 'config --global user.name') return 'Mason Wyatt';
        if (file === 'git' && args.join(' ') === `-C ${cwd} remote get-url origin`) return `https://github.com/${longOrg}/repo.git`;
        if (file === 'git') throw new Error('exit 1');
        throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
      },
    });
    // The plan agrees: only the person would be seeded.
    const planned = await run({ yes: true, dryRun: true, clients: 'none', packs: false }, f);
    expect(planned.plan?.wouldSeed).toEqual(['Mason Wyatt']);
    expect(planned.io.out).toMatch(/skipped the company term: the guessed name must be at most 80 characters/);
    const { code, summary, io } = await run({ yes: true, clients: 'none', packs: false, harvest: false }, f);
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual(['Mason Wyatt']);
    expect(io.out).toMatch(/skipped the company term: the guessed name must be at most 80 characters/);
    expect(io.out).toContain('pass --company "Your Co"');
    expect(io.out).not.toContain('no company term (add one later');
  });

  // Catches: on a terminal the note said "pass --company" right before the
  // company prompt appeared, naming a flag the user no longer needed.
  it('on a terminal, a refused company guess points at the prompt that follows, not at --company', async () => {
    const longOrg = 'a'.repeat(120);
    const terminal = (p: ReturnType<typeof scripted>) =>
      fakes({
        isInteractive: () => true,
        createPrompter: () => p,
        exec: (file, args) => {
          if (file === 'git' && args.join(' ') === 'config --global user.name') return 'Mason Wyatt';
          if (file === 'git' && args.join(' ') === `-C ${cwd} remote get-url origin`) return `https://github.com/${longOrg}/repo.git`;
          if (file === 'git') throw new Error('exit 1');
          throw new Error(`unexpected exec: ${file} ${args.join(' ')}`);
        },
      });
    const p = scripted(['y', 'Acme', '', 'n']);
    const f = terminal(p);
    const { code, summary, io } = await run({ clients: 'none', packs: false, harvest: false, app: 'none', serve: false }, f);
    expect(code).toBe(0);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Acme']);
    expect(io.out).toMatch(/not suggesting the guessed company name: it must be at most 80 characters \(it has 120\); type the name you want at the prompt below \(Enter to skip\)/);
    expect(io.out).not.toContain('pass --company');
    expect(p.asked.some((q) => q.includes('Your company or product name'))).toBe(true);
    // Enter at the prompt still says how to add one later.
    const skip = scripted(['y', '', 'n']);
    const skipped = await run({ clients: 'none', packs: false, harvest: false, app: 'none', serve: false }, terminal(skip));
    expect(skipped.io.out).toContain('no company term (add one later: lexicon add "Your Co" --category brand)');
  });

  it('goes through deps.listPacks / deps.installPack when injected, with global scope', async () => {
    const calls: { name: string; opts: unknown }[] = [];
    const f = fakes({
      listPacks: async () => [
        { name: 'developer', title: 'Dev', description: 'd', version: 1, author: '', homepage: '', terms: 2, aliases: 3, path: '/fake/developer.yaml' },
        { name: 'custom', title: 'Custom', description: 'c', version: 1, author: '', homepage: '', terms: 1, aliases: 1, path: '/fake/custom.yaml' },
      ],
      installPack: async (name, opts) => {
        calls.push({ name, opts });
        return { pack: { name, title: 'x', description: '', version: 1, author: '', homepage: '', terms: 2, aliases: 3, path: '/fake' }, added: 2, merged: 0, path: globalPath, scope: 'global' };
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
        return { pack: { name, title: 'x', description: '', version: 1, author: '', homepage: '', terms: 1, aliases: 1, path: '/fake' }, added: 1, merged: 0, path: globalPath, scope: 'global' };
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
