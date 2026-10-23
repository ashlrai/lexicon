/**
 * Interactive CLI workflows (harvest --interactive, add -i, review, edit)
 * against a real lexicon in a temp dir, driven by a scripted Prompter.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runHarvestInteractive, runReview, runEdit, editorCommand } from '../src/cli/cmd-review.js';
import type { SpawnEditor } from '../src/cli/cmd-review.js';
import { runAdd, runHarvest } from '../src/cli/commands.js';
import { PromptClosedError, askKey, splitList } from '../src/cli/prompt.js';
import type { Prompter } from '../src/cli/prompt.js';
import { addTerm, loadLexicon, recordHits, trustProject, writeLexiconFile } from '../src/core/index.js';
import type { HarvestCandidate, Lexicon, Term } from '../src/core/index.js';
import { makeIO, scripted } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------



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
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

/** A scripted prompter whose input closes (ctrl-D) once `answers` run out, as createPrompter's does. */
function closingAfter(answers: string[]): Prompter {
  const inner = scripted(answers);
  let left = answers.length;
  const gate = <T>(answer: () => Promise<T>): Promise<T> => {
    if (left === 0) return Promise.reject(new PromptClosedError());
    left -= 1;
    return answer();
  };
  return {
    ask: (question, opts) => gate(() => inner.ask(question, opts)),
    confirm: (question, def) => gate(() => inner.confirm(question, def)),
    choose: (question, choices, opts) => gate(() => inner.choose(question, choices, opts)),
    close: () => inner.close(),
  };
}

/** Written as raw YAML: writeLexiconFile pins `hits` to what is on disk, and the seed's counts are the point. */
async function seedGlobal(terms: Term[]): Promise<void> {
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, stringifyYaml({ version: 1, terms }), 'utf8');
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

  // Catches: ctrl-D threw `input closed before the prompt was answered`
  // (exit 1) with no summary, though the terms accepted before it had
  // already been written, so nothing said they were kept.
  it('ctrl-D stops like q and says the terms added before it are kept', async () => {
    const candidates = [candidate('Alpha'), candidate('Beta'), candidate('Gamma')];
    const io = makeIO();
    expect(await runHarvestInteractive(candidates, { cwd: repo, globalPath }, io, closingAfter(['y', 'e']))).toBe(0);
    expect((await readYaml(projectPath)).terms.map((t) => t.canonical)).toEqual(['Alpha']);
    expect(io.out).toContain('input closed at candidate 2 of 3; the terms added before it stay in the project lexicon');
    expect(io.out).toContain(`added 1 new term, merged 0, skipped 2 in ${projectPath}`);

    const none = makeIO();
    expect(await runHarvestInteractive(candidates, { cwd: repo, globalPath }, none, closingAfter([]))).toBe(0);
    expect(none.out).toContain('input closed at candidate 1 of 3; nothing was added');
    expect(none.out).toContain('added 0 new terms, merged 0, skipped 3');
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

  // Catches: "a" wrote the project file once per remaining candidate (a full re-parse each).
  it('a adds the rest in one write, printing the same lines a write per candidate printed', async () => {
    const candidates = [candidate('One'), candidate('Two'), candidate('Three'), candidate('Four')];
    const io = makeIO();
    expect(await runHarvestInteractive(candidates, { cwd: repo, globalPath }, io, scripted(['y', 'a']))).toBe(0);
    expect((await readYaml(projectPath)).terms.map((t) => t.canonical)).toEqual(['One', 'Two', 'Three', 'Four']);
    // writeLexiconFile keeps the bytes it replaced at .bak: after one write
    // for One and one for the batch, that is the file holding One alone.
    expect((await readYaml(`${projectPath}.bak`)).terms.map((t) => t.canonical)).toEqual(['One']);
    const lines = io.out.split('\n');
    const from = lines.indexOf('  added Two');
    expect(lines.slice(from, from + 5)).toEqual(['  added Two', '', '  added Three', '  added Four', `added 4 new terms, merged 0, skipped 0 in ${projectPath}`]);
    expect(io.out).not.toContain('[3/4]');
    expect(io.out).toContain(`project lexicon trusted (${projectPath})`);
    // The batch re-pinned the file: a later walk writes to it without a refusal.
    expect(await runHarvestInteractive([candidate('Five')], { cwd: repo, globalPath }, makeIO(), scripted(['y']))).toBe(0);
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

  // Catches: `harvest --add --yes` printed the candidate table (or the --json
  // array) and only then hit the trust gate, so the output read as a success.
  it('runHarvest --add --yes refuses an untrusted project lexicon before printing candidates', async () => {
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'quokkatron' }), 'utf8');
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n', 'utf8');
    const io = makeIO();
    expect(await runHarvest(repo, { add: true, yes: true, minCount: 1, globalPath }, io, { isInteractive: () => false })).toBe(1);
    expect(io.out).toBe('');
    expect(io.err).toMatch(/is untrusted; review it and run `lexicon trust` first/);

    const json = makeIO();
    expect(await runHarvest(repo, { add: true, yes: true, json: true, minCount: 1, globalPath }, json, { isInteractive: () => false })).toBe(1);
    expect(JSON.parse(json.out)).toEqual({ ok: false, added: false, path: projectPath, projectTrust: 'untrusted', error: expect.stringContaining('is untrusted'), nextStep: `review ${projectPath} and run lexicon trust, then run lexicon harvest --add again` });
    expect(await fs.readFile(projectPath, 'utf8')).toBe('version: 1\nterms: []\n');

    // Without --add nothing is written, so the scan still prints.
    const scan = makeIO();
    expect(await runHarvest(repo, { minCount: 1, globalPath }, scan, { isInteractive: () => false })).toBe(0);
    expect(scan.out).toContain('quokkatron');
  });

  // Catches: `harvest --add --json` reported what it wrote on stderr only; stdout had just the candidates.
  // Catches: the --full success object had no `ok`, though its failure leads with `ok: false`.
  it('runHarvest --full prints one object with the add result; --json keeps the bare array', async () => {
    await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'quokkatron' }), 'utf8');
    const scan = makeIO();
    expect(await runHarvest(repo, { full: true, minCount: 1, globalPath }, scan, { isInteractive: () => false })).toBe(0);
    const scanned = JSON.parse(scan.out) as { root: string; candidates: { canonical: string }[]; count: number };
    expect(Object.keys(scanned)).toEqual(['ok', 'root', 'candidates', 'count']);
    expect(scanned.root).toBe(repo);
    expect(scanned.count).toBe(scanned.candidates.length);
    expect(scanned.candidates.map((c) => c.canonical.toLowerCase())).toContain('quokkatron');

    const added = makeIO();
    expect(await runHarvest(repo, { add: true, yes: true, full: true, minCount: 1, globalPath }, added, { isInteractive: () => true })).toBe(0);
    const result = JSON.parse(added.out) as { count: number; added: number; created: number; merged: number; path: string };
    expect(Object.keys(result)[0]).toBe('ok');
    expect(result).toMatchObject({ ok: true, added: result.count, created: result.count, merged: 0, path: projectPath });
    expect(added.err).toMatch(/added \d+ new term/);
    expect((await readYaml(projectPath)).terms.length).toBe(result.count);

    // The documented --json shape is unchanged: the bare array, the summary on stderr.
    const plain = makeIO();
    expect(await runHarvest(repo, { add: true, yes: true, json: true, minCount: 1, globalPath }, plain, { isInteractive: () => false })).toBe(0);
    expect(Array.isArray(JSON.parse(plain.out))).toBe(true);
    expect(plain.err).toMatch(/added 0 new terms, merged \d+/);
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
    expect(io.out).not.toContain('(suggested');
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
    expect(io.out).toContain(`kept 3, deleted 1, edited 3. Wrote ${globalPath}`);
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
    // Hits counted meanwhile went to hits.json; the file keeps its own floor (4).
    expect(written.terms[0].hits).toBe(4);
    const merged = (await loadLexicon({ cwd: tmp, globalPath })).merged.terms;
    expect(merged.find((t) => t.canonical === 'Ashlr.AI')?.hits).toBe(6);
    // Edited term: the session's aliases win, and the count still shows through.
    expect(written.terms[1]).toMatchObject({ aliases: ['Mason Wyeth', 'Mace on Wyatt'] });
    expect(merged.find((t) => t.canonical === 'Mason Wyatt')?.hits).toBe(1);
    // Kept term whose aliases were merged elsewhere: the on-disk version wins.
    expect(written.terms[2].aliases).toEqual(['keep her']);
    // Deleted stays deleted even though its hits were bumped meanwhile.
    expect(written.terms.some((t) => t.canonical === 'Stale')).toBe(false);
    expect(written.terms[3]).toMatchObject({ canonical: 'Newcomer', aliases: ['new comer'] });
    // Keeper's alias and Newcomer; the hit counts never touched the file.
    expect(io.out).toContain('merged 2 changes made elsewhere during review');
    expect(io.out).toContain(`kept 3, deleted 1, edited 1. Wrote ${globalPath}`);
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

  // Catches: a first `lexicon review` said only `no global lexicon at <path>`,
  // and an empty file and a filter that matched none both said `no terms to
  // review`, none of them naming a way on (`lexicon list` names one for each).
  it('a missing lexicon, an empty one and a filter that matches none each name the next step', async () => {
    const missing = makeIO();
    expect(await runReview({ globalPath }, missing, scripted([]))).toBe(0);
    expect(missing.out).toContain(`no global lexicon at ${globalPath} yet; run lexicon setup to create one`);

    await seedGlobal([]);
    const empty = makeIO();
    expect(await runReview({ globalPath, neverHit: true }, empty, scripted([]))).toBe(0);
    expect(empty.out).toContain(`no terms to review in ${globalPath} yet. Try: lexicon add "Ashlr.AI" Ashler`);

    await seedGlobal(terms);
    const miss = makeIO();
    expect(await runReview({ globalPath, category: 'place' }, miss, scripted([]))).toBe(0);
    expect(miss.out).toContain(`no terms to review in ${globalPath}: 4 terms there, none matching --category place (run lexicon review without it to see them)`);
  });

  // Catches: `?` or a mistyped key re-asked `[k/d/e/p/n/q]` with no word
  // on what the letters do; the one line naming them had scrolled away.
  it('an answer that is not a key prints what each key does, in review and harvest -i', async () => {
    await seedGlobal(terms);
    const io = makeIO();
    expect(await runReview({ globalPath, category: 'person' }, io, scripted(['?', 'x', 'k']))).toBe(0);
    const help = '  [k]eep  [d]elete  [e]dit aliases  [p]honetic  [n]otes  [q]uit  (Enter = k)';
    expect(io.out.split('\n').filter((l) => l === help)).toHaveLength(2);
    expect(io.out).toContain('kept 1, deleted 0, edited 0 (nothing written)');

    const h = makeIO();
    expect(await runHarvestInteractive([candidate('Alpha')], { cwd: repo, globalPath }, h, scripted(['h', 'n']))).toBe(0);
    expect(h.out).toContain('  [y]es  [n]o  [e]dit aliases  [c]ategory  [a]ll remaining  [q]uit  (Enter = y)\n');
  });

  // Catches: `q` on term 2 of 4 reported `kept 1, deleted 0, edited 0`, no
  // word on the two terms never shown; and ctrl-D threw `input closed before
  // the prompt was answered`, exit 1, losing the deletion already made with
  // no word on what was kept.
  it('q and ctrl-D say how many terms were not reviewed, and ctrl-D keeps the answers given', async () => {
    await seedGlobal(terms);
    const quit = makeIO();
    expect(await runReview({ globalPath }, quit, scripted(['k', 'q']))).toBe(0);
    expect(quit.out).toContain('kept 1, deleted 0, edited 0, 3 not reviewed (left as they were) (nothing written)');

    const io = makeIO();
    expect(await runReview({ globalPath }, io, closingAfter(['k', 'd']))).toBe(0);
    expect(io.out).toContain('input closed at term 3 of 4; keeping the answers given before it');
    expect(io.out).toContain(`kept 1, deleted 1, edited 0, 2 not reviewed (left as they were). Wrote ${globalPath}`);
    expect((await readYaml(globalPath)).terms.map((t) => t.canonical)).toEqual(['Ashlr.AI', 'Mason Wyatt', 'Keeper']);

    const all = makeIO();
    expect(await runReview({ globalPath }, all, scripted(['k', 'k', 'k']))).toBe(0);
    expect(all.out).toContain('kept 3, deleted 0, edited 0 (nothing written)');
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

  it('--never-hit and the per-term count read a project term from the sidecar', async () => {
    await fs.writeFile(
      projectPath,
      'version: 1\nterms:\n  - canonical: Used\n    aliases: [youzd]\n  - canonical: Cold\n    aliases: [kohld]\n',
      'utf8',
    );
    await trustProject(projectPath, { globalPath });
    await recordHits(['Used', 'Used'], { cwd: repo, globalPath });

    // The count is not in the file any more, so a review that read only the
    // file would offer every project term for deletion, `Used` included.
    const io = makeIO();
    expect(await runReview({ cwd: repo, project: true, neverHit: true, globalPath }, io, scripted(['q']))).toBe(0);
    expect(io.out).toContain('1 term in');
    expect(io.out).toContain('[1/1] Cold');
    expect(io.out).not.toContain('Used');

    const all = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, all, scripted(['q']))).toBe(0);
    expect(all.out).toContain('[1/2] Used  uncategorized, 2 hits');
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

  // Catches: review checked --category itself with a plain Error, so it had
  // none of the nextStep list, add and export give through parseCategory.
  it('an unknown --category carries the same nextStep as list, add and export', async () => {
    await expect(runReview({ globalPath, category: 'nope' }, makeIO(), scripted([]))).rejects.toMatchObject({
      name: 'CliRefusal',
      message: 'unknown category "nope" (expected one of: brand, person, product, acronym, identifier, place, other)',
      nextStep: 'pass one of brand, person, product, acronym, identifier, place, other to --category, or leave --category out',
    });
  });
});

// Catches: `review --json` and `edit --json` were commander usage errors whose
// nextStep was only their --help, which names no way to do the same without a terminal.
describe('review and edit under --json', () => {
  it('review --json refuses with the non-interactive commands and MCP tools, touching nothing', async () => {
    const io = makeIO();
    expect(await runReview({ globalPath, json: true }, io, scripted([]))).toBe(1);
    const doc = JSON.parse(io.out) as { ok: boolean; error: string; nextStep: string };
    expect(doc).toMatchObject({ ok: false, error: 'review is interactive and has no --json output' });
    for (const name of ['lexicon list --json', 'lexicon remove <canonical>', 'lexicon add <canonical>', 'list_terms', 'remove_term', 'add_term']) {
      expect(doc.nextStep).toContain(name);
    }
    expect(io.err).toContain('lexicon: read terms with lexicon list --json');
    expect(io.err).not.toContain('\u2026');
  });

  it('edit --json refuses with add, remove and the MCP tools, and creates no file', async () => {
    const io = makeIO();
    let spawned = false;
    expect(await runEdit({ globalPath, json: true }, io, async () => { spawned = true; return 0; }, { EDITOR: 'x' })).toBe(1);
    expect(spawned).toBe(false);
    const doc = JSON.parse(io.out) as { ok: boolean; error: string; nextStep: string };
    expect(doc).toMatchObject({ ok: false, error: 'edit opens an editor and has no --json output' });
    for (const name of ['lexicon add', 'lexicon remove', 'add_term', 'remove_term']) expect(doc.nextStep).toContain(name);
    await expect(fs.access(globalPath)).rejects.toThrow();
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
    let editor = `${process.execPath} ${script}`;
    if (process.platform !== 'win32') {
      // editorCommand deliberately splits whitespace. A physical editor shim
      // preserves the real subprocess when this exact Node path has spaces.
      const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
      editor = path.join(tmp, 'fixture-editor');
      await fs.writeFile(editor, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
    }
    const io = makeIO();
    const code = await runEdit({ globalPath }, io, undefined, { EDITOR: editor });
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
