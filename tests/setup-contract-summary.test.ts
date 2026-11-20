import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { makeIO } from './helpers.js';

const read = (file: string): string => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
// setup-command-entrypoints.md was folded into this page; both tests now read it.
const summary = read('docs/setup-contract-summary.md');
const index = read('docs/README.md');

describe('guided first-run contract summary', () => {
  it('is discoverable and links to the setup and MCP contracts', () => {
    expect(index).toContain('(setup-contract-summary.md)');
    expect(summary).toContain('(CONTRACT.md#srcclicmd-setupts)');
    expect(summary).toContain('(CONTRACT.md)');
  });

  it('replaces the folded entrypoints page', () => {
    expect(existsSync(new URL('../docs/setup-command-entrypoints.md', import.meta.url))).toBe(false);
    expect(index).not.toContain('setup-command-entrypoints.md');
  });

  it('covers each setup responsibility and its important write boundaries', () => {
    for (const step of ['Global lexicon', 'Starter packs', 'Repository harvest', 'Agent clients', 'Local API', 'Dictation app export', 'Demonstration']) {
      expect(summary).toContain(`**${step}.**`);
    }
    expect(summary).toMatch(/confirmation defaults to\s+no/);
    expect(summary).toMatch(/non-interactive run\s+installs no packs unless/);
    expect(summary).toMatch(/non-interactive CLI run selects detected clients/);
    expect(summary).toMatch(/MCP tool instead installs no clients/);
    expect(summary).toMatch(/built-in example[\s\S]*not added to the user's lexicon/);
    expect(summary).toMatch(/--dry-run` writes nothing and asks nothing/);
    expect(summary).toMatch(/does not\s+implicitly trust a project file/);
  });

  it('separates documented behavior from questions that make no commitments', () => {
    const [documented, questions] = summary.split('## Open questions');
    expect(documented).toContain('## Documented responsibilities');
    expect(questions).toMatch(/do not change the behavior above/);
    expect(questions.match(/^- /gm)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('setup entrypoints documentation', () => {
  it('lists the registered setup options without drifting from Commander', () => {
    const setup = buildProgram(makeIO()).commands.find((command) => command.name() === 'setup');
    expect(setup).toBeDefined();
    const documented = summary.match(/```text\n([\s\S]*?)\n```/)?.[1].match(/--[\w-]+/g);
    expect(documented?.sort()).toEqual(setup!.options.map((option) => option.long).sort());
  });

  it('documents the execution steps in source order', () => {
    const source = read('src/cli/cmd-setup.ts');
    const steps = source.match(/const steps: [\s\S]*?= \[([\s\S]*?)\n  \];/)?.[1];
    expect(steps).toBeDefined();
    const actual = [...steps!.matchAll(/\['([^']+)', (step\w+)\]/g)].map((m) => [m[1], m[2]]);
    const documented = [...summary.matchAll(/^\| ([^|]+) \| `(step\w+)` \|/gm)].map((m) => [m[1].trim(), m[2]]);
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
      expect(summary).toContain(file);
      expect(summary).toContain(`\`${entrypoint}\``);
    }
  });
});
