import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { processIO } from '../src/cli/args.js';

const doc = readFileSync(new URL('../docs/source-versus-npm-commands.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('source versus npm command comparison', () => {
  it('dates and attributes the historical npm comparison and explains how to verify it', () => {
    expect(index).toContain('[source-versus-npm-commands.md](source-versus-npm-commands.md)');
    expect(doc).toContain('https://github.com/ashlrai/lexicon/issues/221');
    expect(doc).toContain('2026-10-26');
    expect(doc).toContain('0.5.4');
    expect(doc).toContain('historical snapshot');
    for (const check of ['command -v lexicon', 'lexicon --version', 'lexicon --help', 'lexicon doctor --help', 'npm view @ashlr/lexicon version']) {
      expect(doc).toContain(check);
    }
  });

  it('keeps each reported source-only item tied to a command or option in the source CLI', () => {
    const program = buildProgram(processIO);
    for (const [name, option] of [
      ['doctor', '--fix'], ['doctor', '--json'], ['pending', undefined],
      ['add', '--json'], ['install', '--json'], ['uninstall', undefined],
    ] as const) {
      const row = doc.split('\n').find((line) => line.startsWith(`| \`lexicon ${name}${option ? ` ${option}` : ''}\` |`));
      expect(row).toContain('Source-only');
      const command = program.commands.find((entry) => entry.name() === name);
      expect(command, `missing source command ${name}`).toBeDefined();
      if (option) expect(command?.options.some((entry) => entry.long === option)).toBe(true);
    }
  });
});
