/**
 * A tiny interactive prompt helper over node:readline. No dependencies, no
 * ANSI beyond bold/dim (and only when the output is a terminal). The CLI
 * commands that walk the user through candidates or terms take a `Prompter`
 * so tests can script the answers instead of driving a pty.
 */
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';

export interface PromptChoice<T> {
  label: string;
  value: T;
}

export interface Prompter {
  /** Ask a free-text question. Enter with no input returns `opts.default` (or ''). */
  ask(question: string, opts?: { default?: string }): Promise<string>;
  /** Yes/no question; Enter returns `def` (default false). */
  confirm(question: string, def?: boolean): Promise<boolean>;
  /**
   * Pick from a numbered list. Single choice: a number (Enter = the first).
   * Multi choice: every item starts selected; the user types numbers to
   * toggle, `a` (all), `n` (none), and Enter to accept.
   */
  choose<T>(question: string, choices: PromptChoice<T>[], opts?: { multi?: boolean }): Promise<T[]>;
  close(): void;
}

export interface PrompterIO {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Text styling that only emits escape codes when `output` is a terminal. */
export interface Styler {
  bold(s: string): string;
  dim(s: string): string;
}

/** Thrown by a prompter when its input closes (EOF, ctrl-D) before an answer arrives. */
export class PromptClosedError extends Error {
  constructor() {
    super('input closed before the prompt was answered');
    this.name = 'PromptClosedError';
  }
}

function outputIsTTY(output: NodeJS.WritableStream | undefined): boolean {
  return Boolean((output as { isTTY?: boolean } | undefined)?.isTTY);
}

export function styler(output: NodeJS.WritableStream | undefined = process.stdout): Styler {
  const tty = outputIsTTY(output);
  const paint =
    (code: string) =>
    (s: string): string =>
      tty ? `\x1b[${code}m${s}\x1b[0m` : s;
  return { bold: paint('1'), dim: paint('2') };
}

/** True when both stdin and stdout are terminals, i.e. a human can answer prompts. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Split `a, b,c` into trimmed, non-empty, case-insensitively deduped items. */
export function splitList(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const v = raw.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

/**
 * Ask for a single-key answer from `keys` (first character of the line,
 * case-insensitive). Repeats until a listed key is given; an empty line
 * returns `def` when provided.
 */
export async function askKey(
  prompter: Prompter,
  question: string,
  keys: readonly string[],
  def?: string,
): Promise<string> {
  for (;;) {
    const raw = (await prompter.ask(question)).trim().toLowerCase();
    if (raw === '' && def !== undefined) return def;
    const key = raw.charAt(0);
    if (key && keys.includes(key)) return key;
  }
}

export function createPrompter(io: PrompterIO = {}): Prompter {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const { bold, dim } = styler(output);
  let rl: Interface | undefined;
  let closed = false;
  // Lines are buffered rather than read with rl.question(): question() only
  // captures the line typed AFTER it is asked, so type-ahead, a paste of
  // several answers or a chunked pipe would lose lines and hang the next prompt.
  const lines: string[] = [];
  const waiters: { resolve: (line: string) => void; reject: (err: Error) => void }[] = [];

  const ensure = (): Interface => {
    if (!rl) {
      rl = createInterface({ input, output, terminal: outputIsTTY(output) });
      rl.on('line', (text) => {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(text);
        else lines.push(text);
      });
      rl.on('close', () => {
        closed = true;
        for (const waiter of waiters.splice(0)) waiter.reject(new PromptClosedError());
      });
    }
    return rl;
  };

  const readLine = (prompt: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const iface = closed ? undefined : ensure();
      if (lines.length > 0) {
        output.write(prompt);
        resolve(lines.shift() as string);
        return;
      }
      if (!iface) {
        reject(new PromptClosedError());
        return;
      }
      waiters.push({ resolve, reject });
      iface.setPrompt(prompt);
      iface.prompt();
    });

  const write = (s: string): void => {
    output.write(s);
  };

  const ask = async (question: string, opts: { default?: string } = {}): Promise<string> => {
    const hint = opts.default ? dim(` [${opts.default}]`) : '';
    const answer = (await readLine(`${question}${hint} `)).trim();
    return answer === '' && opts.default !== undefined ? opts.default : answer;
  };

  const confirm = async (question: string, def = false): Promise<boolean> => {
    for (;;) {
      const hint = def ? 'Y/n' : 'y/N';
      const answer = (await readLine(`${question} ${dim(`[${hint}]`)} `)).trim().toLowerCase();
      if (answer === '') return def;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
    }
  };

  const chooseOne = async <T>(question: string, choices: PromptChoice<T>[]): Promise<T[]> => {
    write(`${bold(question)}\n`);
    choices.forEach((c, i) => write(`  ${i + 1}) ${c.label}\n`));
    for (;;) {
      const answer = (await readLine(`${dim('number')} [1] `)).trim();
      if (answer === '') return [choices[0].value];
      const n = Number.parseInt(answer, 10);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return [choices[n - 1].value];
      write(`  enter a number between 1 and ${choices.length}\n`);
    }
  };

  const chooseMany = async <T>(question: string, choices: PromptChoice<T>[]): Promise<T[]> => {
    const selected = choices.map(() => true);
    const render = (): void => {
      write(`${bold(question)}\n`);
      choices.forEach((c, i) => write(`  ${selected[i] ? '[x]' : '[ ]'} ${i + 1}) ${c.label}\n`));
    };
    render();
    for (;;) {
      const answer = (await readLine(`${dim('toggle numbers (e.g. 2,3), a=all, n=none, Enter=done')} `))
        .trim()
        .toLowerCase();
      if (answer === '') break;
      if (answer === 'a') selected.fill(true);
      else if (answer === 'n') selected.fill(false);
      else {
        const nums = answer.split(/[\s,]+/).filter(Boolean);
        let ok = true;
        for (const s of nums) {
          const n = Number.parseInt(s, 10);
          if (!Number.isInteger(n) || n < 1 || n > choices.length) {
            ok = false;
            break;
          }
        }
        if (!ok) {
          write(`  enter numbers between 1 and ${choices.length}\n`);
          continue;
        }
        for (const s of nums) {
          const idx = Number.parseInt(s, 10) - 1;
          selected[idx] = !selected[idx];
        }
      }
      render();
    }
    return choices.filter((_, i) => selected[i]).map((c) => c.value);
  };

  return {
    ask,
    confirm,
    choose: <T>(question: string, choices: PromptChoice<T>[], opts: { multi?: boolean } = {}): Promise<T[]> => {
      if (choices.length === 0) return Promise.resolve([]);
      return opts.multi ? chooseMany(question, choices) : chooseOne(question, choices);
    },
    close: (): void => {
      closed = true;
      rl?.close();
      rl = undefined;
    },
  };
}
