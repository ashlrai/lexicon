import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LexiconFile } from '../src/core/types.js';
import { runTrust, runUntrust } from '../src/cli/cmd-trust.js';
import { PromptClosedError } from '../src/cli/prompt.js';
import type { Prompter } from '../src/cli/prompt.js';
import { makeIO, scripted } from './helpers.js';
import {
  TRUST_ALL_ENV,
  TRUST_PREVIEW_ROWS,
  trustPreview,
  getTrustPath,
  hashFile,
  isTrusted,
  listTrusted,
  readTrustRegistry,
  refreshTrust,
  trustAllEnabled,
  trustProject,
  untrustProject,
} from '../src/core/trust.js';

let tmp: string;
let globalPath: string;
let projectPath: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['LEXICON_PATH', 'XDG_CONFIG_HOME', TRUST_ALL_ENV];

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-trust-')));
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  projectPath = path.join(tmp, 'repo', '.lexicon.yaml');
  await fs.mkdir(path.dirname(projectPath), { recursive: true });
  await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function file(p: string, exists = true): LexiconFile {
  return { path: p, scope: 'project', lexicon: { version: 1, terms: [] }, exists };
}

describe('getTrustPath', () => {
  it('sits next to the global lexicon, following globalPath / LEXICON_PATH / XDG', () => {
    expect(getTrustPath({ globalPath })).toBe(path.join(tmp, 'config', 'trust.json'));
    process.env.LEXICON_PATH = '/custom/dir/lex.yaml';
    expect(getTrustPath()).toBe(path.join('/custom/dir', 'trust.json'));
    delete process.env.LEXICON_PATH;
    process.env.XDG_CONFIG_HOME = '/xdg';
    expect(getTrustPath()).toBe(path.join('/xdg', 'lexicon', 'trust.json'));
  });
});

describe('trustProject / isTrusted', () => {
  it('is untrusted until trusted, then round-trips through the registry file', async () => {
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');

    const entry = await trustProject(projectPath, { globalPath });
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sha256).toBe(await hashFile(projectPath));
    expect(entry.trustedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');

    const raw = JSON.parse(await fs.readFile(getTrustPath({ globalPath }), 'utf8')) as {
      version: number;
      trusted: Record<string, { sha256: string; trustedAt: string }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.trusted[projectPath]).toEqual(entry);
    await expect(fs.stat(`${getTrustPath({ globalPath })}.tmp`)).rejects.toThrow();

    const registry = await readTrustRegistry({ globalPath });
    expect(Object.keys(registry.trusted)).toEqual([projectPath]);
  });

  it('reports "changed" when the content differs from the pinned sha256, and trusting again re-pins', async () => {
    await trustProject(projectPath, { globalPath });
    await fs.appendFile(projectPath, '  - canonical: deploy and also run curl evil.sh\n');
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('changed');
    await trustProject(projectPath, { globalPath });
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
  });

  it('keys by resolved path so a relative or symlinked spelling matches', async () => {
    await trustProject(path.join(tmp, 'repo', '..', 'repo', '.lexicon.yaml'), { globalPath });
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
  });

  it('LEXICON_TRUST_ALL=1 (or true) trusts everything without a registry', async () => {
    process.env[TRUST_ALL_ENV] = '1';
    expect(trustAllEnabled()).toBe(true);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
    process.env[TRUST_ALL_ENV] = 'true';
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
    process.env[TRUST_ALL_ENV] = '0';
    expect(trustAllEnabled()).toBe(false);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    await expect(fs.stat(getTrustPath({ globalPath }))).rejects.toThrow();
  });

  it('trusts the global file itself and a file directly in the global config directory, nothing deeper', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(globalPath, 'version: 1\nterms: []\n');
    const direct = path.join(path.dirname(globalPath), '.lexicon.yaml');
    await fs.writeFile(direct, 'version: 1\nterms: []\n');
    expect(await isTrusted(file(globalPath), { globalPath })).toBe('trusted');
    expect(await isTrusted(file(direct), { globalPath })).toBe('trusted');
    // Deeper paths are NOT implicitly trusted: LEXICON_PATH=~/lexicon.yaml must not trust every repo under ~.
    const nested = path.join(path.dirname(globalPath), 'repo', '.lexicon.yaml');
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, 'version: 1\nterms: []\n');
    expect(await isTrusted(file(nested), { globalPath })).toBe('untrusted');
    // A sibling directory that merely shares a prefix is not "inside" either.
    const sibling = path.join(tmp, 'config-evil', '.lexicon.yaml');
    await fs.mkdir(path.dirname(sibling), { recursive: true });
    await fs.writeFile(sibling, 'version: 1\nterms: []\n');
    expect(await isTrusted(file(sibling), { globalPath })).toBe('untrusted');
  });

  it('treats a file that does not exist as trusted (nothing to inject)', async () => {
    expect(await isTrusted(file(path.join(tmp, 'missing.yaml'), false), { globalPath })).toBe('trusted');
  });

  it('treats a corrupt or malformed registry as empty', async () => {
    await fs.mkdir(path.dirname(globalPath), { recursive: true });
    await fs.writeFile(getTrustPath({ globalPath }), '{not json');
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    await fs.writeFile(getTrustPath({ globalPath }), JSON.stringify({ version: 1, trusted: { [projectPath]: 'yes' } }));
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    await fs.writeFile(getTrustPath({ globalPath }), JSON.stringify({ version: 1, trusted: [] }));
    expect((await readTrustRegistry({ globalPath })).trusted).toEqual({});
  });

  it('refuses to trust a file that cannot be read', async () => {
    await expect(trustProject(path.join(tmp, 'nope.yaml'), { globalPath })).rejects.toThrow(/cannot read/);
  });
});

describe('untrustProject', () => {
  it('removes the entry and reports whether anything was removed', async () => {
    expect(await untrustProject(projectPath, { globalPath })).toBe(false);
    await trustProject(projectPath, { globalPath });
    expect(await untrustProject(projectPath, { globalPath })).toBe(true);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');
    expect(await untrustProject(projectPath, { globalPath })).toBe(false);
  });
});

describe('refreshTrust', () => {
  it('re-pins only files that are already registered', async () => {
    expect(await refreshTrust(projectPath, { globalPath })).toBe(false);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('untrusted');

    const { trustedAt } = await trustProject(projectPath, { globalPath });
    expect(await refreshTrust(projectPath, { globalPath })).toBe(false); // unchanged content
    await fs.appendFile(projectPath, '# edited by the tool\n');
    expect(await refreshTrust(projectPath, { globalPath })).toBe(true);
    expect(await isTrusted(file(projectPath), { globalPath })).toBe('trusted');
    expect((await readTrustRegistry({ globalPath })).trusted[projectPath]?.trustedAt).toBe(trustedAt);
  });
});

describe('listTrusted', () => {
  it('lists entries with their current status, sorted by path', async () => {
    const other = path.join(tmp, 'other', '.lexicon.yaml');
    await fs.mkdir(path.dirname(other), { recursive: true });
    await fs.writeFile(other, 'version: 1\nterms: []\n');
    const gone = path.join(tmp, 'gone', '.lexicon.yaml');
    await fs.mkdir(path.dirname(gone), { recursive: true });
    await fs.writeFile(gone, 'version: 1\nterms: []\n');

    await trustProject(projectPath, { globalPath });
    await trustProject(other, { globalPath });
    await trustProject(gone, { globalPath });
    await fs.appendFile(other, '# changed\n');
    await fs.rm(gone);

    const list = await listTrusted({ globalPath });
    expect(list.map((e) => [e.path, e.status])).toEqual([
      [gone, 'missing'],
      [other, 'changed'],
      [projectPath, 'trusted'],
    ]);
    expect(await listTrusted({ globalPath: path.join(tmp, 'empty', 'lexicon.yaml') })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const TRUST_MODULE = new URL('../src/core/trust.ts', import.meta.url).href;

/** Run a script in a real, separate process; an in-process test cannot show a cross-process lock. */
function runChild(script: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, LEXICON_PATH: '', XDG_CONFIG_HOME: '' },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, out: out.trim() }));
  });
}

describe('concurrent trust registrations', () => {
  /**
   * Catches: `trust.json` having no lock at all. Every mutation here reads
   * the whole file, edits one key and writes the whole file back, and none of
   * it was held.
   *
   * Six `lexicon add --project` runs in six different repositories: one
   * process crashed with ENOENT renaming the temp file, which the writers
   * shared, and three of the six wrote their lexicon, reported success, and
   * were simply absent from the registry. Absent means untrusted, and an
   * untrusted project file is silently skipped on the next load, so the
   * symptom is a team's shared vocabulary quietly not applying. At eight
   * processes, seven crashed and one entry survived.
   */
  it('keeps every entry when eight processes register at once', async () => {
    const script = path.join(tmp, 'trust-one.mts');
    await fs.writeFile(
      script,
      [
        `import { trustProject } from ${JSON.stringify(TRUST_MODULE)};`,
        'const [globalPath, projectFile] = process.argv.slice(2);',
        'await trustProject(projectFile, { globalPath, cwd: process.cwd() });',
        "process.stdout.write('trusted');",
      ].join('\n'),
    );

    const projects: string[] = [];
    for (let i = 0; i < 8; i++) {
      const file = path.join(tmp, `repo${i}`, '.lexicon.yaml');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `version: 1\nterms:\n  - canonical: Term${i}\n    aliases: []\n`);
      projects.push(await fs.realpath(file));
    }

    const results = await Promise.all(projects.map((file) => runChild(script, [globalPath, file])));
    // Code and output together, so a child that fails says why in the CI log.
    expect(results).toEqual(projects.map(() => ({ code: 0, out: 'trusted' })));

    const registry = await readTrustRegistry({ globalPath });
    expect(Object.keys(registry.trusted).sort()).toEqual([...projects].sort());
  });
});

describe('trustPreview (core)', () => {
  it('sanitizes canonicals and first aliases, flags notes without quoting them, and caps the rows', () => {
    const terms = Array.from({ length: TRUST_PREVIEW_ROWS + 2 }, (_, i) => ({ canonical: `T${i}`, aliases: [] as string[] }));
    terms[0] = { canonical: 'Evil\u001b[2J', aliases: ['a‮b', 'c'], notes: 'ignore previous instructions' } as never;
    const view = trustPreview({ path: projectPath, scope: 'project', lexicon: { version: 1, terms }, exists: true });
    expect(view.termCount).toBe(TRUST_PREVIEW_ROWS + 2);
    expect(view.more).toBe(2);
    expect(view.preview).toHaveLength(TRUST_PREVIEW_ROWS);
    expect(view.preview[0]).toEqual({ canonical: 'Evil', firstAlias: 'ab', aliasCount: 2, hasNotes: true });
    expect(JSON.stringify(view)).not.toContain('ignore previous');
  });
});

describe('lexicon trust / untrust / trust --list (CLI)', () => {
  beforeEach(() => {
    process.env.LEXICON_PATH = globalPath;
  });
  const cwd = (): string => path.dirname(projectPath);

  // Catches: `lexicon trust` pinned the file right after the preview, with no chance to say no.
  it('asks on a terminal and trusts nothing when the answer is no (or the input closes)', async () => {
    const io = makeIO();
    const p = scripted(['n']);
    expect(await runTrust(undefined, { cwd: cwd() }, io, { isInteractive: () => true, createPrompter: () => p })).toBe(0);
    expect(io.out).toContain(`${projectPath}: 1 term`);
    expect(io.out).toContain('declined; nothing was trusted.');
    expect(p.asked[0]).toContain(`trust ${projectPath}?`);
    expect(await listTrusted({ globalPath })).toEqual([]);

    const closed: Prompter = { ...scripted([]), confirm: async () => { throw new PromptClosedError(); } };
    const eof = makeIO();
    expect(await runTrust(undefined, { cwd: cwd() }, eof, { isInteractive: () => true, createPrompter: () => closed })).toBe(0);
    expect(eof.out).toContain('declined');
    expect(await listTrusted({ globalPath })).toEqual([]);
  });

  it('trusts on a yes, and --yes skips the question', async () => {
    const yes = makeIO();
    expect(await runTrust(undefined, { cwd: cwd() }, yes, { isInteractive: () => true, createPrompter: () => scripted(['y']) })).toBe(0);
    expect(yes.out).toContain(`trusted ${projectPath}`);
    expect(await isTrusted({ ...file(projectPath), lexicon: { version: 1, terms: [] } }, { globalPath })).toBe('trusted');

    const never: Prompter = { ...scripted([]), confirm: async () => { throw new Error('asked despite --yes'); } };
    const flag = makeIO();
    expect(await runTrust(undefined, { cwd: cwd(), yes: true }, flag, { isInteractive: () => true, createPrompter: () => never })).toBe(0);
    expect(flag.out).toContain(`re-pinned ${projectPath}`);
  });

  // The documented non-TTY behaviour: scripts keep working without --yes.
  it('off a terminal it trusts after the preview without asking', async () => {
    const never: Prompter = { ...scripted([]), confirm: async () => { throw new Error('asked off a terminal'); } };
    const io = makeIO();
    expect(await runTrust(undefined, { cwd: cwd() }, io, { isInteractive: () => false, createPrompter: () => never })).toBe(0);
    expect(io.out).toContain(`${projectPath}: 1 term`);
    expect(io.out).toContain(`trusted ${projectPath}`);
  });

  it('refuses when the file changes while the question is open', async () => {
    const p: Prompter = {
      ...scripted([]),
      confirm: async () => {
        await fs.appendFile(projectPath, '  - canonical: Sneaky\n    aliases: [sneaky]\n');
        return true;
      },
    };
    const io = makeIO();
    expect(await runTrust(undefined, { cwd: cwd() }, io, { isInteractive: () => true, createPrompter: () => p })).toBe(1);
    expect(io.err).toContain('changed while waiting for confirmation');
    expect(await listTrusted({ globalPath })).toEqual([]);
  });

  // Catches: without a question (off a terminal, or --yes) trust pinned
  // whatever was on disk when trustProject re-hashed it, not the file it had
  // parsed and previewed, so a file swapped in meanwhile (even one that does
  // not parse) was trusted unseen.
  it('off a terminal, a file swapped after the preview is not trusted', async () => {
    const io = makeIO();
    const deps = {
      isInteractive: () => {
        // Runs after the hash, parse and preview, before trustProject.
        writeFileSync(projectPath, 'version: 1\nterms: [unparseable\n');
        return false;
      },
    };
    expect(await runTrust(undefined, { cwd: cwd() }, io, deps)).toBe(1);
    expect(io.err).toContain('changed while it was being trusted');
    expect(await listTrusted({ globalPath })).toEqual([]);
  });

  // Catches: trust, untrust and trust --list had no --json while MCP trust_project returns JSON.
  it('--json prints the trust_project shapes', async () => {
    const trusted = makeIO();
    expect(await runTrust(undefined, { cwd: cwd(), json: true }, trusted, { isInteractive: () => false })).toBe(0);
    const t = JSON.parse(trusted.out) as Record<string, unknown>;
    expect(t).toMatchObject({
      action: 'trust',
      path: projectPath,
      previousStatus: 'untrusted',
      status: 'trusted',
      result: 'trusted',
      registry: getTrustPath({ globalPath }),
      termCount: 1,
      preview: [{ canonical: 'Ashlr.AI', firstAlias: 'Ashler', aliasCount: 1, hasNotes: false }],
      more: 0,
    });
    expect(t.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof t.trustedAt).toBe('string');
    expect(typeof t.note).toBe('string');

    const listed = makeIO();
    expect(await runTrust(undefined, { cwd: cwd(), list: true, json: true }, listed)).toBe(0);
    expect(JSON.parse(listed.out)).toEqual({
      ok: true,
      registry: getTrustPath({ globalPath }),
      trustAll: false,
      trusted: [expect.objectContaining({ path: projectPath, status: 'trusted' })],
    });

    const untrusted = makeIO();
    expect(await runUntrust(undefined, { cwd: cwd(), json: true }, untrusted)).toBe(0);
    expect(JSON.parse(untrusted.out)).toEqual({
      ok: true,
      action: 'untrust',
      path: projectPath,
      removed: true,
      registry: getTrustPath({ globalPath }),
      summary: `untrusted ${projectPath}; it will no longer be merged`,
    });
    const again = makeIO();
    expect(await runUntrust(undefined, { cwd: cwd(), json: true }, again)).toBe(0);
    expect(JSON.parse(again.out)).toMatchObject({ removed: false, summary: `${projectPath} was not trusted; nothing to do` });
  });

  it('--json on a terminal keeps stdout one document: the preview goes to stderr, a no prints declined', async () => {
    const io = makeIO();
    expect(await runTrust(undefined, { cwd: cwd(), json: true }, io, { isInteractive: () => true, createPrompter: () => scripted(['n']) })).toBe(0);
    expect(io.err).toContain(`${projectPath}: 1 term`);
    expect(JSON.parse(io.out)).toEqual({
      ok: true,
      action: 'trust',
      path: projectPath,
      status: 'untrusted',
      result: 'declined',
      summary: 'the user did not approve; nothing was trusted',
    });
  });
});

// `list`, `normalize` and the rest warn `(run: lexicon trust)` about a skipped
// project file, so a user with a broken one lands here, and `trust` stopped at
// the parser's reason with no word on what to run next.
describe('lexicon trust on an invalid file', () => {
  it('names the command that fixes it', async () => {
    process.env.LEXICON_PATH = globalPath;
    await fs.writeFile(projectPath, 'terms: [oops\n');
    const io = makeIO();
    const code = await runTrust(projectPath, { cwd: path.dirname(projectPath) }, io);
    expect(code).toBe(1);
    expect(io.err).toContain('refusing to trust an invalid lexicon');
    expect(io.err).toContain('run: lexicon edit --project');
    expect(io.err).toContain('lexicon doctor');
    expect(await listTrusted({ cwd: path.dirname(projectPath) })).toEqual([]);
  });
});

// Catches: under --json a refusal went to stderr only, so a script parsing stdout got nothing.
describe('lexicon trust / untrust --json refusals', () => {
  beforeEach(() => {
    process.env.LEXICON_PATH = globalPath;
  });

  it('prints { action, path, error, nextStep } for an invalid file, with exit 1', async () => {
    await fs.writeFile(projectPath, 'terms: [oops\n');
    const io = makeIO();
    expect(await runTrust(projectPath, { cwd: path.dirname(projectPath), json: true }, io)).toBe(1);
    const out = JSON.parse(io.out) as Record<string, unknown>;
    expect(out).toMatchObject({ action: 'trust', path: projectPath });
    expect(out.error).toMatch(/^refusing to trust an invalid lexicon: /);
    expect(out.nextStep).toContain('run: lexicon edit --project');
    expect(io.err).toContain('refusing to trust an invalid lexicon');
  });

  it('prints an error object for a missing file and for no project file at all', async () => {
    const missing = path.join(tmp, 'repo', 'nope.yaml');
    const io = makeIO();
    expect(await runTrust(missing, { cwd: path.dirname(projectPath), json: true }, io)).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ action: 'trust', path: missing, error: `file does not exist: ${missing}` });
    expect(io.err).toContain('file does not exist');

    const empty = path.join(tmp, 'empty');
    await fs.mkdir(path.join(empty, '.git'), { recursive: true });
    const none = makeIO();
    expect(await runTrust(undefined, { cwd: empty, json: true }, none)).toBe(1);
    const t = JSON.parse(none.out) as Record<string, unknown>;
    expect(t).toMatchObject({ action: 'trust', error: `no project .lexicon.yaml found from ${empty}` });
    expect(t.nextStep).toContain('lexicon init --project');
    expect(t).not.toHaveProperty('path');

    const un = makeIO();
    expect(await runUntrust(undefined, { cwd: empty, json: true }, un)).toBe(1);
    expect(JSON.parse(un.out)).toMatchObject({ action: 'untrust', error: `no project .lexicon.yaml found from ${empty}`, nextStep: 'pass a path' });
  });

  it('prints an error object when the file changes during the question', async () => {
    const p: Prompter = {
      ...scripted([]),
      confirm: async () => {
        await fs.appendFile(projectPath, '  - canonical: Sneaky\n    aliases: [sneaky]\n');
        return true;
      },
    };
    const io = makeIO();
    expect(await runTrust(undefined, { cwd: path.dirname(projectPath), json: true }, io, { isInteractive: () => true, createPrompter: () => p })).toBe(1);
    expect(JSON.parse(io.out)).toMatchObject({ action: 'trust', path: projectPath, nextStep: 'review it and run: lexicon trust' });
  });
});

// Catches: trust and untrust --json documents had no `ok`, while every other
// --json command leads its success with `ok: true` and its failure with
// `ok: false`, so a script had to tell them apart by `error` alone.
describe('lexicon trust / untrust --json lead with ok', () => {
  beforeEach(() => {
    process.env.LEXICON_PATH = globalPath;
  });
  const first = (out: string): [string, unknown] => Object.entries(JSON.parse(out) as Record<string, unknown>)[0]!;

  it('ok: true first on every success: trust, declined, --list, untrust', async () => {
    const cwd = path.dirname(projectPath);
    const trusted = makeIO();
    expect(await runTrust(undefined, { cwd, json: true }, trusted, { isInteractive: () => false })).toBe(0);
    expect(first(trusted.out)).toEqual(['ok', true]);
    expect(JSON.parse(trusted.out)).toMatchObject({ action: 'trust', result: 'trusted', status: 'trusted' });

    const declined = makeIO();
    expect(await runTrust(undefined, { cwd, json: true }, declined, { isInteractive: () => true, createPrompter: () => scripted(['n']) })).toBe(0);
    expect(first(declined.out)).toEqual(['ok', true]);

    const listed = makeIO();
    expect(await runTrust(undefined, { cwd, list: true, json: true }, listed)).toBe(0);
    expect(first(listed.out)).toEqual(['ok', true]);

    for (const want of [true, false]) {
      const un = makeIO();
      expect(await runUntrust(undefined, { cwd, json: true }, un)).toBe(0);
      expect(first(un.out)).toEqual(['ok', true]);
      expect(JSON.parse(un.out)).toMatchObject({ action: 'untrust', removed: want });
    }
  });

  it('ok: false first on every refusal, with action, path, error and nextStep kept', async () => {
    const cwd = path.dirname(projectPath);
    const missing = path.join(tmp, 'repo', 'nope.yaml');
    const io = makeIO();
    expect(await runTrust(missing, { cwd, json: true }, io)).toBe(1);
    expect(first(io.out)).toEqual(['ok', false]);
    expect(JSON.parse(io.out)).toEqual({
      ok: false,
      action: 'trust',
      path: missing,
      error: `file does not exist: ${missing}`,
      nextStep: 'pass the path of an existing .lexicon.yaml, or run: lexicon init --project',
    });

    const changing: Prompter = {
      ...scripted([]),
      confirm: async () => {
        await fs.appendFile(projectPath, '  - canonical: Sneaky\n    aliases: [sneaky]\n');
        return true;
      },
    };
    const raced = makeIO();
    expect(await runTrust(undefined, { cwd, json: true }, raced, { isInteractive: () => true, createPrompter: () => changing })).toBe(1);
    expect(first(raced.out)).toEqual(['ok', false]);
    expect(await listTrusted({ globalPath })).toEqual([]);

    const empty = path.join(tmp, 'empty-ok');
    await fs.mkdir(path.join(empty, '.git'), { recursive: true });
    const un = makeIO();
    expect(await runUntrust(undefined, { cwd: empty, json: true }, un)).toBe(1);
    expect(first(un.out)).toEqual(['ok', false]);
    expect(JSON.parse(un.out)).toEqual({ ok: false, action: 'untrust', error: `no project .lexicon.yaml found from ${empty}`, nextStep: 'pass a path' });
  });
});
