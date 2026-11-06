import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const summary = readFileSync(new URL('../docs/setup-contract-summary.md', import.meta.url), 'utf8');
const index = readFileSync(new URL('../docs/README.md', import.meta.url), 'utf8');

describe('guided first-run contract summary', () => {
  it('is discoverable and links to the setup and MCP contracts', () => {
    expect(index).toContain('(setup-contract-summary.md)');
    expect(summary).toContain('(CONTRACT.md#srcclicmd-setupts)');
    expect(summary).toContain('(CONTRACT.md)');
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
