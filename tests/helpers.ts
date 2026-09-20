/**
 * Fakes shared by the CLI suites. Each of these existed in four to seven
 * copies, which is how two of them quietly drifted apart; keep new ones here
 * rather than next to the first test that needs them.
 */
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
