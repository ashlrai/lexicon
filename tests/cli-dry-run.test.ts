/** CLI previews must be reachable through commander and preserve user files. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler, Ashlar]\n';
let home: string;
let repo: string;
let globalPath: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lexicon-dry-run-')));
  repo = path.join(home, 'repo');
  mkdirSync(path.join(repo, '.git'), { recursive: true });
  globalPath = path.join(home, '.config', 'lexicon', 'lexicon.yaml');
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function lexicon(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    LEXICON_PATH: globalPath,
    ...extraEnv,
  };
  delete env.LEXICON_TRUST_ALL;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--cwd', repo, ...args], {
    cwd: repoRoot, env, encoding: 'utf8', timeout: 30_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function seedGlobal(): void {
  mkdirSync(path.dirname(globalPath), { recursive: true });
  writeFileSync(globalPath, seed);
}

function preview(args: string[]) {
  const result = lexicon([...args, '--dry-run', '--json']);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Include directories and timestamps: rewriting identical bytes is still a write. */
function snapshot(): Record<string, unknown> {
  return Object.fromEntries(readdirSync(home, { recursive: true, encoding: 'utf8' }).sort().map((name) => {
    const file = path.join(home, name);
    const stat = statSync(file);
    return [name, stat.isDirectory() ? 'directory' : { bytes: readFileSync(file).toString('hex'), mtime: stat.mtimeMs, mode: stat.mode }];
  }));
}

const mutations = [
  ['init'],
  ['add', 'Ashlr.AI', 'Ashley our AI'],
  ['remove', 'Ashlr.AI'],
  ['learn', 'Ashlar', 'Ashlr.AI'],
  ['remove', 'Ashlr.AI', '--alias', 'Ashler'],
  ['untrust', '.lexicon.yaml'],
  ['pack', 'add', 'developer'],
];

describe('dry-run-everywhere filesystem guarantee', () => {
  it.each(mutations.map((args) => [args.join(' '), args] as const))('%s preserves a cold cache and every existing file', (_name, args) => {
    seedGlobal();
    // Above the global parse cache threshold, without populating any cache.
    writeFileSync(globalPath, seed + '\n# ' + 'padding '.repeat(1200) + '\n');
    writeFileSync(path.join(repo, '.lexicon.yaml'), seed);
    const trusted = lexicon(['trust', '--yes']);
    expect(trusted.status, trusted.stderr).toBe(0);
    const before = snapshot();
    const plan = preview([...args]);
    expect(plan).toMatchObject(args[0] === 'pack'
      ? [{ dryRun: true, added: expect.any(Number), path: globalPath }]
      : { ok: true, dryRun: true });
    expect(snapshot()).toEqual(before);
  });

  it.each(mutations.map((args) => [args.join(' '), args] as const))('%s creates no files in a fresh home', (_name, args) => {
    const before = snapshot();
    const result = lexicon([...args, '--dry-run', '--json']);
    expect(result.status, result.stderr).toBe(args[0] === 'remove' ? 1 : 0);
    expect(JSON.parse(result.stdout)).toMatchObject(args[0] === 'pack' ? [{ dryRun: true }] : { dryRun: true });
    expect(snapshot()).toEqual(before);
  });
});

describe('CLI dry-run previews', () => {
  it('advertises the preview flag on every newly supported command', () => {
    for (const command of ['init', 'add', 'remove', 'harvest', 'export', 'review', 'edit']) {
      const result = lexicon([command, '--help']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('--dry-run');
    }
  });

  it('init plans missing global and project files without creating or trusting them', () => {
    expect(preview(['init'])).toMatchObject({ ok: true, created: true, dryRun: true, path: globalPath });
    const projectPath = path.join(repo, '.lexicon.yaml');
    expect(preview(['init', '--project'])).toMatchObject({ ok: true, created: true, dryRun: true, path: projectPath, trust: 'trusted' });
    for (const file of [globalPath, projectPath, path.join(path.dirname(globalPath), 'trust.json')]) {
      expect(existsSync(file)).toBe(false);
    }
    const applied = lexicon(['init', '--project', '--json']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(existsSync(projectPath)).toBe(true);
    const before = readFileSync(projectPath, 'utf8');
    expect(preview(['init', '--project'])).toMatchObject({ ok: true, created: false, dryRun: true, trust: 'trusted' });
    expect(readFileSync(projectPath, 'utf8')).toBe(before);
  });

  it('add previews new and merged terms without creating or replacing the lexicon', () => {
    expect(preview(['add', 'Ashlr.AI', 'Ashler'])).toMatchObject({ ok: true, created: true, dryRun: true, term: { canonical: 'Ashlr.AI', aliases: ['Ashler'] } });
    expect(existsSync(globalPath)).toBe(false);
    seedGlobal();
    expect(preview(['add', 'Ashlr.AI', 'Ashley our AI'])).toMatchObject({ ok: true, created: false, dryRun: true, term: { aliases: ['Ashler', 'Ashlar', 'Ashley our AI'] } });
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
    const applied = lexicon(['add', 'Ashlr.AI', 'Ashley our AI', '--json']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).term.aliases).toEqual(['Ashler', 'Ashlar', 'Ashley our AI']);
  });

  it('add --dry-run reports the intended addition without changing an existing lexicon', () => {
    seedGlobal();
    const before = snapshot();
    const result = lexicon(['add', 'QuasarBridge', 'quasar bridge', 'quasar breach', '--dry-run']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('would create QuasarBridge (global)');
    expect(result.stdout).toContain('aliases: quasar bridge, quasar breach');
    expect(result.stdout).toContain('nothing was written');
    expect(snapshot()).toEqual(before);
  });

  it('remove previews a whole term or one alias while preserving the file', () => {
    seedGlobal();
    expect(preview(['remove', 'Ashlr.AI'])).toMatchObject({ ok: true, removed: true, dryRun: true });
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
    expect(preview(['remove', 'Ashlr.AI', '--alias', 'Ashler'])).toMatchObject({ ok: true, removed: true, dryRun: true, aliases: ['Ashlar'] });
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
    const missing = lexicon(['remove', 'Missing', '--dry-run', '--json']);
    expect(missing.status).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ ok: false, removed: false, dryRun: true });
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
  });

  it.each([
    { args: ['remove', 'Ashlr.AI'], message: 'would remove Ashlr.AI from', suffix: '' },
    { args: ['remove', 'Ashlr.AI', '--alias', 'Ashler'], message: 'would remove alias Ashler from Ashlr.AI in', suffix: 'aliases: Ashlar\n' },
  ])('remove reports the intended change without writing: $message', ({ args, message, suffix }) => {
    seedGlobal();
    const before = snapshot();
    const planned = lexicon([...args, '--dry-run']);
    expect(planned.status, planned.stderr).toBe(0);
    expect(planned.stdout).toBe(`${message} ${globalPath}\n${suffix}`);
    expect(planned.stderr).toBe('');
    expect(snapshot()).toEqual(before);

    const applied = lexicon([...args, '--json']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({ ok: true, canonical: 'Ashlr.AI', removed: true });
    expect(readFileSync(globalPath, 'utf8')).not.toBe(seed);
  });

  it('project previews retain the untrusted-file refusal and do not pin content', () => {
    const projectPath = path.join(repo, '.lexicon.yaml');
    writeFileSync(projectPath, seed);
    for (const args of [['add', 'NewName', 'new name', '--project'], ['remove', 'Ashlr.AI', '--project'], ['harvest', '--add', '--yes']]) {
      const result = lexicon([...args, '--dry-run', '--json']);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
      expect(result.stderr).not.toContain('unknown option');
      expect(readFileSync(projectPath, 'utf8')).toBe(seed);
      expect(existsSync(path.join(path.dirname(globalPath), 'trust.json'))).toBe(false);
    }
  });

  it('harvest plans project additions and a real run adds the same candidates', () => {
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'quasarbridge', dependencies: { 'turbovector': '1.0.0' } }));
    const result = lexicon(['harvest', '--add', '--yes', '--dry-run', '--full']);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(result.stdout);
    expect(plan).toMatchObject({ ok: true, dryRun: true, created: expect.any(Number), path: path.join(repo, '.lexicon.yaml') });
    expect(plan.created).toBeGreaterThan(0);
    expect(existsSync(plan.path)).toBe(false);
    expect(existsSync(path.join(path.dirname(globalPath), 'trust.json'))).toBe(false);
    const applied = lexicon(['harvest', '--add', '--yes', '--full']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout).created).toBe(plan.created);
    expect(existsSync(plan.path)).toBe(true);
  });

  it('export reports bytes and path without replacing an existing output', () => {
    seedGlobal();
    const out = path.join(home, 'terms.json');
    writeFileSync(out, 'preserve this export\n');
    const plan = preview(['export', 'json', '--out', out]);
    expect(plan).toMatchObject({ ok: true, format: 'json', terms: 1, bytes: expect.any(Number), path: out, dryRun: true });
    expect(readFileSync(out, 'utf8')).toBe('preserve this export\n');
    const applied = lexicon(['export', 'json', '--out', out, '--json']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(Buffer.byteLength(readFileSync(out, 'utf8'))).toBe(plan.bytes);
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
  });

  it('edit never launches the configured editor, and review retains its noninteractive refusal', () => {
    const marker = path.join(home, 'editor-ran');
    const editor = path.join(home, 'editor.mjs');
    writeFileSync(editor, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
    const env = { VISUAL: `"${process.execPath}" "${editor}"` };
    const missing = lexicon(['edit', '--dry-run'], env);
    expect(missing.status, missing.stderr).toBe(0);
    expect(missing.stdout).toContain('would create');
    expect(existsSync(globalPath)).toBe(false);
    seedGlobal();
    const existing = lexicon(['edit', '--dry-run'], env);
    expect(existing.status, existing.stderr).toBe(0);
    expect(existing.stdout).toContain('would open');
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
    const review = lexicon(['review', '--dry-run', '--json']);
    expect(review.status).toBe(1);
    expect(JSON.parse(review.stdout)).toMatchObject({ ok: false, error: 'review is interactive and has no --json output' });
    expect(readFileSync(globalPath, 'utf8')).toBe(seed);
  });
});
