import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('documentation index', () => {
  it('qualifies the CLI reference against the installed version', () => {
    const index = readFileSync(path.join(process.cwd(), 'docs', 'README.md'), 'utf8');
    const reference = index.split('## Reference\n')[1]?.split('\n## ')[0];

    expect(reference).toBeDefined();
    expect(reference).toMatch(/CLI reference describes the current source tree/);
    expect(reference).toMatch(/published npm package[\s\S]*available only in source/);
    for (const command of [
      'lexicon doctor --fix', 'lexicon doctor --json', 'lexicon add --json',
      'lexicon install --json', 'lexicon uninstall', 'lexicon pending',
      'lexicon --version', 'lexicon --help', 'lexicon doctor --help',
    ]) {
      expect(reference).toContain(`\`${command}\``);
    }
    expect(reference).toContain('[FIRST-RUN.md](FIRST-RUN.md)');
  });

  it('links to and describes the first-run report', () => {
    const docs = path.join(process.cwd(), 'docs');
    const index = readFileSync(path.join(docs, 'README.md'), 'utf8');
    const rows = index.split('\n').filter((line) => line.startsWith('| [FIRST-RUN.md]'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\[FIRST-RUN\.md\]\(FIRST-RUN\.md\)/);
    expect(rows[0]).toMatch(/2026 Linux first-run report/i);
    expect(rows[0]).toMatch(/measured October 26/i);
    expect(rows[0]).toMatch(/install and setup demo timings/i);
    expect(rows[0]).toMatch(/separate npx normalization timing/i);
    expect(rows[0]).toMatch(/non-interactive agent behavior, write gates/i);
    expect(rows[0]).toMatch(/documentation findings/i);
    expect(rows[0]).toMatch(/JSON errors/i);
    expect(rows[0]).toMatch(/MCP schemas/i);
    expect(rows[0]).toMatch(/comparing npm 0\.5\.4 with source 0\.5\.6/i);
    expect(rows[0]).toMatch(/ranked follow-ups/i);
    expect(rows[0]).not.toMatch(/wrong doc lines/i);

    const target = rows[0].match(/\[FIRST-RUN\.md\]\(([^)]+)\)/)?.[1];
    expect(target).toBeDefined();
    const report = readFileSync(path.resolve(docs, target!), 'utf8');
    expect(report).toMatch(/^# First run$/m);
    expect(report).toMatch(/^## Timed path$/m);
    expect(report).toMatch(/Measured 2026-10-26/);
    expect(report).toMatch(/first printed correction is the setup demo/i);
    expect(report).toMatch(/An `npx` run that executed `normalize`[\s\S]*?finished in 2\.799 s/);
    expect(report).toMatch(/^## What the docs said, and what the command did$/m);
    expect(report).toMatch(/^## Agent use$/m);
    expect(report).toMatch(/^### `--json` and errors$/m);
    expect(report).toMatch(/^### `--dry-run` and other write gates$/m);
    expect(report).toMatch(/^### MCP schemas$/m);
    expect(report).toMatch(/^## Follow-ups\n\nRanked by how much of the product they touch\./m);
    expect(report).toMatch(/npm serves `@ashlr\/lexicon` 0\.5\.4\. This source tree is 0\.5\.6/);
  });
});
