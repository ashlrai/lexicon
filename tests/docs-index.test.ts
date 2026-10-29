import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('documentation index', () => {
  it('links to and describes the first-run report', () => {
    const docs = path.join(process.cwd(), 'docs');
    const index = readFileSync(path.join(docs, 'README.md'), 'utf8');
    const rows = index.split('\n').filter((line) => line.includes('[FIRST-RUN.md]'));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/\[FIRST-RUN\.md\]\(FIRST-RUN\.md\)/);
    expect(rows[0]).toMatch(/Linux install and setup/i);
    expect(rows[0]).toMatch(/non-interactive agent behavior and write gates/i);
    expect(rows[0]).not.toMatch(/wrong doc lines/i);

    const report = readFileSync(path.join(docs, 'FIRST-RUN.md'), 'utf8');
    expect(report).toMatch(/^# First run$/m);
    expect(report).toMatch(/^## Agent use$/m);
    expect(report).toMatch(/^### `--dry-run` and other write gates$/m);
  });
});
