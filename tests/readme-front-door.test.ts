import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const files = ['README.md', 'llms.txt', 'llms-full.txt', 'docs/COPY-PASTE.md'];

it('leads agents with a runnable install, JSON commands, and the three MCP clients', () => {
  for (const file of files) {
    const text = read(file);
    expect(text, file).toContain('curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh');
    expect(text, file).toContain('lexicon setup --dry-run --json');
    expect(text, file).toContain('lexicon normalize "ask ashler to deploy kuber netties with post gressql" --json');
    expect(text, file).toContain('lexicon install claude --json');
    expect(text, file).toContain('lexicon install cursor --json');
    expect(text, file).toContain('lexicon install codex --json');
    expect(text, file).toContain('lexicon-mcp');
    expect(text, file).toContain('[mcp_servers.lexicon]');
    expect(text, file).not.toContain('\u2014');
  }
});

it('puts the answer in the first screen of the README', () => {
  const readme = read('README.md');
  const first = readme.slice(0, readme.indexOf('## MCP server'));
  expect(first).toContain('Speech-to-text gets English right and your names wrong.');
  expect(first).toContain('## Start here (60 seconds)');
  expect(first).toContain('docs/assets/hero.svg');
  expect(first).toContain('](llms.txt)');
  expect(first).toContain('](llms-full.txt)');
  expect(readme).toContain('docs/assets/how-it-works.svg');
  expect(readme).toContain('## FAQ');
  expect(readme).toContain('https://github.com/ashlrai/lexicon)');
  expect(readme).toContain('LEXICON_NO_SETUP=1');
  expect(readme).toContain('`sudo`');
});
