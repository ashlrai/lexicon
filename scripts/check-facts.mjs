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
 *   setup steps                       stepHeading() calls in src/cli/setup/steps.ts
 *   serve endpoints                   the route() dispatch in src/serve/server.ts
 *   Swift tests                       `func test*` / `@Test` under apps/macos/LexiconBar/Tests
 *   TypeScript tests                  `vitest run --reporter=json`
 *
 * Four of these are not just counts, because a count alone let the docs drift
 * while still adding up: LOCAL-API.md tabled eight of eleven routes and no page
 * said how many there were, MCP.md omitted `setup_lexicon`'s `harvest`
 * argument, QUICKSTART.md's setup transcript could have numbered its steps
 * however it liked, and a `#vX.Y.Z` install pin outlived two releases. Those are
 * checked structurally, against the derived list rather than a number:
 *   docs/LOCAL-API.md endpoint table   every route path in route(), no extras
 *   docs/MCP.md setup_lexicon row      every argument name in the zod schema
 *   docs/QUICKSTART.md transcript      `N. Title` per step, from steps.ts
 *   `#vX.Y.Z` pins anywhere            package.json version
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
  for (const line of help.slice(start + 1).split(/\r?\n/).slice(1)) {
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

/** The source text of a `{...}` (or `(...)`) block starting at `openIndex`, brace-matched. */
function block(src, openIndex) {
  const open = src[openIndex];
  const close = { '{': '}', '(': ')', '[': ']' }[open];
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === open) depth += 1;
    else if (src[i] === close) {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  throw new Error(`unbalanced ${open} at ${openIndex}`);
}

/**
 * The numbered steps a user actually sees `lexicon setup` print, from the
 * `stepHeading(ctx, n, title)` calls in the wizard. Not the number of step
 * functions and not the number of things the wizard does: the summary card at
 * the end is real work but carries no number, so it is not a step a reader can
 * count in the output. The helper's own declaration does not match (it takes
 * `n`, not a literal), and the numbers must run 1..N with no gap or repeat.
 */
function setupSteps() {
  const file = path.join(root, 'src/cli/setup/steps.ts');
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const src = readFileSync(file, 'utf8');
  const titles = new Map();
  for (const m of src.matchAll(/\bstepHeading\(\s*ctx\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'/g)) {
    const n = Number(m[1]);
    if (titles.has(n)) throw new Error(`two setup steps are both numbered ${n}`);
    titles.set(n, m[2].replace(/\\(.)/g, '$1'));
  }
  if (titles.size === 0) throw new Error('parsed zero stepHeading() calls out of src/cli/setup/steps.ts');
  const ordered = [...titles.keys()].sort((a, b) => a - b);
  ordered.forEach((n, i) => {
    if (n !== i + 1) throw new Error(`the setup steps are numbered ${ordered.join(', ')}, which is not 1..${titles.size}`);
  });
  return ordered.map((n) => ({ n, title: titles.get(n) }));
}

/** `/^\/packs\/([a-z0-9-]+)$/` -> `/packs/:param`. Parameter names are not compared. */
function routeFromRegex(source) {
  return source
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\((?:\?:)?[^)]*\)[+*?]?/g, ':param');
}

/** Any `:name` placeholder, so docs may spell it `:format` where the code captures a pattern. */
function normalizeRoute(route) {
  return route.replace(/:[A-Za-z_][\w-]*/g, ':param').replace(/\{[^}]*\}/g, ':param').replace(/\/+$/, '') || '/';
}

/**
 * Every route path `lexicon serve` dispatches, read out of the `route()`
 * function in src/serve/server.ts: the `pathname === '...'` literals, the
 * `pathname === PAIR_PATH` constant, and the two regex routes (`/packs/:name`
 * and `/export/:format`), whose parameter names are normalized away.
 *
 * Counts paths, not method+path pairs: `/packs/:name` answers both POST and
 * DELETE and is one route either way, which is the unit LOCAL-API.md and
 * CONTRACT.md both list.
 */
function serveRoutes() {
  const file = path.join(root, 'src/serve/server.ts');
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf('async function route(');
  if (at < 0) throw new Error('could not find `async function route(` in src/serve/server.ts');
  const body = block(src, src.indexOf('{', at));

  // Module-level string constants (PAIR_PATH) and regex constants (PACK_ROUTE_RE).
  const strings = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/g)) strings.set(m[1], m[2]);
  const regexes = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\/((?:[^/\\\n]|\\.)+)\//g)) regexes.set(m[1], m[2]);

  const found = new Set();
  for (const m of body.matchAll(/pathname\s*===\s*'([^']*)'/g)) found.add(normalizeRoute(m[1]));
  for (const m of body.matchAll(/pathname\s*===\s*([A-Z][A-Z0-9_]*)/g)) {
    if (!strings.has(m[1])) throw new Error(`route() compares pathname to ${m[1]}, which is not a string constant here`);
    found.add(normalizeRoute(strings.get(m[1])));
  }
  for (const m of body.matchAll(/\/((?:[^/\\\n]|\\.)+)\/\s*\.exec\(pathname\)/g)) found.add(normalizeRoute(routeFromRegex(m[1])));
  for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.exec\(pathname\)/g)) {
    if (regexes.has(m[1])) found.add(normalizeRoute(routeFromRegex(regexes.get(m[1]))));
  }
  if (found.size === 0) throw new Error('parsed zero routes out of the route() dispatch in src/serve/server.ts');
  return [...found].sort();
}

/**
 * The argument names of one MCP tool's zod `inputSchema`, in declaration order.
 * `setup_lexicon` gained `harvest` and `packs` after MCP.md was written, and an
 * argument a doc does not mention is one an agent will not pass, which changes
 * what the tool writes.
 */
function mcpToolArgs(toolName) {
  const file = path.join(root, 'src/mcp/tools/setup.ts');
  if (!existsSync(file)) throw new Error(`${file} is missing`);
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`'${toolName}'`);
  if (at < 0) throw new Error(`could not find the ${toolName} tool in src/mcp/tools/setup.ts`);
  const schemaAt = src.indexOf('inputSchema:', at);
  if (schemaAt < 0) throw new Error(`${toolName} has no inputSchema`);
  const body = block(src, src.indexOf('{', schemaAt));
  const names = [];
  let depth = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (depth === 1 && /[{,\s]/.test(body[i - 1] ?? '')) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      if (m) {
        names.push(m[1]);
        i += m[0].length - 1;
      }
    }
  }
  if (names.length === 0) throw new Error(`parsed zero arguments out of ${toolName}'s inputSchema`);
  return names;
}

function packageVersion() {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

async function groundTruth() {
  const mcp = await askMcpServer();
  const { EXPORT_FORMATS } = await import(new URL('../dist/core/exporters/index.js', import.meta.url));
  const { IMPORT_FORMATS } = await import(new URL('../dist/core/importers/index.js', import.meta.url));
  const { STOPLIST } = await import(new URL('../dist/core/stoplist.js', import.meta.url));
  const { listPacks } = await import(new URL('../dist/core/packs.js', import.meta.url));
  const packs = await listPacks();
  const commands = cliCommands();
  const steps = setupSteps();
  const routes = serveRoutes();
  const setupArgs = mcpToolArgs('setup_lexicon');

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
    'setup steps': steps.length,
    'serve endpoints': routes.length,
  };
  const detail = {
    'mcp tools': mcp.tools,
    'mcp resources': mcp.resources,
    'mcp prompts': mcp.prompts,
    'cli commands': commands,
    'export formats': [...EXPORT_FORMATS],
    'import formats': IMPORT_FORMATS.filter((f) => f !== 'auto'),
    packs: packs.map((p) => `${p.name} (${p.terms} terms, ${p.aliases} aliases)`),
    'setup steps': steps.map((s) => `${s.n}. ${s.title}`),
    'serve endpoints': routes,
  };

  if (!skipTests) facts['swift tests'] = swiftTestCount();
  return { facts, detail, structure: { steps, routes, setupArgs, version: packageVersion() } };
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
  // Spawn vitest's own ESM entry with this node, never the `npx` shim: on
  // Windows `npx` exists only as `npx.cmd`, which execFileSync cannot resolve
  // (no PATHEXT expansion) and which Node refuses to spawn without
  // `shell: true` since the CVE-2024-27980 fix. Resolving the entry keeps the
  // call identical on all three platforms.
  const vitestEntry = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitestEntry)) {
    throw new Error(`cannot count tests: ${vitestEntry} is missing (run npm ci)`);
  }
  try {
    execFileSync(process.execPath, [vitestEntry, 'run', '--reporter=json', `--outputFile=${out}`], {
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
    fact: 'setup steps',
    // Deliberately narrow. "the three steps that write a lot" (a subset of the
    // wizard) and "prints the three steps" (`install-claude`, a different
    // command) are both true sentences containing a step count, so the count is
    // only read out of a phrasing that can mean nothing else. Say "seven
    // numbered steps" or "the seven-step wizard" and this holds you to it.
    patterns: [
      new RegExp(`\\b${NUM}\\s+numbered\\s+steps\\b`, 'i'),
      new RegExp(`\\b${NUM}[- ]step\\s+wizard\\b`, 'i'),
      new RegExp(`\\b${NUM}\\s+steps\\s+of\\s+\`?lexicon\\s+setup`, 'i'),
    ],
    // LexiconBar's own onboarding window counts its own steps.
    skipLine: /LexiconBar|Set up Lexicon/i,
  },
  {
    fact: 'serve endpoints',
    patterns: [
      new RegExp(`\\b${NUM}\\s+(?:HTTP\\s+)?(?:endpoints|routes)\\b`, 'i'),
      new RegExp(`\\b(?:endpoints|routes):\\s*${NUM}\\b`, 'i'),
    ],
    // Only the loopback API has this count; a remote service design doc has its own.
    needLine: /lexicon serve|local (?:HTTP )?API|createServer|127\.0\.0\.1|src\/serve/i,
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

/**
 * A git install pin, `github:ashlrai/lexicon#v0.5.1`. It names a tag that must
 * exist, so it cannot simply be left at whatever it said when it was written:
 * README.md carried `#v0.4.0` through two releases.
 */
const VERSION_PIN = /#v(\d+\.\d+\.\d+)/g;
/**
 * A version written into the code as a constant, which no pin pattern catches.
 * The landing page carried `VERSION = '0.5.0'` while the package was at 0.5.2 and
 * npm served 0.5.1, so a visitor read a third number again. The word boundary
 * keeps sentinels like UNKNOWN_VERSION out.
 */
const VERSION_DECL = /\bVERSION\s*[:=]\s*['\"](\d+\.\d+\.\d+)['\"]/g;

function check(facts, version) {
  const problems = [];
  const agreed = [];
  for (const file of scanTargets()) {
    const lines = readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
    const live = liveLineCount(file, lines);
    lines.forEach((line, i) => {
      if (i >= live) return;
      if (/check-facts:ignore/.test(line)) return;
      for (const m of line.matchAll(VERSION_PIN)) {
        const where = `${file}:${i + 1}`;
        if (m[1] === version) agreed.push(`${where}  version pin = ${m[1]}`);
        else {
          problems.push({
            where,
            message: `pins #v${m[1]}, but package.json is ${version}`,
            snippet: line.trim().slice(0, 140),
          });
        }
      }
      for (const m of line.matchAll(VERSION_DECL)) {
        const where = `${file}:${i + 1}`;
        if (m[1] === version) agreed.push(`${where}  version constant = ${m[1]}`);
        else {
          problems.push({
            where,
            message: `declares version ${m[1]}, but package.json is ${version}`,
            snippet: line.trim().slice(0, 140),
          });
        }
      }
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
// Structure
//
// A count that agrees is not the same as a list that is complete. These three
// hold a specific page's list against the code's list, which is what actually
// broke: LOCAL-API.md is the endpoint reference and had quietly stopped
// mentioning two routes, MCP.md's argument table had stopped mentioning an
// argument that changes what the tool writes, and QUICKSTART.md's transcript
// is what a reader compares their own terminal against.
// ---------------------------------------------------------------------------

function readDoc(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) return undefined;
  return readFileSync(abs, 'utf8');
}

/** Every route path in LOCAL-API.md's endpoint table must be one route() serves, and vice versa. */
function checkLocalApiRoutes(routes, problems) {
  const rel = 'docs/LOCAL-API.md';
  const text = readDoc(rel);
  if (text === undefined) return;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Endpoints\b/.test(l));
  if (start < 0) {
    problems.push({ where: rel, message: 'has no `## Endpoints` section to check the routes against' });
    return;
  }
  const documented = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break;
    if (/check-facts:ignore/.test(lines[i])) continue;
    // "| GET | `/packs/:name` | ... |" -> /packs/:param
    const m = /^\|[^|]*\|\s*`([^`]+)`/.exec(lines[i]);
    if (m && m[1].startsWith('/')) documented.add(normalizeRoute(m[1]));
  }
  if (documented.size === 0) {
    problems.push({ where: rel, message: 'the `## Endpoints` table lists no `/paths`; has its shape changed?' });
    return;
  }
  const missing = routes.filter((r) => !documented.has(r));
  const extra = [...documented].filter((r) => !routes.includes(r));
  if (missing.length > 0) {
    problems.push({
      where: `${rel} (## Endpoints)`,
      message: `does not document ${missing.length} route(s) that src/serve/server.ts serves: ${missing.join(', ')}`,
    });
  }
  if (extra.length > 0) {
    problems.push({
      where: `${rel} (## Endpoints)`,
      message: `documents ${extra.length} route(s) that src/serve/server.ts does not serve: ${extra.join(', ')}`,
    });
  }
}

/** MCP.md's row for a tool must name every argument in its zod schema. */
function checkMcpToolArgs(tool, args, problems) {
  const rel = 'docs/MCP.md';
  const text = readDoc(rel);
  if (text === undefined) return;
  const line = text.split(/\r?\n/).find((l) => new RegExp(`^\\|\\s*\`${tool}\``).test(l));
  if (line === undefined) {
    problems.push({ where: rel, message: `has no table row for \`${tool}\`` });
    return;
  }
  if (/check-facts:ignore/.test(line)) return;
  // The arguments cell is the second column.
  const cell = line.split('|')[2] ?? '';
  const missing = args.filter((a) => !new RegExp(`\`${a}\\??\``).test(cell));
  if (missing.length > 0) {
    problems.push({
      where: rel,
      message: `the \`${tool}\` row omits ${missing.length} argument(s) the zod schema accepts: ${missing.join(', ')}`,
      snippet: line.trim().slice(0, 140),
    });
  }
}

/** QUICKSTART.md's setup transcript must number and title the steps the way the wizard does. */
function checkQuickstartTranscript(steps, problems) {
  const rel = 'docs/QUICKSTART.md';
  const text = readDoc(rel);
  if (text === undefined) return;
  const missing = steps.filter((s) => !new RegExp(`^\\s*${s.n}\\. ${escapeRe(s.title)}\\s*$`, 'm').test(text));
  if (missing.length > 0) {
    problems.push({
      where: `${rel} (the \`lexicon setup\` transcript)`,
      message: `does not print ${missing.map((s) => `"${s.n}. ${s.title}"`).join(', ')}, which is what the wizard heads that step with`,
    });
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkStructure({ steps, routes, setupArgs }) {
  const problems = [];
  checkLocalApiRoutes(routes, problems);
  checkMcpToolArgs('setup_lexicon', setupArgs, problems);
  checkQuickstartTranscript(steps, problems);
  return problems;
}

// ---------------------------------------------------------------------------

const { facts, detail, structure } = await groundTruth();

if (listOnly) {
  if (!skipTests) facts['typescript tests'] = vitestCount();
  for (const [name, value] of Object.entries(facts)) {
    console.log(`${name.padEnd(18)} ${value}`);
    if (detail[name]) console.log(`${' '.repeat(18)} ${detail[name].join(', ')}`);
  }
  console.log(`${'setup_lexicon args'.padEnd(18)} ${structure.setupArgs.join(', ')}`);
  console.log(`${'version'.padEnd(18)} ${structure.version}`);
  process.exit(0);
}

const { problems, agreed } = check(facts, structure.version);
problems.push(...checkStructure(structure));

if (verbose) {
  for (const [name, value] of Object.entries(facts)) console.log(`truth  ${name.padEnd(18)} ${value}`);
  for (const line of agreed) console.log(`ok     ${line}`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} doc claim(s) disagree with the code:\n`);
  for (const p of problems) {
    console.error(`  ${p.where}`);
    console.error(`    ${p.message ?? `claims ${p.fact} = ${p.claimed}, but the code says ${p.truth}`}`);
    if (p.snippet) console.error(`    ${p.snippet}`);
  }
  console.error('');
  process.exit(1);
}

const counted = Object.keys(facts).length;
console.log(`check-facts: ${agreed.length} claim(s) across the docs agree with the code (${counted} facts derived)`);
if (skipTests) console.log('check-facts: test counts skipped (--no-tests)');
