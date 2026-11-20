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

  it('names, for each row, the earliest released CHANGELOG section that mentions the command', () => {
    const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    // Released sections ("## 0.5.7 (date)"), newest first; "## Unreleased" is dropped.
    const sections: Array<[string, string]> = [];
    for (const part of changelog.split(/^## /m).slice(1)) {
      const version = /^(\d+\.\d+\.\d+) \(/.exec(part)?.[1];
      if (version) sections.push([version, part]);
    }
    for (const [cell, mention, release] of [
      ['lexicon doctor --fix', 'lexicon doctor --fix', '0.5.7'],
      ['lexicon doctor --json', 'lexicon doctor --json', '0.5.6'],
      ['lexicon pending', 'pending-aliases.yaml', '0.5.7'],
      ['lexicon add --json', 'lexicon add --json', '0.5.6'],
      ['lexicon install --json', 'lexicon install --json', '0.5.6'],
      ['lexicon uninstall', 'lexicon uninstall <client>', '0.5.7'],
    ] as const) {
      const row = doc.split('\n').find((line) => line.startsWith(`| \`${cell}\` |`));
      expect(row?.trimEnd().endsWith(`| ${release} |`), `${cell} release cell`).toBe(true);
      const at = sections.findIndex(([version]) => version === release);
      expect(at, `CHANGELOG ${release}`).toBeGreaterThanOrEqual(0);
      expect(sections[at][1], `CHANGELOG ${release}`).toContain(mention);
      for (const [older, body] of sections.slice(at + 1)) {
        expect(body.includes(mention), `${mention} already in ${older}`).toBe(false);
      }
    }
    expect(doc).toContain('npm served 0.5.12');
  });
});
