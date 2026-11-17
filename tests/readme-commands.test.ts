/**
 * Every `lexicon ...` command in a README shell block or inline code must name a command the
 * CLI registers and only flags that command (or the program) accepts. The
 * check walks the Commander tree, so a renamed command or dropped flag fails
 * here instead of sending a reader to an error. Positional text in quotes is
 * ignored; running each command for real is verified by hand (see BRIDGE_NOTES).
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { makeIO } from './helpers.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/**
 * The `lexicon` invocations in fenced shell blocks, with quoted text blanked
 * and trailing `# comments` removed. Lines that start with `#` (sample output)
 * are not invocations and are skipped.
 */
export function readmeInvocations(text: string): string[] {
  const found: string[] = [];
  for (const block of text.matchAll(/```(?:bash|sh|shell)\n([\s\S]*?)```/g)) {
    for (const raw of block[1].split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('lexicon ')) continue;
      found.push(line.replace(/"[^"]*"/g, '""').replace(/\s#.*$/, '').trim());
    }
  }
  for (const match of text.replace(/```[\s\S]*?```/g, "").matchAll(/`(lexicon(?:\s+[^`]+)?)`/g)) {
    found.push(match[1]);
  }
  return found;
}

/** The command a line names: descend through subcommands (name or alias) while the next word matches one. */
function resolveCommand(program: Command, words: string[]): { chain: Command[]; rest: string[] } {
  const chain: Command[] = [];
  let scope = program;
  let i = 0;
  for (; i < words.length; i++) {
    const next = scope.commands.find((sub) => sub.name() === words[i] || sub.aliases().includes(words[i]));
    if (!next) break;
    chain.push(next);
    scope = next;
  }
  return { chain, rest: words.slice(i) };
}

const LONG_FLAG = /^--[a-z][a-z0-9-]*/;

describe('README lexicon commands match the CLI', () => {
  const program = buildProgram(makeIO());
  const invocations = readmeInvocations(readme);

  it('finds the README command examples, so the scan cannot pass on an empty list', () => {
    expect(invocations.length).toBeGreaterThanOrEqual(10);
  });

  it.each([...new Set(invocations)])('%s uses a registered command and known flags', (line) => {
    const words = line.replace(/^lexicon\s+/, '').split(/\s+/).filter(Boolean);
    const { chain } = resolveCommand(program, words);
    expect(chain.length > 0 || words.every((word) => word.startsWith('-')), `no registered command in: ${line}`).toBe(true);
    const leaf = chain.at(-1);
    const next = words[chain.length];
    if (leaf && leaf.commands.length && leaf.registeredArguments.length === 0 && next && !next.startsWith('-')) {
      expect.fail(`unknown subcommand ${next} in: ${line}`);
    }

    // Flags the program and every command on the chain accept.
    const accepted = new Set<string>(['--help', '-h']);
    for (const cmd of [program, ...chain]) {
      for (const option of cmd.options) {
        if (option.long) accepted.add(option.long);
        if (option.short) accepted.add(option.short);
      }
    }
    const flags = words.map((w) => w.split('=')[0]).filter((w) => LONG_FLAG.test(w) || /^-[a-zA-Z]$/.test(w));
    for (const flag of flags) {
      expect(accepted.has(flag), `${flag} is not an option of ${chain.map((c) => c.name()).join(' ')} (in: ${line})`).toBe(true);
    }
  });
});
