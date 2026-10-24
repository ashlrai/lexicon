/**
 * Interactive CLI workflows (harvest --interactive, add -i, review, edit)
 * against a real lexicon in a temp dir, driven by a scripted Prompter.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { reconcileReview, runHarvestInteractive, runReview, runEdit, editorCommand, isTerminalEditor, resolveEditorSpawn } from '../src/cli/cmd-review.js';
import type { SpawnEditor } from '../src/cli/cmd-review.js';
import { runAdd, runHarvest, runRemove } from '../src/cli/commands.js';
import { PromptClosedError, askKey, splitList } from '../src/cli/prompt.js';
import type { Prompter } from '../src/cli/prompt.js';
import { addTerm, isTrusted, loadLexicon, recordHits, trustProject, writeLexiconFile } from '../src/core/index.js';
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
function closingAfter(answers: Parameters<typeof scripted>[0]): Prompter {
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

/**
 * Make the next write of `file` fail (as root too, unlike a chmod): a
 * non-empty directory where writeFileAtomic puts its temp file
 * (`<file>.<pid>.tmp`). Reads and the trust check still see the file.
 */
async function breakWrites(file: string): Promise<void> {
  await fs.mkdir(path.join(`${file}.${process.pid}.tmp`, 'blocker'), { recursive: true });
}

/** `inner`, running `before` once just before the `n`th answer (1-based) is returned. */
function withHook(inner: Prompter, n: number, before: () => Promise<void>): Prompter {
  let count = 0;
  const tick = async (): Promise<void> => {
    count += 1;
    if (count === n) await before();
  };
  return {
    ask: async (question, opts) => {
      await tick();
      return inner.ask(question, opts);
    },
    confirm: async (question, def) => {
      await tick();
      return inner.confirm(question, def);
    },
    choose: async (question, choices, opts) => {
      await tick();
      return inner.choose(question, choices, opts);
    },
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
  // Catches: a walk with nothing to show said only "no candidates to review",
  // not that names were left out by --min-count or as code symbols, that the
  // directory held nothing to read, or that every candidate was already known.
  it('says why there is nothing to review, and what to try', async () => {
    const tty = { isInteractive: () => true, createPrompter: () => scripted([]) };
    const few = path.join(tmp, 'ab');
    await fs.mkdir(few);
    await fs.writeFile(path.join(few, 'README.md'), 'We use the Quokkaflow tool here.\n');
    const once = makeIO();
    expect(await runHarvest(few, { interactive: true, globalPath }, once, tty)).toBe(0);
    expect(once.out).toContain(`no candidates found in ${few}: left out 1 name seen fewer than 2 times (to include them: --min-count 1)`);
    expect(once.out).not.toContain('no candidates to review');
    // Plain harvest says the same.
    const plain = makeIO();
    expect(await runHarvest(few, { globalPath }, plain, { isInteractive: () => false })).toBe(0);
    expect(plain.out).toContain('left out 1 name seen fewer than 2 times');

    const empty = path.join(tmp, 'xy');
    await fs.mkdir(empty);
    const none = makeIO();
    expect(await runHarvest(empty, { interactive: true, globalPath }, none, tty)).toBe(0);
    expect(none.out).toContain(`no candidates found in ${empty}: it holds no package manifest, README or source file`);

    await seedGlobal([{ canonical: 'Alpha', aliases: ['Alpha x', 'Alphay'] }]);
    const known = makeIO();
    expect(await runHarvestInteractive([candidate('Alpha')], { cwd: repo, globalPath }, known, scripted([]))).toBe(0);
    expect(known.out).toContain('nothing to review: the 1 candidate is already in the lexicon with its suggested aliases');
    expect(known.out).not.toContain('[1/1]');
  });

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
    // Catches: the summary ended the run with no next step. One is named only
    // when something was added.
    expect(io.out).toContain('next: run lexicon list to see the terms');
    expect(none.out).not.toContain('next:');
  });

  // Catches: a write that failed for a reason other than trust (a full disk,
  // an unreadable file) was thrown out of the walk, so the terms already
  // added and the summary went unmentioned, and the error came alone.
  it('a failed write stops the walk, says what was added before it, and exits 1', async () => {
    const candidates = [candidate('Alpha'), candidate('Beta'), candidate('Gamma')];
    const io = makeIO();
    const p = withHook(scripted(['y', 'y']), 2, () => breakWrites(projectPath));
    expect(await runHarvestInteractive(candidates, { cwd: repo, globalPath }, io, p)).toBe(1);
    expect(io.err).toMatch(/lexicon: could not write the project lexicon at candidate 2 of 3 \(.+\); the terms added before it stay in the project lexicon/);
    expect(io.out).toContain('added Alpha');
    expect(io.out).toContain(`added 1 new term, merged 0, skipped 2 in ${projectPath}`);

    // The same for `a` (one write for the rest), with nothing added before it.
    await fs.rm(`${projectPath}.${process.pid}.tmp`, { recursive: true, force: true });
    await fs.rm(projectPath, { force: true });
    const all = makeIO();
    const q = withHook(scripted(['a']), 1, () => breakWrites(projectPath));
    expect(await runHarvestInteractive(candidates, { cwd: repo, globalPath }, all, q)).toBe(1);
    expect(all.err).toMatch(/at candidate 1 of 3 \(.+\); nothing was added/);
    expect(all.out).toContain('added 0 new terms, merged 0, skipped 3');
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

  // Catches: the trust refusals went through the 200-character display cap, so a deep repo path cut off the `lexicon trust` next step.
  it('prints the trust refusal for a project lexicon at a long path whole', async () => {
    const deepRepo = path.join(tmp, ...Array.from({ length: 12 }, () => 'nested-directory'), 'repo');
    await fs.mkdir(path.join(deepRepo, '.git'), { recursive: true });
    await fs.writeFile(path.join(deepRepo, 'package.json'), JSON.stringify({ name: 'quokkatron' }), 'utf8');
    const deepProject = path.join(deepRepo, '.lexicon.yaml');
    await fs.writeFile(deepProject, 'version: 1\nterms:\n  - canonical: Proj\n    aliases: [prodge]\n', 'utf8');
    const walk = makeIO();
    expect(await runHarvestInteractive([candidate('Alpha')], { cwd: deepRepo, globalPath }, walk, scripted([]))).toBe(1);
    const add = makeIO();
    expect(await runHarvest(deepRepo, { add: true, yes: true, minCount: 1, globalPath }, add, { isInteractive: () => false })).toBe(1);
    const review = makeIO();
    expect(await runReview({ cwd: deepRepo, project: true, globalPath }, review, scripted([]))).toBe(1);
    for (const io of [walk, add, review]) {
      expect(io.err).toContain(deepProject);
      expect(io.err).toMatch(/run `lexicon trust` first/);
      expect(io.err).not.toContain('\u2026');
    }
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

    // Catches: a bad --limit or --min-count was reported only after the
    // trust refusal, so fixing the trust first still left a bad flag.
    await expect(runHarvest(repo, { add: true, yes: true, limit: '0', globalPath }, makeIO(), { isInteractive: () => false })).rejects.toThrow('--limit must be a positive integer');
    await expect(runHarvest(repo, { add: true, yes: true, minCount: 'x', globalPath }, makeIO(), { isInteractive: () => false })).rejects.toThrow('--min-count must be a positive integer');

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

describe('add with an alias that is the canonical in another case', () => {
  // Catches: `lexicon add Yod yod` dropped the alias silently and printed `aliases: (none)`, in text and --json.
  it('says the alias was not added, in text and --json', async () => {
    const text = makeIO();
    expect(await runAdd('Yod', ['yod'], { cwd: tmp, globalPath }, text)).toBe(0);
    expect(text.out).toContain('aliases: (none)');
    expect(text.out).toContain('note: yod was not added as an alias of Yod: it differs from the canonical only in case');
    const json = makeIO();
    expect(await runAdd('Yod', ['YOD', 'Yodd'], { cwd: tmp, globalPath, json: true }, json)).toBe(0);
    const doc = JSON.parse(json.out);
    expect(doc.term.aliases).toEqual(['Yodd']);
    expect(doc.droppedAliases).toEqual([{ alias: 'YOD', reason: 'differs from the canonical only in case, and matching already ignores case' }]);
    // An ordinary add has no such key.
    const plain = makeIO();
    expect(await runAdd('Zed', ['zedd'], { cwd: tmp, globalPath, json: true }, plain)).toBe(0);
    expect(JSON.parse(plain.out)).not.toHaveProperty('droppedAliases');
  });
});

describe('remove with the canonical in another case', () => {
  // Catches: `lexicon remove yod` said `removed yod` (and `canonical: "yod"` under --json) for the term the file spells "Yod".
  it('reports the stored spelling, in text and --json', async () => {
    await runAdd('Yod', ['yodd'], { cwd: tmp, globalPath }, makeIO());
    await runAdd('Zed', ['zedd'], { cwd: tmp, globalPath }, makeIO());
    process.env.LEXICON_PATH = globalPath;
    const text = makeIO();
    expect(await runRemove('yod', { cwd: tmp }, text)).toBe(0);
    expect(text.out).toContain('removed Yod from');
    const json = makeIO();
    expect(await runRemove('ZED', { cwd: tmp, json: true }, json)).toBe(0);
    expect(JSON.parse(json.out)).toMatchObject({ ok: true, canonical: 'Zed', removed: true });
  });
});

describe('remove --alias that misses', () => {
  // Catches: a miss gave the generic "fix what error names" next step, in text and --json.
  it("names the term's aliases, or how to find the term", async () => {
    await runAdd('Yod', ['yodd', 'yodda'], { cwd: tmp, globalPath }, makeIO());
    process.env.LEXICON_PATH = globalPath;
    const text = makeIO();
    expect(await runRemove('yod', { cwd: tmp, alias: 'nope' }, text)).toBe(1);
    expect(text.err).toContain('lexicon: the aliases of "Yod" are: yodd, yodda; remove one with lexicon remove Yod --alias <alias>\n');
    const json = makeIO();
    expect(await runRemove('Yox', { cwd: tmp, alias: 'nope', json: true }, json)).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, removed: false, nextStep: 'run lexicon list --query Yox to see the exact spellings of the terms' });
  });
});

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

  // Catches: ctrl-D threw `input closed before the prompt was answered`
  // (exit 1) with no word that nothing was added.
  it('ctrl-D at any prompt stops cleanly and says nothing was added', async () => {
    for (const answers of [[], [[1]], [[1], ''], [[1], '', 'ASH-ler']] as Parameters<typeof scripted>[0][]) {
      const io = makeIO();
      expect(await runAdd('Ashlr.AI', [], { interactive: true, globalPath }, io, closingAfter(answers))).toBe(0);
      expect(io.out).toContain('input closed before Ashlr.AI was saved; nothing was added');
      expect(io.out).not.toContain('created');
      await expect(fs.access(globalPath)).rejects.toThrow();
    }
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

  // Catches: `--category other` skipped a term with no category, which list
  // and export count as other.
  it('--category other reviews the terms without a category', async () => {
    await seedGlobal([...terms, { canonical: 'Plain', aliases: ['plane'] }]);
    const io = makeIO();
    expect(await runReview({ globalPath, category: 'other' }, io, scripted(['k']))).toBe(0);
    expect(io.out).toContain('[1/1] Plain');
  });

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
    // Catches: `d` printed `deleted Stale` and the summary `deleted 1`, where
    // `lexicon remove` reports the same outcome as `removed X from <path>`.
    expect(io.out).toContain(`removed Stale from ${globalPath}`);
    expect(io.out).toContain(`kept 3, removed 1, edited 3. Wrote ${globalPath}`);
    expect(io.out).not.toContain('deleted');
    // Catches: the summary ended the run with no next step.
    expect(io.out).toContain('next: run lexicon list to see the terms');
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
    expect(io.out).toContain(`kept 3, removed 1, edited 1. Wrote ${globalPath}`);
  });

  // Catches: a file changed during the review that could not be re-read (a
  // half-done hand edit) was overwritten with the reviewed version, losing
  // what the other writer had put there.
  it('leaves a file changed during the review that cannot be re-read as it is, and exits 1', async () => {
    await seedGlobal(terms);
    const broken = 'version: 1\nterms:\n  - canonical: [unclosed\n';
    const p = withHook(scripted(['d', 'k', 'k', 'k']), 1, () => fs.writeFile(globalPath, broken, 'utf8'));
    const io = makeIO();
    expect(await runReview({ cwd: tmp, globalPath }, io, p)).toBe(1);
    expect(await fs.readFile(globalPath, 'utf8')).toBe(broken);
    expect(io.err).toMatch(/changed during review and cannot be read \(.+\), so nothing was written and this review's 1 removal and 0 edits were not saved; fix the file/);
    expect(io.out).not.toContain('Wrote');
  });

  it('does not report a merge when nothing changed on disk', async () => {
    await seedGlobal(terms);
    const io = makeIO();
    expect(await runReview({ cwd: tmp, globalPath }, io, scripted(['d', 'k', 'k', 'k']))).toBe(0);
    expect(io.out).not.toContain('made elsewhere');
    expect((await readYaml(globalPath)).terms).toHaveLength(3);
  });

  // Catches: reconcileReview keyed canonicals by trim and lowercase only, so a
  // canonical written in NFD on disk was a different term from the session's
  // NFC one and an edited term came out twice.
  it('reconcileReview matches a canonical on disk in another Unicode normal form', () => {
    const session: Term = { canonical: 'Caf\u00e9', aliases: ['kafay'] };
    const disk: Term = { canonical: 'Cafe\u0301', aliases: [], hits: 3 };
    const snapshot = new Map([['caf\u00e9', JSON.stringify(session)]]);
    const merged = reconcileReview([session], snapshot, [disk], new Set([session]), new Set());
    expect(merged.terms).toHaveLength(1);
    expect(merged.terms[0]).toMatchObject({ canonical: 'Caf\u00e9', aliases: ['kafay'], hits: 3 });
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

  // Catches: `review --project` with no project file said `run: lexicon init
  // --project`, which makes an empty file that review then has nothing in.
  it('--project with no project file names a step that gives review terms', async () => {
    await expect(runReview({ cwd: repo, project: true, globalPath }, makeIO(), scripted([]))).rejects.toThrow(
      `no project lexicon found for ${repo}, so nothing to review yet ` +
        '(run: lexicon harvest -i to pull names from this repo, or lexicon add "Ashlr.AI" Ashler --project)',
    );
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
    expect(io.out).toContain('kept 1, removed 0, edited 0 (nothing written)');

    const h = makeIO();
    expect(await runHarvestInteractive([candidate('Alpha')], { cwd: repo, globalPath }, h, scripted(['h', 'n']))).toBe(0);
    expect(h.out).toContain('  [y]es  [n]o  [e]dit aliases  [c]ategory  [a]ll remaining  [q]uit  (Enter = y)\n');
  });

  // Catches: `q` on term 2 of 4 reported `kept 1, removed 0, edited 0`, no
  // word on the two terms never shown; and ctrl-D threw `input closed before
  // the prompt was answered`, exit 1, losing the deletion already made with
  // no word on what was kept.
  // Catches: a failed final write was thrown out of review with only the
  // error, so nothing said that every answer given was lost with it.
  it('a write that fails says the answers were not saved and exits 1', async () => {
    await seedGlobal(terms);
    const io = makeIO();
    const p = withHook(scripted(['d', 'k', 'k', 'k']), 4, () => breakWrites(globalPath));
    expect(await runReview({ globalPath }, io, p)).toBe(1);
    expect(io.err).toMatch(new RegExp(`lexicon: could not write ${globalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(.+\\); nothing was written, so this review's 1 removal and 0 edits were not saved`));
    expect(io.out).not.toContain('Wrote');
  });

  // Catches: a term edited with p (or e, n) and then left with q or ctrl-D was
  // counted among the terms "not reviewed (left as they were)", though its
  // edit was written.
  it('a term edited before q or ctrl-D is not counted as left as it was', async () => {
    await seedGlobal(terms);
    const quit = makeIO();
    expect(await runReview({ globalPath }, quit, scripted(['k', 'p', 'STAYL', 'q']))).toBe(0);
    expect(quit.out).toContain(`kept 1, removed 0, edited 1, 2 not reviewed (left as they were). Wrote ${globalPath}`);
    expect((await readYaml(globalPath)).terms.find((t) => t.canonical === 'Stale')?.phonetic).toBe('STAYL');

    await seedGlobal(terms);
    const closed = makeIO();
    expect(await runReview({ globalPath }, closed, closingAfter(['k', 'n', 'a note']))).toBe(0);
    expect(closed.out).toContain('input closed at term 2 of 4; keeping the answers given before it');
    expect(closed.out).toContain(`kept 1, removed 0, edited 1, 2 not reviewed (left as they were). Wrote ${globalPath}`);
  });

  it('q and ctrl-D say how many terms were not reviewed, and ctrl-D keeps the answers given', async () => {
    await seedGlobal(terms);
    const quit = makeIO();
    expect(await runReview({ globalPath }, quit, scripted(['k', 'q']))).toBe(0);
    expect(quit.out).toContain('kept 1, removed 0, edited 0, 3 not reviewed (left as they were) (nothing written)');

    const io = makeIO();
    expect(await runReview({ globalPath }, io, closingAfter(['k', 'd']))).toBe(0);
    expect(io.out).toContain('input closed at term 3 of 4; keeping the answers given before it');
    expect(io.out).toContain(`kept 1, removed 1, edited 0, 2 not reviewed (left as they were). Wrote ${globalPath}`);
    expect((await readYaml(globalPath)).terms.map((t) => t.canonical)).toEqual(['Ashlr.AI', 'Mason Wyatt', 'Keeper']);

    const all = makeIO();
    expect(await runReview({ globalPath }, all, scripted(['k', 'k', 'k']))).toBe(0);
    expect(all.out).toContain('kept 3, removed 0, edited 0 (nothing written)');
    expect(all.out).not.toContain('next:');
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

  // Catches: a trusted project file rewritten by hand (a git pull) during the review had its unreviewed terms merged
  // into the review's write, which then re-pinned trust, so terms nobody ran lexicon trust on became trusted.
  it('--project does not merge and trust a project file someone else rewrote during the review', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Proj\n    aliases: [prodge]\n  - canonical: Old\n    aliases: [olde]\n', 'utf8');
    await trustProject(projectPath, { globalPath });
    const pulled = 'version: 1\nterms:\n  - canonical: Proj\n    aliases: [prodge]\n  - canonical: Old\n    aliases: [olde]\n  - canonical: Planted\n    aliases: [the]\n';
    const inner = scripted(['d', 'k']);
    let rewritten = false;
    const p: Prompter = {
      ...inner,
      async ask(question, opts) {
        const answer = await inner.ask(question, opts);
        if (!rewritten) {
          rewritten = true;
          await fs.writeFile(projectPath, pulled, 'utf8');
        }
        return answer;
      },
    };
    const io = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, io, p)).toBe(1);
    expect(io.err).toMatch(/changed during review and is not trusted/);
    expect(await fs.readFile(projectPath, 'utf8')).toBe(pulled);
    expect(await isTrusted({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [] }, exists: true }, { globalPath })).toBe('changed');
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

  // Catches: a quoted editor path with a space in it was split at the space and run as `"/Applications/Sublime`, failing with ENOENT.
  it('editorCommand keeps a quoted editor path with spaces whole', () => {
    expect(editorCommand({ EDITOR: '"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" -w' })).toEqual({
      command: '/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl',
      args: ['-w'],
    });
    expect(editorCommand({ EDITOR: '"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst' })).toEqual({
      command: 'C:\\Program Files\\Notepad++\\notepad++.exe',
      args: ['-multiInst'],
    });
    expect(editorCommand({ VISUAL: "'/opt/my editor/ed' --title 'Lexicon file'" })).toEqual({ command: '/opt/my editor/ed', args: ['--title', 'Lexicon file'] });
    expect(editorCommand({ EDITOR: 'code   --wait  ' })).toEqual({ command: 'code', args: ['--wait'] });
    expect(editorCommand({ EDITOR: '""' })).toBeUndefined();
  });

  // Catches: an $EDITOR naming no program ended with only `spawn <name> ENOENT`, thrown, with no variable or file named.
  it('says which variable names an editor that cannot be started, and where the file is', async () => {
    const io = makeIO();
    const spawnFails: SpawnEditor = async () => {
      throw Object.assign(new Error('spawn nonexistent-ed ENOENT'), { code: 'ENOENT' });
    };
    expect(await runEdit({ globalPath }, io, spawnFails, { EDITOR: 'nonexistent-ed -w' })).toBe(1);
    expect(io.err).toContain('lexicon: could not start the editor $EDITOR names (nonexistent-ed): spawn nonexistent-ed ENOENT');
    expect(io.err).toContain(`lexicon: set $EDITOR to an editor on your PATH (e.g. EDITOR=vi), or edit the file directly: ${globalPath}`);
    const visual = makeIO();
    expect(await runEdit({ globalPath }, visual, spawnFails, { VISUAL: 'nope', EDITOR: 'vi' })).toBe(1);
    expect(visual.err).toContain('the editor $VISUAL names (nope)');
  });

  it('prints the path when no editor is configured (creating a missing global file)', async () => {
    const io = makeIO();
    expect(await runEdit({ globalPath }, io, undefined, {})).toBe(0);
    expect(io.out).toContain(`created global lexicon: ${globalPath}`);
    expect(io.out).toContain('no $VISUAL or $EDITOR set');
    expect(io.out).toContain(globalPath);
    expect((await readYaml(globalPath)).terms).toEqual([]);
    // Catches: the path was the last word, with nothing to check the edit
    // afterwards, and for a project file no word that a hand edit leaves it
    // untrusted (its terms unused) until `lexicon trust`.
    expect(io.out).toContain('after saving, check it with: lexicon doctor');
    await fs.writeFile(projectPath, 'version: 1\nterms: []\n', 'utf8');
    await trustProject(projectPath, { cwd: repo, globalPath });
    const project = makeIO();
    expect(await runEdit({ cwd: repo, project: true, globalPath }, project, undefined, {})).toBe(0);
    expect(project.out).toContain(projectPath);
    expect(project.out).toContain('after saving, run: lexicon trust (it shows the terms and trusts the file; until then its terms are not used)');
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

  // Catches: the parse error went through the 200-character display cap, so a deep lexicon path cut it off before the reason.
  it('prints the whole parse error for a lexicon at a long path', async () => {
    const deep = path.join(tmp, ...Array.from({ length: 12 }, () => 'nested-directory'), 'lexicon.yaml');
    await fs.mkdir(path.dirname(deep), { recursive: true });
    const spawnEditor: SpawnEditor = async (_cmd, _args, file) => {
      await fs.writeFile(file, 'version: 1\nterms:\n  - canonical: ""\n    aliases: [x]\n', 'utf8');
      return 0;
    };
    const io = makeIO();
    expect(await runEdit({ globalPath: deep }, io, spawnEditor, { EDITOR: 'fake' })).toBe(1);
    expect(io.err).toContain(`Invalid lexicon at ${deep}:`);
    expect(io.err).toContain('terms[0].canonical');
    expect(io.err).toContain(`your edits are still in ${deep};`);
    expect(io.err).not.toContain('\u2026');
    // The path to edit by hand, when no editor is set, is printed whole too.
    const none = makeIO();
    const fresh = path.join(path.dirname(deep), 'fresh.yaml');
    expect(await runEdit({ globalPath: fresh }, none, undefined, {})).toBe(0);
    expect(none.out).toContain(`\n${fresh}\n`);
    expect(none.out).not.toContain('\u2026');
  });

  // Catches: an editor that exited non-zero (vim `:cq` after a `:w`) was only noted, and the file it left was re-trusted.
  it('treats a non-zero editor exit as aborted and does not re-trust the file', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Seed\n    aliases: [seed]\n', 'utf8');
    await trustProject(projectPath, { globalPath });
    const spawnEditor: SpawnEditor = async (_cmd, _args, file) => {
      await fs.appendFile(file, '  - canonical: Proj\n    aliases: [prodge]\n', 'utf8');
      return 1;
    };
    const io = makeIO();
    expect(await runEdit({ cwd: repo, project: true, globalPath }, io, spawnEditor, { EDITOR: 'vim' }, () => true)).toBe(1);
    expect(io.err).toContain('vim exited with code 1, so the edit is treated as aborted and the project lexicon was not re-trusted');
    expect(io.err).toContain('changed anyway, so its terms are not used until you review it and run: lexicon trust');
    expect(io.out).not.toContain('re-trusted');
    expect(await isTrusted({ path: projectPath, scope: 'project', lexicon: { version: 1, terms: [] }, exists: true }, { cwd: repo, globalPath })).toBe('changed');
  });

  it('passes editor arguments through and re-trusts an edited trusted project file', async () => {
    await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Seed\n    aliases: [seed]\n', 'utf8');
    await trustProject(projectPath, { globalPath });
    const calls: { cmd: string; args: readonly string[]; file: string }[] = [];
    const spawnEditor: SpawnEditor = async (cmd, args, file) => {
      calls.push({ cmd, args, file });
      await fs.appendFile(file, '  - canonical: Proj\n    aliases: [prodge]\n', 'utf8');
      return 0;
    };
    const io = makeIO();
    expect(await runEdit({ cwd: repo, project: true, globalPath }, io, spawnEditor, { VISUAL: 'code --wait' })).toBe(0);
    expect(calls).toEqual([{ cmd: 'code', args: ['--wait'], file: projectPath }]);
    expect(io.out).toContain('ok: 2 terms in');
    expect(io.out).toContain('re-trusted');
    // A follow-up project-scope write goes through, so the hash was re-pinned.
    const review = makeIO();
    expect(await runReview({ cwd: repo, project: true, globalPath }, review, scripted(['k', 'k']))).toBe(0);
    expect(review.out).toContain('[2/2] Proj');
  });

  // Catches: with no terminal (a pipe, CI, an agent's shell) `lexicon edit` started vim anyway and hung waiting for keys.
  it('refuses a terminal editor without a terminal, before creating anything, and still runs a GUI editor', async () => {
    const fresh = path.join(tmp, 'no-tty', 'lexicon.yaml');
    let spawned = 0;
    const spawnEditor: SpawnEditor = async () => {
      spawned++;
      return 0;
    };
    for (const env of [{ EDITOR: 'vim' }, { VISUAL: '/usr/bin/nvim' }, { EDITOR: 'emacs -nw' }, { EDITOR: 'nano' }]) {
      const io = makeIO();
      expect(await runEdit({ globalPath: fresh }, io, spawnEditor, env, () => false)).toBe(1);
      expect(io.err).toContain('is a terminal editor, and stdin and stdout are not both a terminal, so it would wait for input that never comes');
      expect(io.err).toContain(`edit the file directly: ${fresh}`);
      expect(io.err).toContain(env.VISUAL ? '$VISUAL (/usr/bin/nvim)' : '$EDITOR (');
    }
    expect(spawned).toBe(0);
    await expect(fs.stat(fresh)).rejects.toThrow();
    // A GUI editor opens its own window, and a terminal one runs in a terminal.
    expect(await runEdit({ globalPath: fresh }, makeIO(), spawnEditor, { VISUAL: 'code --wait' }, () => false)).toBe(0);
    expect(await runEdit({ globalPath: fresh }, makeIO(), spawnEditor, { EDITOR: 'vim' }, () => true)).toBe(0);
    expect(spawned).toBe(2);
  });

  it('isTerminalEditor tells terminal editors from GUI ones', () => {
    for (const [cmd, args] of [['vi', []], ['vim', []], ['C:\\Tools\\nvim.exe', []], ['nano', []], ['emacs', ['-nw']], ['emacsclient', ['-t']], ['hx', []]] as const) {
      expect(isTerminalEditor(cmd, args)).toBe(true);
    }
    for (const [cmd, args] of [['code', ['--wait']], ['subl', ['-w']], ['gvim', ['-f']], ['vim', ['-g']], ['emacs', []], ['emacsclient', ['-c']], ['notepad', []]] as const) {
      expect(isTerminalEditor(cmd, args)).toBe(false);
    }
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

describe('resolveEditorSpawn', () => {
  const winFiles = (...files: string[]) => (p: string): boolean => files.map((f) => f.toLowerCase()).includes(p.toLowerCase());

  it('runs the command itself on POSIX, whatever PATH holds', () => {
    expect(resolveEditorSpawn('code', ['--wait'], '/home/u/lexicon.yaml', 'linux', { PATH: '/usr/bin' }, () => true)).toEqual({
      file: 'code',
      args: ['--wait', '/home/u/lexicon.yaml'],
      windowsVerbatimArguments: false,
    });
  });

  // Catches: on win32 `code --wait` (code.cmd on PATH) was spawned without a shell and failed with ENOENT.
  it('runs a .cmd shim found through PATHEXT on win32 through cmd.exe, the file path quoted and escaped', () => {
    const env = { Path: 'C:\\Windows;C:\\Program Files\\Microsoft VS Code\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };
    const run = resolveEditorSpawn('code', ['--wait'], 'C:\\Users\\A & B\\100%\\lexicon.yaml', 'win32', env, winFiles('C:\\Program Files\\Microsoft VS Code\\bin\\code.CMD'));
    expect(run.file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(run.windowsVerbatimArguments).toBe(true);
    expect(run.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(run.args[3]).toBe(
      '"C:\\Program^ Files\\Microsoft^ VS^ Code\\bin\\code.CMD ^"--wait^" ^"C:\\Users\\A^ ^&^ B\\100^%\\lexicon.yaml^""',
    );
  });

  it('runs a .exe or an unresolved editor directly on win32, and a .bat named with its path through cmd.exe', () => {
    const env = { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' };
    expect(resolveEditorSpawn('notepad', [], 'C:\\l.yaml', 'win32', env, winFiles('C:\\Tools\\notepad.exe'))).toEqual({
      file: 'notepad',
      args: ['C:\\l.yaml'],
      windowsVerbatimArguments: false,
    });
    expect(resolveEditorSpawn('nope', [], 'C:\\l.yaml', 'win32', env, () => false).file).toBe('nope');
    const bat = resolveEditorSpawn('C:\\Ed\\ed.bat', ['-w'], 'C:\\l.yaml', 'win32', env, winFiles('C:\\Ed\\ed.bat'));
    expect(bat).toEqual({ file: 'cmd.exe', args: ['/d', '/s', '/c', '"C:\\Ed\\ed.bat ^"-w^" ^"C:\\l.yaml^""'], windowsVerbatimArguments: true });
  });
});
