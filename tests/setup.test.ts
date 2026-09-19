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
import type { SetupDeps, SetupOptions, SetupSummary } from '../src/cli/cmd-setup.js';
import type { InstallOptions } from '../src/cli/cmd-install.js';
import type { IO } from '../src/cli/commands.js';
import type { PromptChoice, Prompter } from '../src/cli/prompt.js';

function makeIO(): IO & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout(s: string) {
      io.out += s;
    },
    stderr(s: string) {
      io.err += s;
    },
  };
  return io;
}

type Answer = string | number | number[];
function scripted(answers: Answer[]): Prompter & { asked: string[]; closed: boolean } {
  const queue = [...answers];
  const next = (question: string): Answer => {
    if (queue.length === 0) throw new Error(`no scripted answer for: ${question}`);
    return queue.shift() as Answer;
  };
  const fake = {
    asked: [] as string[],
    closed: false,
    async ask(question: string, opts?: { default?: string }): Promise<string> {
      fake.asked.push(question);
      const a = String(next(question));
      return a === '' && opts?.default !== undefined ? opts.default : a;
    },
    async confirm(question: string, def = false): Promise<boolean> {
      fake.asked.push(question);
      const a = String(next(question)).toLowerCase();
      return a === '' ? def : a.startsWith('y');
    },
    async choose<T>(question: string, choices: PromptChoice<T>[], opts?: { multi?: boolean }): Promise<T[]> {
      fake.asked.push(question);
      const a = next(question);
      const idx = Array.isArray(a) ? a : [Number(a)];
      if (!opts?.multi && idx.length !== 1) throw new Error('single choice expects one index');
      return idx.map((i) => choices[i - 1].value);
    },
    close(): void {
      fake.closed = true;
    },
  };
  return fake;
}

let home: string;
let cwd: string;
let globalPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-setup-home-'));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-setup-cwd-'));
  globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
  for (const key of ['HOME', 'LEXICON_PATH', 'XDG_CONFIG_HOME']) savedEnv[key] = process.env[key];
  process.env.HOME = home;
  process.env.LEXICON_PATH = globalPath;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(async () => {
  for (const key of ['HOME', 'LEXICON_PATH', 'XDG_CONFIG_HOME']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
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
    installClient: async (client, opts, io) => {
      f.installed.push({ client, opts });
      io.stdout(`   updated ${path.join(home, '.fake', client)}: mcpServers.lexicon\n`);
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

async function run(opts: Partial<SetupOptions>, f: Fakes): Promise<{ code: number; summary: SetupSummary; io: ReturnType<typeof makeIO> }> {
  const io = makeIO();
  const { code, summary } = await runSetup({ cwd, ...opts }, io, f.deps);
  return { code, summary, io };
}

describe('runSetup --yes', () => {
  it('creates the global lexicon, seeds person + company and installs into the selected clients', async () => {
    const f = fakes();
    const { code, summary, io } = await run({ yes: true, clients: 'claude,cursor', company: 'Ashlr.AI', phonetic: 'ASH-ler' }, f);
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
    expect(summary.clients).toEqual([
      { name: 'claude', status: 'installed', detail: expect.stringContaining('mcpServers.lexicon') },
      { name: 'cursor', status: 'installed', detail: expect.stringContaining('mcpServers.lexicon') },
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
    const { code, summary, io } = await run({ yes: true, clients: 'claude,codex,cursor', company: 'Ashlr.AI' }, f);
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
    const { code, summary } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(code).toBe(1);
    expect(summary.serve).toBe('failed');

    const win = fakes({ platform: 'win32' });
    const { summary: s2, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, win);
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
    const { summary, io } = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(harvestArgs).toEqual([cwd, { limit: 10, minCount: 5 }]);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI', 'Playwright', 'Kubernetes']);
    const project = await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project');
    expect(project.lexicon.terms.map((t) => t.canonical)).toEqual(['Playwright', 'Kubernetes']);
    expect(io.out).toContain('added 2 new terms, merged 0');

    // Second run merges instead of duplicating.
    const again = await run({ yes: true, clients: 'none', company: 'Ashlr.AI' }, f);
    expect(again.summary.termsAdded).toEqual([]);
    expect((await readLexiconFile(path.join(cwd, '.lexicon.yaml'), 'project')).lexicon.terms).toHaveLength(2);
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
    expect(Object.keys(parsed).sort()).toEqual(['clients', 'exports', 'lexiconPath', 'serve', 'termsAdded']);
    expect(io.err).toContain('lexicon setup');
    expect(io.err).toContain('claude: installed');
  });

  it('takes the defaults off a terminal without --yes and says so', async () => {
    const f = fakes();
    const { summary, io } = await run({ clients: 'none', company: 'Ashlr.AI' }, f);
    expect(io.out).toContain('no terminal: taking the defaults');
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'Ashlr.AI']);
  });
});

describe('runSetup interactive', () => {
  it('walks every prompt: person, company, phonetic, another term, harvest, clients, serve, app', async () => {
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

  it('Enter everywhere takes the defaults: person yes, suggested company, harvest yes, all clients, serve yes, first app', async () => {
    await fs.mkdir(path.join(cwd, '.git'));
    const exportDir = path.join(home, 'Desktop');
    const p = scripted(['', '', '', '', '', [1, 2], '', 1]);
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
    const { summary } = await run({ exportDir }, f);
    expect(summary.termsAdded).toEqual(['Mason Wyatt', 'ashlrai', 'Playwright']);
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
    exists: (p) => present.includes(p),
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
    expect(found.map((c) => [c.name, c.detected, c.evidence])).toEqual([
      ['claude', true, '/home/u/.claude'],
      ['codex', true, '/opt/bin/codex'],
      ['cursor', true, '/Applications/Cursor.app'],
      ['windsurf', true, '/home/u/.codeium/windsurf'],
      ['gemini', true, '/usr/local/bin/gemini'],
      ['claude-desktop', true, '/home/u/Library/Application Support/Claude'],
      ['vscode', true, '/Applications/Visual Studio Code.app'],
    ]);
  });

  it('reports nothing on an empty machine and ignores /Applications off macOS', async () => {
    const none = await detectClients(ctx([]), '/work');
    expect(none.every((c) => !c.detected)).toBe(true);
    expect(none.map((c) => c.name)).toEqual([...SETUP_CLIENTS]);
    const linux = await detectClients(ctx(['/Applications/Cursor.app', '/home/u/.config/Code'], 'linux'), '/work');
    expect(linux.find((c) => c.name === 'cursor')?.detected).toBe(false);
    expect(linux.find((c) => c.name === 'vscode')?.evidence).toBe('/home/u/.config/Code');
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
});
