import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { buildProgram } from '../src/cli/program.js';
import * as api from '../src/core/index.js';

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('documented public surface', () => {
  it('lists exactly the runtime package exports', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json']);
    expect(Object.keys(pkg.bin).sort()).toEqual(['lexicon', 'lexicon-mcp']);
    const inventory = read('docs/PUBLIC-API.md').split('<!-- public-api:begin -->')[1].split('<!-- public-api:end -->')[0];
    expect([...inventory.matchAll(/`(\w+)`/g)].map((m) => m[1]).sort()).toEqual(Object.keys(api).sort());
  });

  it('lists every visible command and option, including nested commands', () => {
    const doc = read('docs/CLI.md');
    const documented = [...doc.matchAll(/^## `lexicon (.+)`$|^\| `lexicon ([a-z-]+(?: [a-z-]+)+)/gm)].map((m) => m[1] ?? m[2]);
    const paths: string[] = [];
    const options = (section: string): string[] => [...section.matchAll(/^ {2}(-[^\n]*?) {2,}/gm)].map((m) => m[1]);
    const walk = (parent: Command, prefix: string[]): void => {
      for (const command of parent.createHelp().visibleCommands(parent)) {
        if (command.name() === 'help') continue;
        const path = [...prefix, command.name()];
        const name = path.join(' ');
        paths.push(name);
        const section = prefix.length
          ? doc.split('\n').find((line) => line.startsWith(`| \`lexicon ${name}`))
          : doc.split(`## \`lexicon ${name}\`\n`)[1]?.split('\n## ')[0];
        expect(section, name).toBeDefined();
        const flags = prefix.length
          ? [...section!.split(' | ')[2].matchAll(/`([^`]+)`/g)].map((m) => m[1].replaceAll('\\|', '|'))
          : options(section!);
        expect(flags, name).toEqual(command.createHelp().visibleOptions(command).map((option) => option.flags));
        walk(command, path);
      }
    };
    const program = buildProgram({ stdout: () => undefined, stderr: () => undefined });
    expect(options(doc.split('## `lexicon`\n')[1].split('\n## ')[0])).toEqual(program.createHelp().visibleOptions(program).map((option) => option.flags));
    walk(program, []);
    expect(documented.sort()).toEqual(paths.sort());
  });
});
