/**
 * Interactive CLI workflows (harvest --interactive, add -i, review, edit)
 * against a real lexicon in a temp dir, driven by a scripted Prompter.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runHarvestInteractive, runReview, runEdit, editorCommand } from '../src/cli/cmd-review.js';
import type { SpawnEditor } from '../src/cli/cmd-review.js';
import { runAdd, runHarvest } from '../src/cli/commands.js';
import type { IO } from '../src/cli/commands.js';
import { askKey, splitList } from '../src/cli/prompt.js';
import type { PromptChoice, Prompter } from '../src/cli/prompt.js';
import { addTerm, recordHits, trustProject, writeLexiconFile } from '../src/core/index.js';
import type { HarvestCandidate, Lexicon, Term } from '../src/core/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIO(): IO & { out: string; err: string } {
  const sink = {
    out: '',
    err: '',
    stdout(s: string) {
      sink.out += s;
    },
    stderr(s: string) {
      sink.err += s;
    },
  };
  return sink;
}

/**
 * A Prompter that answers from a queue. `ask`/`confirm` shift a string;
 * `choose` shifts an array of 1-based indices to select (multi) or a single
 * index (single). Every question is recorded for assertions.
 */
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

let tmp: string;
let globalPath: string;
let repo: string;
let projectPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-review-'));
  // The project file must NOT sit in the global config dir (that is auto-trusted).
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  projectPath = path.join(repo, '.lexicon.yaml');
  for (const key of ['LEXICON_PATH', 'XDG_CONFIG_HOME', 'LEXICON_TRUST_ALL', 'VISUAL', 'EDITOR']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readYaml(file: string): Promise<Lexicon> {
  return parseYaml(await fs.readFile(file, 'utf8')) as Lexicon;
}

function candidate(canonical: string, extra: Partial<HarvestCandidate> = {}): HarvestCandidate {
  return {
    canonical,
    category: 'identifier',
    source: 'harvest:repo',
    evidence: [`src/${canonical.toLowerCase()}.ts`],
    count: 3,
    suggestedAliases: [`${canonical} x`, `${canonical}y`],
    ...extra,
  };
}

async function seedGlobal(terms: Term[]): Promise<void> {
  await writeLexiconFile({ path: globalPath, scope: 'global', lexicon: { version: 1, terms }, exists: false });
}

// ---------------------------------------------------------------------------
// prompt helpers
// ---------------------------------------------------------------------------

describe('prompt helpers', () => {
  it('splitList trims, drops empties and dedupes case-insensitively', () => {
    expect(splitList(' a, b ,,B, c ')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
  });

  it('askKey repeats until a listed key is typed and honours the default on Enter', async () => {
    const p = scripted(['zzz', 'Yes', '']);
    expect(await askKey(p, 'q', ['y', 'n'])).toBe('y');
    expect(await askKey(p, 'q', ['y', 'n'], 'n')).toBe('n');
  });
});

// ---------------------------------------------------------------------------
// harvest --interactive
// ---------------------------------------------------------------------------

describe('harvest --interactive', () => {
  it('adds on y, skips on n, replaces aliases on e, stops on q', async () => {
    const candidates = [candidate('Alpha'), candidate('Beta'), candidate('Gamma'), candidate('Delta')];
    const p = scripted([
      'y', // Alpha
      'n', // Beta
      'e', 'gam ma, gamma-ish, Gamma', 'y', // Gamma: edit aliases (canonical dropped), then add
      'q', // Delta: quit
    ]);
    const io = makeIO();
    const code = await runHarvestInteractive(candidates, { cwd: repo, globalPath }, io, p);
    expect(code).toBe(0);

    const written = await readYaml(projectPath);
    expect(written.terms.map((t) => t.canonical)).toEqual(['Alpha', 'Gamma']);
    expect(written.terms[0].aliases).toEqual(['Alpha x', 'Alphay']);
    expect(written.terms[1].aliases).toEqual(['gam ma', 'gamma-ish']);
    expect(written.terms[1].source).toBe('harvest:repo');
    expect(io.out).toContain('[1/4] Alpha');
    expect(io.out).toContain('evidence: src/alpha.ts');
    expect(io.out).toContain('added 2 new terms, merged 0, skipped 2');
    expect(io.out).toContain(`project lexicon trusted (${projectPath})`);
    // The caller's candidates were not mutated by the edit.
    expect(candidates[2].suggestedAliases).toEqual(['Gamma x', 'Gammay']);
  });

  it('c changes the category and a adds every remaining candidate without asking', async () => {
    const candidates = [candidate('One'), candidate('Two'), candidate('Three')];
    const p = scripted(['c', 'nope', 'Brand', 'a']);
    const io = makeIO();
    expect(await runHarvestInteractive(candidates, { cwd: repo, globalPath }, io, p)).toBe(0);
    const written = await readYaml(projectPath);
    expect(written.terms.map((t) => [t.canonical, t.category])).toEqual([
      ['One', 'brand'],
      ['Two', 'identifier'],
      ['Three', 'identifier'],
    ]);
    expect(io.out).toContain('added 3 new terms, merged 0, skipped 0');
    // Only One was shown; Two and Three were added silently.
    expect(io.out).not.toContain('[2/3]');
  });

  it('merges into an existing trusted project term and counts it as merged', async () => {
    await writeLexiconFile({
      path: projectPath,
      scope: 'project',
      lexicon: { version: 1, terms: [{ canonical: 'Alpha', aliases: ['alfa'] }] },
      exists: false,
    });
    await trustProject(projectPath, { globalPath });
    const io = makeIO();
    expect(await runHarvestInteractive([candidate('Alpha')], { cwd: repo, globalPath }, io, scripted(['y']))).toBe(0);
    const written = await readYaml(projectPath);
    expect(written.terms[0].aliases).toEqual(['alfa', 'Alpha x', 'Alphay']);
    expect(io.out).toContain('added 0 new terms, merged 1');
  });

  it('refuses an untrusted project lexicon before asking anything', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n', 'utf8');
    const p = scripted([]);
    const io = makeIO();
    expect(await runHarvestInteractive([candidate('Alpha')], { cwd: repo, globalPath }, io, p)).toBe(1);
    expect(io.err).toMatch(/is untrusted; review it and run `lexicon trust` first/);
    expect(p.asked).toEqual([]);
    expect(await fs.readFile(projectPath, 'utf8')).toBe('version: 1\nterms: []\n');
  });

  it('runHarvest --interactive without a terminal errors before scanning', async () => {
    await expect(
      runHarvest(repo, { interactive: true, globalPath }, makeIO(), { isInteractive: () => false }),
    ).rejects.toThrow(/needs a terminal/);
  });

  it('runHarvest --add on a terminal walks candidates and closes the prompter; --yes skips the walk', async () => {
    // A package.json name is a reliable candidate for the real harvester.
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'quokkatron' }), 'utf8');
    const p = scripted(['q']);
    const io = makeIO();
    const code = await runHarvest(repo, { add: true, minCount: 1, globalPath }, io, {
      isInteractive: () => true,
      createPrompter: () => p,
    });
    expect(code).toBe(0);
    expect(p.asked.length).toBeGreaterThan(0);
    expect(p.closed).toBe(true);
    expect(io.out).toContain('[1/');

    const quiet = makeIO();
    const untouched = scripted([]);
    await runHarvest(repo, { add: true, yes: true, minCount: 1, globalPath }, quiet, {
      isInteractive: () => true,
      createPrompter: () => untouched,
    });
    expect(untouched.asked).toEqual([]);
    expect(quiet.out).toMatch(/added \d+ new term/);
  });
});

// ---------------------------------------------------------------------------
// add --interactive
// ---------------------------------------------------------------------------

describe('add --interactive', () => {
  it('shows suggestions as a checklist, keeps the selection plus extras, asks phonetic and category', async () => {
    const p = scripted([
      [1, 3], // keep the 1st and 3rd suggestion
      'ash lr, ASH LR', // extras (deduped)
      'ASH-ler', // phonetic
      'brand', // category
    ]);
    const io = makeIO();
    const code = await runAdd('Ashlr.AI', [], { interactive: true, globalPath }, io, p);
    expect(code).toBe(0);
    expect(p.asked[0]).toContain('aliases for Ashlr.AI');

    const written = await readYaml(globalPath);
    expect(written.terms).toHaveLength(1);
    const term = written.terms[0];
    expect(term.canonical).toBe('Ashlr.AI');
    expect(term.phonetic).toBe('ASH-ler');
    expect(term.category).toBe('brand');
    expect(term.aliases).toContain('ash lr');
    expect(term.aliases).toHaveLength(3);
    expect(io.out).toContain('created Ashlr.AI (global)');
    expect(io.out).not.toContain('suggested aliases:');
    // The caller owns the prompter; runAdd must not close it.
    expect(p.closed).toBe(false);
  });

  it('with aliases given it skips the checklist, re-asks an unknown category and defaults to other', async () => {
    const p = scripted(['', 'bogus', '']);
    const io = makeIO();
    expect(await runAdd('Kubernetes', ['cooper netties'], { interactive: true, globalPath }, io, p)).toBe(0);
    expect(p.asked.filter((q) => q.startsWith('category'))).toHaveLength(2);
    expect(io.err).toContain('unknown category "bogus"');
    const written = await readYaml(globalPath);
    expect(written.terms[0]).toMatchObject({ canonical: 'Kubernetes', aliases: ['cooper netties'], category: 'other' });
    expect(written.terms[0].phonetic).toBeUndefined();
  });

  it('errors without a terminal or a prompter', async () => {
    await expect(runAdd('X', [], { interactive: true, globalPath }, makeIO())).rejects.toThrow(/needs a terminal/);
  });
});

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

describe('review', () => {
  const terms: Term[] = [
    { canonical: 'Ashlr.AI', aliases: ['Ashler'], category: 'brand', hits: 4 },
    { canonical: 'Stale', aliases: ['stail'], category: 'identifier' },
    { canonical: 'Mason Wyatt', aliases: ['Mason Wyeth'], category: 'person', hits: 0 },
    { canonical: 'Keeper', aliases: [], category: 'product' },
  ];

  it('keeps, deletes, edits aliases/phonetic/notes and writes once at the end', async () => {
    await seedGlobal(terms);
    const p = scripted([
      'k', // Ashlr.AI
      'd', // Stale
      'e', 'Mason Wyeth, Mace on Wyatt', 'p', 'MAY-sun', 'n', 'my name', 'k', // Mason Wyatt
      'k', // Keeper
    ]);
    const io = makeIO();
    expect(await runReview({ globalPath }, io, p)).toBe(0);

    const written = await readYaml(globalPath);
    expect(written.terms.map((t) => t.canonical)).toEqual(['Ashlr.AI', 'Mason Wyatt', 'Keeper']);
    expect(written.terms[1]).toMatchObject({
      aliases: ['Mason Wyeth', 'Mace on Wyatt'],
      phonetic: 'MAY-sun',
      notes: 'my name',
    });
    expect(io.out).toContain('[2/4] Stale');
    expect(io.out).toContain('deleted Stale');
    expect(io.out).toContain(`kept 3, deleted 1, edited 3 — wrote ${globalPath}`);
  });

  it('merges hits and terms written elsewhere while the review was running instead of overwriting them', async () => {
    await seedGlobal(terms);
    const inner = scripted([
      'k', // Ashlr.AI
      'd', // Stale
      'e', 'Mason Wyeth, Mace on Wyatt', 'k', // Mason Wyatt (edited)
      'k', // Keeper
    ]);
    // Between the first two prompts another process bumps hits (the MCP
    // server) and adds a term (`lexicon add` in another shell): both must
    // survive the review's final write.
    let interleaved = false;
    const p: Prompter = {
      ...inner,
      async ask(question, opts) {
        const answer = await inner.ask(question, opts);
        if (!interleaved) {
          interleaved = true;
          await recordHits(['Ashlr.AI', 'Ashlr.AI', 'Mason Wyatt', 'Stale'], { cwd: tmp, globalPath });
          await addTerm({ canonical: 'Newcomer', aliases: ['new comer'], category: 'product' }, { cwd: tmp, globalPath });
          await addTerm({ canonical: 'Keeper', aliases: ['keep her'] }, { cwd: tmp, globalPath });
        }
        return answer;
      },
    };
    const io = makeIO();
    expect(await runReview({ cwd: tmp, globalPath }, io, p)).toBe(0);

    const written = await readYaml(globalPath);
    expect(written.terms.map((t) => t.canonical)).toEqual(['Ashlr.AI', 'Mason Wyatt', 'Keeper', 'Newcomer']);
    // Untouched term: on-disk hits carried over (4 + 2).
    expect(written.terms[0].hits).toBe(6);
    // Edited term: the session's aliases win, the on-disk hit count is kept.
    expect(written.terms[1]).toMatchObject({ aliases: ['Mason Wyeth', 'Mace on Wyatt'], hits: 1 });
    // Kept term whose aliases were merged elsewhere: the on-disk version wins.
    expect(written.terms[2].aliases).toEqual(['keep her']);
    // Deleted stays deleted even though its hits were bumped meanwhile.
    expect(written.terms.some((t) => t.canonical === 'Stale')).toBe(false);
    expect(written.terms[3]).toMatchObject({ canonical: 'Newcomer', aliases: ['new comer'] });
    expect(io.out).toContain('merged 4 changes made elsewhere during review');
    expect(io.out).toContain(`kept 3, deleted 1, edited 1 — wrote ${globalPath}`);
  });

  it('does not report a merge when nothing changed on disk', async () => {
    await seedGlobal(terms);
    const io = makeIO();
    expect(await runReview({ cwd: tmp, globalPath }, io, scripted(['d', 'k', 'k', 'k']))).toBe(0);
    expect(io.out).not.toContain('made elsewhere');
    expect((await readYaml(globalPath)).terms).toHaveLength(3);
  });

  it('--never-hit and --category filter what is walked; q stops without writing', async () => {
    await seedGlobal(terms);
    const p = scripted(['q']);
    const io = makeIO();
    expect(await runReview({ globalPath, neverHit: true }, io, p)).toBe(0);
    expect(io.out).toContain('3 terms in');
    expect(io.out).toContain('[1/3] Stale');
    expect(io.out).toContain('(nothing written)');

    const io2 = makeIO();
    expect(await runReview({ globalPath, category: 'person' }, io2, scripted(['k']))).toBe(0);
    expect(io2.out).toContain('1 term in');
    expect(io2.out).toContain('[1/1] Mason Wyatt');
    expect((await readYaml(globalPath)).terms).toHaveLength(4);
  });

  it('--project reviews the project file, refuses it when untrusted, and re-pins trust after a write', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Proj\n    aliases: [prodge]\n', 'utf8');
    const refused = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, refused, scripted([]))).toBe(1);
    expect(refused.err).toMatch(/is untrusted/);

    await trustProject(projectPath, { globalPath });
    const io = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, io, scripted(['d']))).toBe(0);
    expect((await readYaml(projectPath)).terms).toEqual([]);
    // Still trusted after our own write.
    const again = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, again, scripted([]))).toBe(0);
    expect(again.out).toContain('no terms to review');
  });

  it('reports a missing file, an unknown category and mutually exclusive flags', async () => {
    const io = makeIO();
    expect(await runReview({ globalPath }, io, scripted([]))).toBe(0);
    expect(io.out).toContain(`no global lexicon at ${globalPath}`);
    await expect(runReview({ globalPath, category: 'nope' }, makeIO(), scripted([]))).rejects.toThrow(/unknown category/);
    await expect(runReview({ globalPath, project: true, global: true }, makeIO(), scripted([]))).rejects.toThrow(
      /mutually exclusive/,
    );
    await expect(runReview({ globalPath }, makeIO())).rejects.toThrow(/needs a terminal/);
  });
});

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe('edit', () => {
  it('editorCommand prefers $VISUAL, splits arguments, and is undefined when unset', () => {
    expect(editorCommand({ VISUAL: 'code --wait', EDITOR: 'vim' })).toEqual({ command: 'code', args: ['--wait'] });
    expect(editorCommand({ EDITOR: 'vim' })).toEqual({ command: 'vim', args: [] });
    expect(editorCommand({ EDITOR: '  ' })).toBeUndefined();
    expect(editorCommand({})).toBeUndefined();
  });

  it('prints the path when no editor is configured (creating a missing global file)', async () => {
    const io = makeIO();
    expect(await runEdit({ globalPath }, io, undefined, {})).toBe(0);
    expect(io.out).toContain(`created global lexicon: ${globalPath}`);
    expect(io.out).toContain('no $VISUAL or $EDITOR set');
    expect(io.out).toContain(globalPath);
    expect((await readYaml(globalPath)).terms).toEqual([]);
  });

  it('spawns $EDITOR on the file (real subprocess) and reports the re-parsed term count', async () => {
    await seedGlobal([{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }]);
    const script = path.join(tmp, 'append.mjs');
    await fs.writeFile(
      script,
      "import { appendFileSync } from 'node:fs';\nappendFileSync(process.argv[2], '  - canonical: Added\\n    aliases: [add id]\\n');\n",
      'utf8',
    );
    const io = makeIO();
    const code = await runEdit({ globalPath }, io, undefined, { EDITOR: `${process.execPath} ${script}` });
    expect(code).toBe(0);
    expect(io.out).toContain(`ok: 2 terms in ${globalPath}`);
    const written = await readYaml(globalPath);
    expect(written.terms.map((t) => t.canonical)).toEqual(['Ashlr.AI', 'Added']);
  });

  it('keeps invalid edits on disk and reports the parse error with the path', async () => {
    await seedGlobal([{ canonical: 'Ashlr.AI', aliases: ['Ashler'] }]);
    const broken = 'version: 1\nterms:\n  - canonical: ""\n    aliases: [x]\n';
    const spawnEditor: SpawnEditor = async (_cmd, _args, file) => {
      await fs.writeFile(file, broken, 'utf8');
      return 0;
    };
    const io = makeIO();
    expect(await runEdit({ globalPath }, io, spawnEditor, { EDITOR: 'fake' })).toBe(1);
    expect(io.err).toMatch(/Invalid lexicon at .*canonical/s);
    expect(io.err).toContain(`your edits are still in ${globalPath}`);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(broken);
  });

  it('passes editor arguments through, notes a non-zero exit, and re-trusts an edited trusted project file', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Seed\n    aliases: [seed]\n', 'utf8');
    await trustProject(projectPath, { globalPath });
    const calls: { cmd: string; args: readonly string[]; file: string }[] = [];
    const spawnEditor: SpawnEditor = async (cmd, args, file) => {
      calls.push({ cmd, args, file });
      await fs.appendFile(file, '  - canonical: Proj\n    aliases: [prodge]\n', 'utf8');
      return 3;
    };
    const io = makeIO();
    expect(await runEdit({ cwd: repo, project: true, globalPath }, io, spawnEditor, { VISUAL: 'code --wait' })).toBe(0);
    expect(calls).toEqual([{ cmd: 'code', args: ['--wait'], file: projectPath }]);
    expect(io.err).toContain('code exited with code 3');
    expect(io.out).toContain('ok: 2 terms in');
    expect(io.out).toContain('re-trusted');
    // A follow-up project-scope write goes through, so the hash was re-pinned.
    const review = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, review, scripted(['k', 'k']))).toBe(0);
    expect(review.out).toContain('[2/2] Proj');
  });

  it('leaves an untrusted project file untrusted and says so', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n', 'utf8');
    const io = makeIO();
    expect(await runEdit({ cwd: repo, project: true, globalPath }, io, async () => 0, { EDITOR: 'x' })).toBe(0);
    expect(io.out).toContain('not trusted yet');
    await expect(runEdit({ cwd: tmp, project: true, globalPath }, makeIO(), async () => 0, { EDITOR: 'x' })).rejects.toThrow(
      /no project lexicon found/,
    );
  });
});
