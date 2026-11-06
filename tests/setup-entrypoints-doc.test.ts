import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { makeIO } from './helpers.js';

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const doc = read('docs/setup-command-entrypoints.md');

describe('setup entrypoints documentation', () => {
  it('lists the registered setup options without drifting from Commander', () => {
    const setup = buildProgram(makeIO()).commands.find((command) => command.name() === 'setup');
    expect(setup).toBeDefined();
    const documented = doc.match(/```text\n([\s\S]*?)\n```/)?.[1].match(/--[\w-]+/g);
    expect(documented?.sort()).toEqual(setup!.options.map((option) => option.long).sort());
  });

  it('documents the execution steps in source order', () => {
    const source = read('src/cli/cmd-setup.ts');
    const steps = source.match(/const steps: [\s\S]*?= \[([\s\S]*?)\n  \];/)?.[1];
    expect(steps).toBeDefined();
    const actual = [...steps!.matchAll(/\['([^']+)', (step\w+)\]/g)].map((m) => [m[1], m[2]]);
    const documented = [...doc.matchAll(/^\| ([^|]+) \| `(step\w+)` \|/gm)].map((m) => [m[1].trim(), m[2]]);
    expect(actual.length).toBeGreaterThan(0);
    expect(documented).toEqual(actual);
  });

  it('identifies the registration and dispatch chain for both surfaces', () => {
    const files = [
      ['src/cli/run.ts', 'buildProgram'],
      ['src/cli/program.ts', 'registerSetupCommands'],
      ['src/cli/cmd-setup.ts', 'runSetupCli'],
      ['src/mcp/server.ts', 'TOOL_REGISTRARS'],
      ['src/mcp/tools/index.ts', 'registerSetupTools'],
      ['src/mcp/tools/setup.ts', 'setup_lexicon'],
    ];
    for (const [file, entrypoint] of files) {
      expect(read(file)).toContain(entrypoint);
      expect(doc).toContain(file);
      expect(doc).toContain(`\`${entrypoint}\``);
    }
  });
});
