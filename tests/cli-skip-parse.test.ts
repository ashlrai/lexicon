/**
 * The read-only CLI commands name a skipped (untrusted or changed) project
 * `.lexicon.yaml` by path only, so they must load with `parseSkipped: false`
 * and never parse it. `loadLexicon` is the real one, wrapped in a spy, over
 * a scratch global lexicon and repo, and the schema module counts which
 * files reach `parseLexicon`, so the tests see the parse itself and not only
 * the option that should prevent it.
 */
import { promises as fs, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Every canonical `parseLexicon` saw: `Kubectl` there means the project file was parsed. */
const schemaParses = vi.hoisted(() => ({ canonicals: [] as string[] }));
vi.mock('../src/core/schema.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/core/schema.js')>();
  return {
    ...real,
    parseLexicon: (raw: unknown) => {
      const terms = (raw as { terms?: unknown } | null)?.terms;
      if (Array.isArray(terms)) {
        for (const t of terms) if (typeof (t as { canonical?: unknown })?.canonical === 'string') schemaParses.canonicals.push((t as { canonical: string }).canonical);
      }
      return real.parseLexicon(raw);
    },
  };
});

vi.mock('../src/core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/index.js')>();
  return { ...actual, loadLexicon: vi.fn(actual.loadLexicon) };
});

import * as core from '../src/core/index.js';
import { runAdd, runExport, runList, runNormalize } from '../src/cli/commands.js';
import { runPackList, runPackSearch } from '../src/cli/cmd-pack.js';
import { runStats } from '../src/cli/cmd-learn.js';
import { makeIO } from './helpers.js';

const PACK = 'name: cardiology\ntitle: Cardiology terms\ndescription: Heart words.\nversion: 1\nterms:\n  - canonical: Metoprolol\n    aliases: [metropolol]\n';

let tmp: string;
let globalPath: string;
let repo: string;
let projectPath: string;
let indexPath: string;
let prevPath: string | undefined;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-skip-parse-')));
  globalPath = path.join(tmp, 'config', 'lexicon.yaml');
  await fs.mkdir(path.dirname(globalPath), { recursive: true });
  await fs.writeFile(globalPath, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
  repo = path.join(tmp, 'repo');
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  projectPath = path.join(repo, '.lexicon.yaml');
  await fs.writeFile(projectPath, 'version: 1\nterms:\n  - canonical: Kubectl\n    aliases: [cube control]\n');
  writeFileSync(path.join(tmp, 'cardiology.yaml'), PACK);
  indexPath = path.join(tmp, 'index.yaml');
  writeFileSync(
    indexPath,
    `version: 1\npacks:\n  - author: example\n    name: cardiology\n    title: Cardiology terms\n    description: Heart words.\n    version: "1"\n    terms: 1\n    aliases: 1\n    checksum: ${core.sha256Hex(Buffer.from(PACK))}\n    url: ./cardiology.yaml\n`,
  );
  prevPath = process.env.LEXICON_PATH;
  process.env.LEXICON_PATH = globalPath;
  vi.mocked(core.loadLexicon).mockClear();
});

afterEach(async () => {
  if (prevPath === undefined) delete process.env.LEXICON_PATH;
  else process.env.LEXICON_PATH = prevPath;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('read-only CLI commands and an untrusted project lexicon', () => {
  // Catches: list, normalize, export, pack list, pack search, stats and the
  // add conflict check parsed the untrusted file only to leave it out.
  it('load with parseSkipped: false and still name the skipped file by path', async () => {
    const runs: Array<[string, (io: ReturnType<typeof makeIO>) => Promise<number>]> = [
      ['list', (io) => runList({ cwd: repo, full: true }, io)],
      ['normalize', (io) => runNormalize(['ping', 'Ashler'], { cwd: repo, json: true }, io)],
      ['export', (io) => runExport('claude-md', { cwd: repo, json: true }, io)],
      ['pack list', (io) => runPackList({ cwd: repo, globalPath, json: true }, io)],
      ['pack search', (io) => runPackSearch('cardio', { cwd: repo, globalPath, registry: indexPath, json: true }, io)],
      ['stats', (io) => runStats({ cwd: repo, json: true }, io)],
    ];
    for (const [name, run] of runs) {
      vi.mocked(core.loadLexicon).mockClear();
      schemaParses.canonicals.length = 0;
      const io = makeIO();
      expect(await run(io), `${name}: ${io.err}`).toBe(0);
      // The project file never reached the parser; the global one did.
      expect(schemaParses.canonicals, name).not.toContain('Kubectl');
      expect(core.loadLexicon, name).toHaveBeenCalledTimes(1);
      expect(vi.mocked(core.loadLexicon).mock.calls[0]?.[0], name).toMatchObject({ cwd: repo, parseSkipped: false });
      const out = JSON.parse(io.out) as { skippedProject?: string; projectTrust?: string };
      expect(out.skippedProject, name).toBe(projectPath);
      expect(out.projectTrust, name).toBe('untrusted');
      expect(io.out, name).not.toContain('Kubectl');
      expect(io.err, name).toContain(`untrusted project lexicon skipped: ${projectPath}`);
    }

    // add writes the global file, then checks for conflicts over the merged terms.
    vi.mocked(core.loadLexicon).mockClear();
    schemaParses.canonicals.length = 0;
    const io = makeIO();
    expect(await runAdd('Zed', ['zedd'], { cwd: repo, globalPath, json: true }, io), io.err).toBe(0);
    expect(core.loadLexicon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.loadLexicon).mock.calls[0]?.[0]).toMatchObject({ cwd: repo, parseSkipped: false });
    expect(schemaParses.canonicals).toContain('Zed');
    expect(schemaParses.canonicals).not.toContain('Kubectl');
  });

  it('normalize --include-untrusted still merges the project file', async () => {
    const io = makeIO();
    schemaParses.canonicals.length = 0;
    expect(await runNormalize(['run', 'cube', 'control'], { cwd: repo, includeUntrusted: true }, io)).toBe(0);
    expect(io.out).toBe('run Kubectl\n');
    // The counter does see a project parse when there is one.
    expect(schemaParses.canonicals).toContain('Kubectl');
  });
});
