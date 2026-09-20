#!/usr/bin/env node
/**
 * Fact checker for the numbers this repo states about itself.
 *
 * Docs drift. Five different files once claimed 17, 18 and 19 MCP tools while
 * the server registered 19. This script derives every such number from the code
 * that actually produces it -- the built MCP server answering over stdio, the
 * built CLI's own `--help`, the exporter/importer tables, the pack YAML, the
 * stoplist -- and then greps every prose surface for a contradicting claim.
 *
 * Ground truth, and where each number comes from:
 *   MCP tools / resources / prompts   dist/mcp/server.js, asked over stdio
 *   CLI commands                      `node dist/cli/index.js --help`, parsed
 *   export formats                    EXPORT_FORMATS (dist/core/exporters)
 *   import formats                    IMPORT_FORMATS minus the `auto` sentinel
 *   packs, pack terms, pack aliases   listPacks() over packs/*.yaml
 *   stoplist words                    STOPLIST.size
 *   Swift tests                       `func test*` / `@Test` under apps/macos/LexiconBar/Tests
 *   TypeScript tests                  `vitest run --reporter=json`
 *
 * The TypeScript count is the one expensive fact (it has to run the suite;
 * `vitest list` under-counts because it does not expand `.each`), so it is
 * derived lazily: only when some scanned file actually states a number of
 * tests. Today nothing does, and the whole check runs in a couple of seconds.
 *
 * Usage:
 *   node scripts/check-facts.mjs             # check everything
 *   node scripts/check-facts.mjs --no-tests  # never run vitest, skip both test counts
 *   node scripts/check-facts.mjs --list      # print the ground truth and exit
 *   node scripts/check-facts.mjs --verbose   # also print every claim that agrees
 *
 * Exits 1 and prints one line per disagreement. Requires `npm run build` first.
 *
 * A line that legitimately contains a number this script would misread can opt
 * out with a trailing `check-facts:ignore` comment (`<!-- check-facts:ignore -->`
 * in markdown, `// check-facts:ignore` elsewhere).
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const listOnly = argv.includes('--list');
const skipTests = argv.includes('--no-tests');

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

/** Ask the built MCP server for its tools, resources and prompts over stdio. */
function askMcpServer() {
  const server = path.join(root, 'dist/mcp/server.js');
  if (!existsSync(server)) throw new Error('dist/mcp/server.js is missing; run `npm run build` first');
  return new Promise((resolve, reject) => {
    // Point the server at a path that cannot exist so it never reads the
    // developer's real lexicon, and so the counts cannot depend on its contents.
    const child = spawn(process.execPath, [server], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, LEXICON_PATH: path.join(root, 'node_modules/.check-facts-nonexistent/lexicon.yaml') },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the MCP server did not answer within 20s'));
    }, 20_000);
    const pending = new Map();
    let id = 0;
    let buf = '';
    const rpc = (method, params = {}) =>
      new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
      });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const settle = pending.get(msg.id);
        if (settle) {
          pending.delete(msg.id);
          settle(msg);
        }
      }
    });
    (async () => {
      await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'check-facts', version: '0' },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const [tools, resources, prompts] = await Promise.all([
        rpc('tools/list'),
        rpc('resources/list'),
        rpc('prompts/list'),
      ]);
      clearTimeout(timer);
      child.kill();
      resolve({
        tools: (tools.result?.tools ?? []).map((t) => t.name),
        resources: (resources.result?.resources ?? []).map((r) => r.uri),
        prompts: (prompts.result?.prompts ?? []).map((p) => p.name),
      });
    })().catch((err) => {
      clearTimeout(timer);
      child.kill();
      reject(err);
    });
  });
}

/** Every top-level command name out of the built CLI's own `--help`. `help` does not count. */
function cliCommands() {
  const cli = path.join(root, 'dist/cli/index.js');
  if (!existsSync(cli)) throw new Error('dist/cli/index.js is missing; run `npm run build` first');
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', timeout: 30_000 });
  const start = help.indexOf('\nCommands:');
  if (start < 0) throw new Error('could not find the Commands: section in `lexicon --help`');
  const names = [];
  for (const line of help.slice(start + 1).split('\n').slice(1)) {
    // "  add [options] <canonical> [aliases...]  add a term, ..." -> "add"
    // "  remove|rm [options] <canonical>         remove a term"   -> "remove"
    const m = /^ {2}(\S+)/.exec(line);
    if (!m) continue;
    const name = m[1].split('|')[0];
    if (name === 'help') continue;
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) throw new Error('parsed zero commands out of `lexicon --help`');
  return names;
}

async function groundTruth() {
  const mcp = await askMcpServer();
  const { EXPORT_FORMATS } = await import(new URL('../dist/core/exporters/index.js', import.meta.url));
  const { IMPORT_FORMATS } = await import(new URL('../dist/core/importers/index.js', import.meta.url));
  const { STOPLIST } = await import(new URL('../dist/core/stoplist.js', import.meta.url));
  const { listPacks } = await import(new URL('../dist/core/packs.js', import.meta.url));
  const packs = await listPacks();
  const commands = cliCommands();

  const facts = {
    'mcp tools': mcp.tools.length,
    'mcp resources': mcp.resources.length,
    'mcp prompts': mcp.prompts.length,
    'cli commands': commands.length,
    'export formats': EXPORT_FORMATS.length,
    // `auto` is a sentinel meaning "sniff it", not a format a user can be told about.
    'import formats': IMPORT_FORMATS.filter((f) => f !== 'auto').length,
    packs: packs.length,
    'pack terms': packs.reduce((n, p) => n + p.terms, 0),
    'pack aliases': packs.reduce((n, p) => n + p.aliases, 0),
    'stoplist words': STOPLIST.size,
  };
  const detail = {
    'mcp tools': mcp.tools,
    'mcp resources': mcp.resources,
    'mcp prompts': mcp.prompts,
    'cli commands': commands,
    'export formats': [...EXPORT_FORMATS],
    'import formats': IMPORT_FORMATS.filter((f) => f !== 'auto'),
    packs: packs.map((p) => `${p.name} (${p.terms} terms, ${p.aliases} aliases)`),
  };

  if (!skipTests) facts['swift tests'] = swiftTestCount();
  return { facts, detail };
}

/** XCTest `func testFoo()` plus swift-testing `@Test`, counted statically. */
function swiftTestCount() {
  const dir = path.join(root, 'apps/macos/LexiconBar/Tests');
  if (!existsSync(dir)) return undefined;
  let n = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.swift')) {
        n += (readFileSync(p, 'utf8').match(/^\s*(?:@Test\b|func test[A-Za-z0-9_]*\s*\()/gm) ?? []).length;
      }
    }
  };
  walk(dir);
  return n;
}

/**
 * The real vitest total, by running the suite. `vitest list` under-counts
 * because it does not expand `.each`, and the json reporter writes to a file
 * rather than stdout, so it is pointed at a scratch path outside the repo.
 */
function vitestCount() {
  const out = path.join(mkdtempSync(path.join(tmpdir(), 'lexicon-facts-')), 'vitest.json');
  try {
    execFileSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${out}`], {
      cwd: root,
      encoding: 'utf8',
      timeout: 900_000,
      stdio: 'ignore',
    });
  } catch (err) {
    throw new Error(`vitest failed while counting tests: ${err.message}`);
  }
  const report = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(path.dirname(out), { recursive: true, force: true });
  if (typeof report.numTotalTests !== 'number') throw new Error('vitest json report had no numTotalTests');
  return report.numTotalTests;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const NUMBER_WORDS = new Map(
  Object.entries({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23,
    'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27, 'twenty-eight': 28,
    'twenty-nine': 29, thirty: 30,
  }),
);
const WORD_ALT = [...NUMBER_WORDS.keys()].sort((a, b) => b.length - a.length).join('|');
/** A number written either way, as a capturing group. */
const NUM = `(\\d{1,5}|${WORD_ALT})`;

function toNumber(raw) {
  const key = raw.toLowerCase();
  if (NUMBER_WORDS.has(key)) return NUMBER_WORDS.get(key);
  const n = Number(raw.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * One entry per fact. `patterns` are matched case-insensitively against each
 * line; group 1 is the claimed number. Keep them tight -- a loose pattern turns
 * an unrelated sentence into a false failure and teaches people to ignore this
 * script.
 */
const CLAIMS = [
  {
    fact: 'mcp tools',
    patterns: [
      new RegExp(`\\b${NUM}\\s+(?:MCP\\s+|lexicon\\s+|extra\\s+|agent-native\\s+)*tools\\b`, 'i'),
      // "45 tools total: 25 built-in, 19 lexicon, 3 MCP helpers"
      new RegExp(`\\b${NUM}\\s+lexicon\\b(?=\\s*[,.])`, 'i'),
    ],
    needLine: /\btools?\b/i,
  },
  {
    fact: 'mcp resources',
    patterns: [new RegExp(`\\b${NUM}\\s+(?:MCP\\s+)?resources\\b`, 'i')],
    // Only a sentence that is also talking about the server states this count.
    needLine: /\bMCP\b|\btools?\b|\bprompts?\b/i,
  },
  {
    fact: 'mcp prompts',
    patterns: [new RegExp(`\\b${NUM}\\s+(?:MCP\\s+)?prompts\\b`, 'i')],
    needLine: /\bMCP\b|\btools?\b|\bresources?\b/i,
  },
  {
    fact: 'cli commands',
    patterns: [
      new RegExp(`\\b${NUM}\\s+(?:top-level\\s+|CLI\\s+)?(?:sub)?commands\\b`, 'i'),
      new RegExp(`\\b(?:CLI|lexicon)\\s+commands?:\\s*${NUM}\\b`, 'i'),
    ],
  },
  {
    fact: 'export formats',
    patterns: [
      new RegExp(`\\b${NUM}\\s+export\\s+(?:formats|targets)\\b`, 'i'),
      new RegExp(`\\bexports?\\s+(?:to\\s+)?${NUM}\\s+(?:formats|tools|targets)\\b`, 'i'),
      new RegExp(`\\bunion\\s+of\\s+the\\s+${NUM}\\s+format\\s+names\\b`, 'i'),
    ],
  },
  {
    fact: 'import formats',
    patterns: [
      new RegExp(`\\b${NUM}\\s+import\\s+formats\\b`, 'i'),
      new RegExp(`\\bimports?\\s+(?:from\\s+)?${NUM}\\s+formats\\b`, 'i'),
    ],
  },
  {
    fact: 'packs',
    patterns: [
      new RegExp(`\\b${NUM}\\s+starter\\s+packs\\b`, 'i'),
      new RegExp(`\\b${NUM}\\s+(?:term\\s+)?packs\\b(?!\\s+(?:add|remove|list|show))`, 'i'),
    ],
  },
  {
    fact: 'pack terms',
    patterns: [
      new RegExp(`\\b${NUM}\\s+(?:curated\\s+|starter\\s+|pack\\s+)?terms\\s+across\\s+(?:the\\s+)?(?:all\\s+)?(?:four\\s+)?packs\\b`, 'i'),
      new RegExp(`\\bpacks?\\s+(?:ship|carry|hold|contain|add)\\s+${NUM}\\s+terms\\b`, 'i'),
      new RegExp(`\\b${NUM}\\s+curated\\s+terms\\b`, 'i'),
    ],
    // "Twenty-two terms across the four packs carry a `never` list" counts a
    // subset, not the packs.
    skipLine: /\bnever\b/i,
  },
  {
    fact: 'stoplist words',
    patterns: [
      new RegExp(`\\bstoplist[^.\\n]{0,40}?\\b${NUM}\\s+words\\b`, 'i'),
      new RegExp(`\\b${NUM}\\s+words?\\)?\\s*[:,]?\\s*common\\s+English`, 'i'),
      new RegExp(`\\bSTOPLIST\\b[^.\\n]{0,40}?\\(${NUM}\\s+words`, 'i'),
    ],
  },
  {
    fact: 'typescript tests',
    patterns: [
      new RegExp(`\\b${NUM}\\s+(?:TypeScript|vitest)\\s+tests\\b`, 'i'),
      new RegExp(`\\b${NUM}\\s+tests\\s+in\\s+total\\b`, 'i'),
    ],
    // The Swift suite states its own total the same way; it is checked below.
    skipLine: /LexiconBar|\bSwift\b|XCTest/i,
  },
  {
    fact: 'swift tests',
    patterns: [
      new RegExp(`\\b${NUM}\\s+Swift\\s+tests\\b`, 'i'),
      new RegExp(`\\b${NUM}\\s+tests\\s+in\\s+total\\b`, 'i'),
    ],
    needLine: /LexiconBar|\bSwift\b|XCTest/i,
  },
];

/** Files whose prose we hold to the code. Generated and vendored trees are out. */
function scanTargets() {
  const out = [];
  const roots = [
    'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
    'CLAUDE.md', 'package.json', '.claude-plugin',
    'docs', 'web/app', 'web/components', 'web/lib', 'site', 'extension/src', 'extension/public',
    'examples', 'skills', 'commands', 'bench', 'apps/macos',
  ];
  const ok = /\.(md|mdx|html|ts|tsx|js|mjs|json|yaml|yml)$/i;
  const skipDir = /^(node_modules|dist|\.next|\.build|\.git|assets)$/;
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) {
      if (ok.test(rel)) out.push(rel);
      return;
    }
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && skipDir.test(entry.name)) continue;
      walk(path.join(rel, entry.name));
    }
  };
  for (const r of roots) walk(r);
  return [...new Set(out)].sort();
}

/**
 * CHANGELOG.md is a record, not a description: "21 commands" under 0.1.0 was
 * true when 0.1.0 shipped and rewriting it would be a lie. Only the topmost
 * section -- the release being written now -- is held to the current code.
 */
function liveLineCount(file, lines) {
  if (file !== 'CHANGELOG.md') return lines.length;
  const headings = [];
  lines.forEach((line, i) => {
    if (/^## /.test(line)) headings.push(i);
  });
  return headings.length >= 2 ? headings[1] : lines.length;
}

function check(facts) {
  const problems = [];
  const agreed = [];
  for (const file of scanTargets()) {
    const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
    const live = liveLineCount(file, lines);
    lines.forEach((line, i) => {
      if (i >= live) return;
      if (/check-facts:ignore/.test(line)) return;
      for (const claim of CLAIMS) {
        // `typescript tests` costs a full vitest run, so it is only derived the
        // first time a line actually looks like it states a test count.
        if (claim.fact === 'typescript tests' && facts[claim.fact] === undefined && !skipTests) {
          if (!claim.patterns.some((p) => p.test(line)) || claim.skipLine?.test(line)) continue;
          console.log(`check-facts: ${file}:${i + 1} states a test count; running vitest to check it...`);
          facts[claim.fact] = vitestCount();
        }
        const truth = facts[claim.fact];
        if (truth === undefined) continue; // test counts with --no-tests
        if (claim.skipLine?.test(line)) continue;
        if (claim.needLine && !claim.needLine.test(line)) continue;
        for (const pattern of claim.patterns) {
          const m = pattern.exec(line);
          if (!m) continue;
          const claimed = toNumber(m[1]);
          if (claimed === undefined) continue;
          const where = `${file}:${i + 1}`;
          const snippet = line.trim().slice(0, 140);
          if (claimed === truth) agreed.push(`${where}  ${claim.fact} = ${claimed}`);
          else problems.push({ where, fact: claim.fact, claimed, truth, snippet });
          break; // one verdict per claim per line
        }
      }
    });
  }
  return { problems, agreed };
}

// ---------------------------------------------------------------------------

const { facts, detail } = await groundTruth();

if (listOnly) {
  if (!skipTests) facts['typescript tests'] = vitestCount();
  for (const [name, value] of Object.entries(facts)) {
    console.log(`${name.padEnd(18)} ${value}`);
    if (detail[name]) console.log(`${' '.repeat(18)} ${detail[name].join(', ')}`);
  }
  process.exit(0);
}

const { problems, agreed } = check(facts);

if (verbose) {
  for (const [name, value] of Object.entries(facts)) console.log(`truth  ${name.padEnd(18)} ${value}`);
  for (const line of agreed) console.log(`ok     ${line}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} doc claim(s) disagree with the code:\n`);
  for (const p of problems) {
    console.error(`  ${p.where}`);
    console.error(`    claims ${p.fact} = ${p.claimed}, but the code says ${p.truth}`);
    console.error(`    ${p.snippet}`);
  }
  console.error('');
  process.exit(1);
}

const counted = Object.keys(facts).length;
console.log(`check-facts: ${agreed.length} claim(s) across the docs agree with the code (${counted} facts derived)`);
if (skipTests) console.log('check-facts: test counts skipped (--no-tests)');
