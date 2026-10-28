/**
 * Fakes shared by the CLI suites. Each of these existed in four to seven
 * copies, which is how two of them quietly drifted apart; keep new ones here
 * rather than next to the first test that needs them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IO } from '../src/cli/io.js';
import type { PromptChoice, Prompter } from '../src/cli/prompt.js';

/** An `IO` that accumulates what a handler printed, so a test can assert on it. */
export function makeIO(): IO & { out: string; err: string } {
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

/** One scripted answer: free text, a choice index, or several indices for a multi-select. */
export type Answer = string | number | number[];

/**
 * A `Prompter` that replays `answers` in order and records every question it
 * was asked. Running out of answers throws rather than returning a default, so
 * an unexpected extra prompt fails the test instead of being silently accepted.
 */
export function scripted(answers: Answer[]): Prompter & { asked: string[]; closed: boolean } {
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

/**
 * `s` single-quoted as a printed command quotes a word that needs it, written
 * out for each platform rather than through the code's own helper: POSIX
 * (`'` as `'\''`), or on Windows PowerShell (`'` doubled).
 */
export function quotedForShell(s: string): string {
  return process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`;
}

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Compile `source` once into a plain-JavaScript entry at `outFile` that a
 * bare `node` child process runs, for tests that need real, separate
 * processes (a cross-process lock cannot be shown from inside the suite).
 *
 * The entries this replaces ran under `node --import tsx`, which pays the
 * TypeScript transform in every child: about two seconds each on a quiet
 * machine, and on a loaded runner enough that a dozen children all starting
 * together convoyed behind the lexicon lock and the tail of the queue timed
 * out. One bundle turns each child into the same ~50 ms of startup the
 * shipped CLI pays. Imports in `source` resolve from the repository root, so
 * `'./src/core/store.js'` names the same file it would anywhere else in the
 * repo; the `require` shim is the one scripts/build-bundle.mjs gives the
 * plugin bundles for the same reason (bundled CommonJS still calls it).
 */
export async function bundleChildEntry(source: string, outFile: string): Promise<string> {
  const { build } = await import('esbuild');
  await build({
    stdin: { contents: source, resolveDir: REPO_ROOT, sourcefile: 'child-entry.mts', loader: 'ts' },
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    legalComments: 'none',
    logLevel: 'silent',
  });
  return outFile;
}
