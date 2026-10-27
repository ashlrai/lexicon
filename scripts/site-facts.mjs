#!/usr/bin/env node
/**
 * Site facts: one pipeline from the repository's source of truth to the two
 * sites that describe it -- the Next app in web/ and the static demo page in
 * site/.
 *
 * What the sites say about Lexicon used to be hand-maintained and drifted in
 * every direction at once: the landing page carried VERSION = '0.5.0' while
 * package.json was at 0.5.2, the JSON-LD advertised seven importers while the
 * code had eight, and the install section told visitors to run "lexicon pack
 * add developer" for 155 terms when the packs held 176. This script derives
 * every such value from the code that produces it and pushes it into the
 * sites, so the numbers cannot rot:
 *
 *   node scripts/site-facts.mjs           # write generated output (facts.json + marked regions)
 *   node scripts/site-facts.mjs --check   # exit 1 on drift; prints one line per problem
 *   node scripts/site-facts.mjs --list    # print the derived facts and exit
 *   node scripts/site-facts.mjs --root DIR  # run against another tree (tests, fixtures)
 *
 * Ground truth, and where each value comes from:
 *   version             package.json `version`
 *   latestRelease       first dated `## X.Y.Z` section of CHANGELOG.md
 *                       (`## Unreleased` / `(unreleased)` are work in flight)
 *   commands.script     `curl -fsSL <gh-pages>/install.sh | sh`; the URL is
 *                       derived from repository.url and verified against the
 *                       header of scripts/install.sh
 *   commands.npm/npx    package.json `name` and `bin` keys
 *   commands.brew       packaging/homebrew/lexicon.rb -> brew install <tap>/<formula>
 *   commands.claude*    .claude-plugin/marketplace.json (marketplace + plugin names)
 *   mcpServerConfig     the block docs/MCP.md publishes; name from src/mcp/shared.ts,
 *                       command from package.json `bin`
 *   mcpTools            `server.registerTool('<name>'` calls, in the order
 *                       src/mcp/tools/index.ts's TOOL_REGISTRARS registers them
 *   mcpResources        `server.registerResource('<title>', '<uri>'` in src/mcp/server.ts
 *   mcpPrompts          `server.registerPrompt('<name>'` in src/mcp/server.ts
 *   clients             INSTALL_CLIENTS in src/cli/client-names.ts, minus `generic`
 *   exportFormats       EXPORT_FORMATS in src/core/types.ts
 *   importFormats       IMPORT_FORMATS in src/core/caps.ts, minus the `auto` sentinel
 *   cliCommands         top-level `program.command('<name>'` in src/cli/program.ts,
 *                       minus hidden ones (commander's implicit `help` never appears)
 *   packs               packs/*.yaml: file count, summed `canonical:` entries
 *   bench.synthetic     bench/results.json (the committed `npm run bench` output)
 *   bench.audio         bench/audio/results.md's headline table (committed
 *                       `npm run bench:audio` output) plus bench/lexicon.yaml
 *   benchTerms          `canonical:` count of bench/lexicon.yaml
 *   words               each count rendered as an English word, for prose that
 *                       reads "twenty-one tools" rather than "21 tools"
 *
 * Two output surfaces:
 *
 *   web/lib/generated/facts.json   -- gitignored, rebuilt by web's prebuild,
 *                                     imported by web/lib/site.ts and friends.
 *                                     Same lifecycle as media.json et al.
 *   site/index.html               -- committed; generated regions are bounded by
 *                                     <!-- site:begin NAME --> ... <!-- site:end -->
 *                                     markers (inline on one line or own-line
 *                                     blocks). scripts/build-site.mjs applies the
 *                                     same pass when copying the page into
 *                                     site/dist, so the shipped page carries
 *                                     truth even between syncs.
 *
 * The check holds every generated surface to the source: a stale marked
 * region, a hand-typed version literal anywhere under web/{app,components,lib}
 * or site/, an install command that is not the derived one, a prose count that
 * disagrees, and a site.ts list whose names no longer match the registered
 * tools. A line that legitimately carries a different version (a screenshot's
 * own version string) opts out with `check-facts:ignore`, the same marker
 * scripts/check-facts.mjs honours.
 */
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** The source text of a balanced `{...}` / `[...]` / `(...)` block starting at `openIndex`. */
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

function read(root, rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) throw new Error(`${rel} is missing`);
  return readFileSync(abs, 'utf8');
}

/** The single-quoted string items of a `const NAME = [...] as const` array, in order. */
function stringArray(src, name, file) {
  const at = src.indexOf(`export const ${name}`);
  if (at < 0) throw new Error(`${file} no longer exports ${name}`);
  const open = src.indexOf('[', src.indexOf('=', at));
  if (open < 0) throw new Error(`${file}: ${name} is not an array`);
  const body = block(src, open);
  const items = [];
  for (const m of body.matchAll(/^\s*'([^']*)'\s*,?\s*$/gm)) items.push(m[1]);
  if (items.length === 0) throw new Error(`parsed zero items out of ${file}:${name}`);
  return items;
}

const NUMBER_WORDS = new Map(
  Object.entries({
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23,
    'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27, 'twenty-eight': 28,
    'twenty-nine': 29, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
    hundred: 100,
  }),
);
const WORD_BY_NUM = new Map([...NUMBER_WORDS].map(([w, n]) => [n, w]));

/** 21 -> 'twenty-one'. Falls back to the digits for counts outside the table. */
export function numWord(n) {
  return WORD_BY_NUM.get(n) ?? String(n);
}

/** 'twenty-one' | '21' -> 21. */
export function wordToNum(raw) {
  const key = raw.toLowerCase();
  if (NUMBER_WORDS.has(key)) return NUMBER_WORDS.get(key);
  const n = Number(raw.replace(/[^\d]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Ground truth
// ---------------------------------------------------------------------------

function pkgJson(root) {
  const pkg = JSON.parse(read(root, 'package.json'));
  if (typeof pkg.version !== 'string' || !pkg.version) throw new Error('package.json has no "version" string');
  return pkg;
}

/** Every `## X.Y.Z` section of CHANGELOG.md, newest first; `(unreleased)` sections are skipped. */
function releases(root) {
  const text = read(root, 'CHANGELOG.md');
  const out = [];
  const heading = /^##\s+\[?v?(\d+\.\d+\.\d+)\]?\s*(?:\(([^)]*)\)|-\s*(\S+))?\s*$/gm;
  for (const m of text.matchAll(heading)) {
    const label = (m[2] ?? m[3] ?? '').trim();
    if (/unreleased/i.test(label)) continue;
    out.push({ version: m[1], date: /^\d{4}-\d{2}-\d{2}$/.test(label) ? label : null });
  }
  return out;
}

/**
 * The registered MCP tool names, in the order createServer() registers them:
 * TOOL_REGISTRARS order first, then `server.registerTool('name'` order within
 * each registrar's file. Static, so it works on a bare checkout with no dist/.
 */
function mcpTools(root) {
  const idx = read(root, 'src/mcp/tools/index.ts');
  const decl = idx.indexOf('TOOL_REGISTRARS');
  if (decl < 0) throw new Error('src/mcp/tools/index.ts no longer exports TOOL_REGISTRARS');
  const registrarBlock = block(idx, idx.indexOf('[', idx.indexOf('=', decl)));
  const registrars = [...registrarBlock.matchAll(/\b(register[A-Za-z]+Tools)\b/g)].map((m) => m[1]);
  if (registrars.length === 0) throw new Error('parsed zero registrars out of src/mcp/tools/index.ts');
  const dir = path.join(root, 'src/mcp/tools');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'index.ts');
  const tools = [];
  for (const registrar of registrars) {
    // The file a registrar lives in is found, not guessed from its name:
    // registerTermTools is in terms.ts, not term.ts.
    const file = files.find((f) => new RegExp(`export (?:const|async function|function) ${registrar}\\b`).test(readFileSync(path.join(dir, f), 'utf8')));
    if (!file) throw new Error(`no src/mcp/tools/*.ts file exports ${registrar}`);
    const src = readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)) tools.push(m[1]);
  }
  if (tools.length === 0) throw new Error('parsed zero tools out of src/mcp/tools');
  return tools;
}

/** `server.registerResource('<title>', '<uri>'` -> the uris, in order. */
function mcpResources(root) {
  const src = read(root, 'src/mcp/server.ts');
  const uris = [...src.matchAll(/server\.registerResource\(\s*'[^']*',\s*'([^']+)'/g)].map((m) => m[1]);
  if (uris.length === 0) throw new Error('parsed zero resources out of src/mcp/server.ts');
  return uris;
}

/** `server.registerPrompt('<name>'` -> the prompt names, in order. */
function mcpPrompts(root) {
  const src = read(root, 'src/mcp/server.ts');
  const names = [...src.matchAll(/server\.registerPrompt\(\s*'([a-z-]+)'/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error('parsed zero prompts out of src/mcp/server.ts');
  return names;
}

/**
 * Top-level `program.command('name'` calls in src/cli/program.ts. Nested
 * registrars (`pending.command`, `pack.command`) name their receiver instead,
 * and `{ hidden: true }` second arguments (install-claude) are left out, which
 * is what `lexicon --help` lists. Commander's implicit `help` never appears
 * here, matching scripts/check-facts.mjs's count.
 */
function cliCommands(root) {
  const src = read(root, 'src/cli/program.ts');
  const names = [];
  for (const m of src.matchAll(/\bprogram\s*\r?\n?\s*\.command\(\s*'([^']+)'(\s*,\s*\{[^}]*\})?/g)) {
    if (m[2] && /hidden\s*:\s*true/.test(m[2])) continue;
    if (!names.includes(m[1])) names.push(m[1]);
  }
  if (names.length === 0) throw new Error('parsed zero commands out of src/cli/program.ts');
  return names;
}

/** packs/*.yaml: the file count and the summed `- canonical:` entries. */
function packs(root) {
  const dir = path.join(root, 'packs');
  if (!existsSync(dir)) throw new Error('packs/ is missing');
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort();
  if (files.length === 0) throw new Error('packs/ holds no .yaml files');
  const names = [];
  let terms = 0;
  for (const f of files) {
    const text = readFileSync(path.join(dir, f), 'utf8');
    const n = (text.match(/^\s*-\s+canonical:/gm) ?? []).length;
    if (n === 0) throw new Error(`packs/${f} has no terms`);
    names.push(f.replace(/\.yaml$/, ''));
    terms += n;
  }
  return { names, count: files.length, terms };
}

function benchFacts(root) {
  const out = { synthetic: null, audio: null, terms: null };

  const resultsPath = path.join(root, 'bench/results.json');
  if (existsSync(resultsPath)) {
    const r = JSON.parse(readFileSync(resultsPath, 'utf8'));
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    out.synthetic = {
      cases: r.counts.cases,
      recallBefore: pct(r.terms.rawRecall.rate),
      recallAfter: pct(r.terms.recall.rate),
      // "clean prose wrongly changed: 0 of 95" counts ordinary negatives.
      proseChanged: r.sentence.negativesExcludingHard.total - r.sentence.negativesExcludingHard.hit,
      proseTotal: r.sentence.negativesExcludingHard.total,
    };
  }

  const lexPath = path.join(root, 'bench/lexicon.yaml');
  if (existsSync(lexPath)) {
    out.terms = (readFileSync(lexPath, 'utf8').match(/^\s*-?\s*canonical:/gm) ?? []).length;
  }

  // The audio benchmark's committed report is markdown; the headline table is
  // the only part the sites quote, and its shape is owned by bench/audio/run.ts.
  const audioPath = path.join(root, 'bench/audio/results.md');
  if (existsSync(audioPath)) {
    const text = readFileSync(audioPath, 'utf8');
    // One headline row -> its cells. Each cell carries "NN.N% (hit/total)",
    // "330" or "cached". Column order: base.en, base.en + prompt, small.en,
    // small.en + prompt.
    const row = (label) => {
      const m = new RegExp(`^\\| ${label} \\|(.*)\\|$`, 'm').exec(text);
      if (!m) throw new Error(`bench/audio/results.md has no '${label}' headline row`);
      return m[1]
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '')
        .map((cell) => {
          const p = /\*\*?(\d+(?:\.\d+)?)%\*\*?/.exec(cell) ?? /(\d+(?:\.\d+)?)%/.exec(cell);
          const frac = /\((\d+)\/(\d+)\)/.exec(cell);
          const bare = /^\d+$/.test(cell) ? Number(cell) : null;
          return { pct: p ? `${p[1]}%` : null, hit: frac ? Number(frac[1]) : null, total: frac ? Number(frac[2]) : null, num: bare };
        });
    };
    const clipsRow = row('clips');
    const raw = row('term recall, raw Whisper');
    const after = row('term recall, after lexicon');
    const prose = row('prose false-positive rate excl\\. expected-hard');
    const clips = clipsRow[0].num;
    if (!Number.isFinite(clips)) throw new Error("bench/audio/results.md: could not read the 'clips' headline row");
    // "Sentences: 110 (80 with lexicon terms, 30 clean prose; 6 marked
    // expected-hard) x 3 voice(s) = 330 clips per variant." is written by
    // bench/audio/run.ts; the sites quote the 110 and the 3.
    const prov = /Sentences:\s*(\d+)\s*\((\d+) with lexicon terms,\s*(\d+) clean prose;\s*(\d+) marked expected-hard\)\s*x\s*(\d+) voice\(s\)\s*=\s*(\d+) clips/.exec(text);
    out.audio = {
      clips,
      sentencesPerVoice: prov ? Number(prov[1]) : null,
      voices: prov ? Number(prov[5]) : null,
      raw: { base: raw[0].pct, promptBase: raw[1].pct, small: raw[2].pct, promptSmall: raw[3].pct },
      lexicon: { base: after[0].pct, promptBase: after[1].pct, small: after[2].pct, promptSmall: after[3].pct },
      proseUnchanged: { hit: prose[2].hit, total: prose[2].total },
    };
  }

  // The alternatives table (raw / exact substitution / + casing / --prompt /
  // Lexicon, on small.en) is committed prose in docs/BENCHMARK.md, generated by
  // `npm run bench:compare`. The sites repeat the recovered% column; parse it
  // here rather than letting the pages keep their own copy.
  const benchMd = path.join(root, 'docs/BENCHMARK.md');
  if (existsSync(benchMd)) {
    const text = readFileSync(benchMd, 'utf8');
    const small = /### small\.en([\s\S]*?)### base\.en/.exec(text)?.[1] ?? '';
    const cond = (label) => {
      const m = new RegExp(`^\\|\\s*\\*{0,2}${label}\\*{0,2}\\s*\\|\\s*\\*{0,2}(\\d+\\.\\d+)%`, 'm').exec(small);
      return m ? `${m[1]}%` : null;
    };
    const proseCell = /^\|\s*\*{0,2}Lexicon\*{0,2}\s*\|.*\|\s*\*{0,2}(\d+) of (\d+)\*{0,2}\s*\|$/m.exec(small);
    const inexact = /recover (\d+) of the (\d+) term slots\s+by themselves on `small\.en`, which is ([\d.]+) points/.exec(text);
    out.compare = {
      raw: cond('raw whisper\\.cpp'),
      exact: cond('exact substitution'),
      exactCasing: cond('exact substitution \\+ canonical casing rules'),
      prompt: cond('whisper\\.cpp `--prompt`'),
      lexicon: cond('Lexicon'),
      cleanProse: proseCell ? { hit: Number(proseCell[1]), total: Number(proseCell[2]) } : null,
      inexactTiers: inexact ? { terms: Number(inexact[1]), slots: Number(inexact[2]), points: inexact[3] } : null,
    };
  }
  return out;
}

function commands(root, pkg) {
  const repo = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  const gh = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(repo);
  if (!gh) throw new Error(`package.json repository.url '${repo}' is not a github.com URL`);
  const pages = `https://${gh[1].toLowerCase()}.github.io/${gh[2]}`;
  const script = `curl -fsSL ${pages}/install.sh | sh`;

  // The installer's own header states the one-liner; drift there would fail loudly.
  const installSh = read(root, 'scripts/install.sh');
  if (!installSh.includes(script)) {
    throw new Error(`scripts/install.sh does not mention its own install line '${script}'`);
  }

  const name = pkg.name;
  if (typeof name !== 'string' || !name.startsWith('@')) throw new Error(`package.json name '${name}' is not a scoped package`);
  const bins = Object.keys(pkg.bin ?? {});
  const cli = bins.find((b) => b === 'lexicon') ?? bins[0];
  const mcp = bins.find((b) => b === 'lexicon-mcp') ?? bins[1];
  if (!cli || !mcp) throw new Error('package.json bin must define lexicon and lexicon-mcp');

  // Homebrew: the formula file name is the formula; the tap is <owner>/tap.
  const formula = 'packaging/homebrew/lexicon.rb';
  const brew = `brew install ${gh[1]}/tap/${path.basename(formula, '.rb')}`;
  if (!existsSync(path.join(root, formula))) throw new Error(`${formula} is missing`);

  // Claude Code plugin route: the marketplace and plugin names are the manifest's.
  const market = JSON.parse(read(root, '.claude-plugin/marketplace.json'));
  const plugin = market.plugins?.[0]?.name;
  if (!market.name || !plugin) throw new Error('.claude-plugin/marketplace.json is missing name/plugins[0].name');

  return {
    script,
    npx: `npx ${name}@latest ${cli === 'lexicon' ? 'setup' : cli}`,
    brew,
    npm: `npm i -g ${name}`,
    claudePlugin: `claude plugin marketplace add ${gh[1]}/${gh[2]}`,
    claudePluginInstall: `claude plugin install ${plugin}@${market.name}`,
    cliBin: cli,
    mcpBin: mcp,
  };
}

/** Everything the sites may state, derived from the repository. */
export function deriveSiteFacts(root = repoRoot) {
  const pkg = pkgJson(root);
  const rel = releases(root);
  const cmds = commands(root, pkg);
  const serverSrc = read(root, 'src/mcp/shared.ts');
  const serverName = /export const SERVER_NAME = '([^']+)'/.exec(serverSrc)?.[1];
  if (!serverName) throw new Error('src/mcp/shared.ts no longer exports SERVER_NAME');

  const tools = mcpTools(root);
  const resources = mcpResources(root);
  const prompts = mcpPrompts(root);
  const clients = stringArray(read(root, 'src/cli/client-names.ts'), 'INSTALL_CLIENTS', 'client-names.ts').filter(
    (c) => c !== 'generic',
  );
  const exportFormats = stringArray(read(root, 'src/core/types.ts'), 'EXPORT_FORMATS', 'types.ts');
  const importFormats = stringArray(read(root, 'src/core/caps.ts'), 'IMPORT_FORMATS', 'caps.ts').filter(
    (f) => f !== 'auto',
  );
  const cli = cliCommands(root);
  const pack = packs(root);
  const bench = benchFacts(root);

  const counts = {
    tools: tools.length,
    resources: resources.length,
    prompts: prompts.length,
    clients: clients.length,
    exportFormats: exportFormats.length,
    importFormats: importFormats.length,
    cliCommands: cli.length,
    packs: pack.count,
    packTerms: pack.terms,
    benchTerms: bench.terms ?? 0,
    benchClips: bench.audio?.clips ?? 0,
    benchSentencesPerVoice: bench.audio?.sentencesPerVoice ?? 0,
    benchVoices: bench.audio?.voices ?? 0,
  };
  const words = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, numWord(n)]));

  return {
    version: pkg.version,
    latestRelease: rel[0] ?? null,
    packageName: pkg.name,
    serverName,
    commands: {
      script: cmds.script,
      npx: cmds.npx,
      brew: cmds.brew,
      npm: cmds.npm,
      claudePlugin: cmds.claudePlugin,
      claudePluginInstall: cmds.claudePluginInstall,
    },
    mcpServerConfig: { mcpServers: { [serverName]: { command: cmds.mcpBin, args: [] } } },
    mcpTools: tools,
    mcpResources: resources,
    mcpPrompts: prompts,
    clients,
    exportFormats,
    importFormats,
    cliCommands: cli,
    packs: pack,
    bench,
    counts,
    words,
  };
}

// ---------------------------------------------------------------------------
// The facts.json artifact (web/lib/generated/)
// ---------------------------------------------------------------------------

/** The JSON document site.ts imports. Stable key order so diffs stay readable. */
export function factsDocument(facts) {
  return {
    version: facts.version,
    latestRelease: facts.latestRelease,
    packageName: facts.packageName,
    serverName: facts.serverName,
    commands: facts.commands,
    mcpServerConfig: facts.mcpServerConfig,
    mcpTools: facts.mcpTools,
    mcpResources: facts.mcpResources,
    mcpPrompts: facts.mcpPrompts,
    clients: facts.clients,
    exportFormats: facts.exportFormats,
    importFormats: facts.importFormats,
    cliCommands: facts.cliCommands,
    packs: facts.packs,
    bench: facts.bench,
    counts: facts.counts,
    words: facts.words,
  };
}

export function factsJsonPath(root = repoRoot) {
  return path.join(root, 'web/lib/generated/facts.json');
}

export function writeFactsJson(facts, root = repoRoot) {
  const out = factsJsonPath(root);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(factsDocument(facts), null, 2) + '\n');
  return out;
}

// ---------------------------------------------------------------------------
// Marked regions in site/index.html
// ---------------------------------------------------------------------------

/**
 * A region the generator owns is bounded in the page itself:
 *
 *     <code class="mono"><!-- site:begin cmd:npm -->npm i -g @ashlr/lexicon<!-- site:end --></code>
 *
 * Both markers on one line make an inline region; on their own lines they make
 * a block region (the newline pair is part of the generated text). The `site:`
 * namespace is deliberately separate from the docs' `fresh:` markers: those
 * belong to scripts/freshness/ (doc prose), these belong to the two sites.
 */
const SITE_MARKER = /<!--\s*site:(begin|end)(?:\s+([A-Za-z][\w:.-]*))?\s*-->/g;

/**
 * What each marker renders. The value is raw HTML text -- call sites mark only
 * the literal the page shows, so the generated text is the literal itself.
 */
export function renderSiteBlock(name, facts) {
  const cmd = /^cmd:([a-zA-Z]+)$/.exec(name);
  if (cmd) {
    const value = facts.commands[cmd[1]];
    if (!value) throw new Error(`unknown command '${cmd[1]}' (known: ${Object.keys(facts.commands).join(', ')})`);
    return value;
  }
  const attr = /^cmd-attr:([a-zA-Z]+)$/.exec(name);
  if (attr) return `data-copy="${renderSiteBlock(`cmd:${attr[1]}`, facts)}"`;

  switch (name) {
    case 'version':
      return facts.version;
    case 'bench:recallBefore':
      return needBench(facts, name).recallBefore;
    case 'bench:recallAfter':
      return needBench(facts, name).recallAfter;
    case 'bench:cases':
      return String(needBench(facts, name).cases);
    case 'bench:proseUnchanged': {
      const s = needBench(facts, name);
      return `${s.proseChanged} of ${s.proseTotal}`;
    }
    case 'bench:terms':
      if (!facts.bench.terms) throw new Error('bench/lexicon.yaml is missing; cannot render bench:terms');
      return String(facts.bench.terms);
    case 'bench:audioPromptBefore':
      return needAudio(facts, name).raw.promptSmall;
    case 'bench:audioPromptAfter':
      return needAudio(facts, name).lexicon.promptSmall;
    default:
      throw new Error(`unknown site block '${name}'. Known: ${siteBlockNames().join(', ')}`);
  }
}

function needBench(facts, name) {
  if (!facts.bench.synthetic) throw new Error(`'${name}' needs bench/results.json (run npm run bench)`);
  return facts.bench.synthetic;
}
function needAudio(facts, name) {
  if (!facts.bench.audio) throw new Error(`'${name}' needs bench/audio/results.md (run npm run bench:audio)`);
  return facts.bench.audio;
}

export function siteBlockNames() {
  return [
    'version',
    'cmd:script', 'cmd:npx', 'cmd:brew', 'cmd:npm', 'cmd:claudePlugin', 'cmd:claudePluginInstall',
    'cmd-attr:script', 'cmd-attr:npx', 'cmd-attr:brew', 'cmd-attr:npm',
    'cmd-attr:claudePlugin', 'cmd-attr:claudePluginInstall',
    'bench:recallBefore', 'bench:recallAfter', 'bench:cases', 'bench:proseUnchanged', 'bench:terms',
    'bench:audioPromptBefore', 'bench:audioPromptAfter',
  ];
}

function lineAt(text, i) {
  let n = 1;
  for (let k = 0; k < i && k < text.length; k += 1) if (text[k] === '\n') n += 1;
  return n;
}

/**
 * Regenerate every marked region of `text`. Returns
 * `{ text, blocks, problems }` -- one `blocks` entry per marker pair
 * ({ name, line, stale }) and one `problems` entry per malformed marker.
 */
export function applySiteMarkers(text, facts) {
  const problems = [];
  const blocks = [];
  let out = '';
  let cursor = 0;
  let open = null; // { name, contentStart, line }
  SITE_MARKER.lastIndex = 0;
  let m;
  while ((m = SITE_MARKER.exec(text)) !== null) {
    const [full, kind, name] = m;
    const line = lineAt(text, m.index);
    if (kind === 'begin') {
      if (!name) {
        problems.push({ line, message: 'site:begin needs a block name: <!-- site:begin cmd:npm -->' });
        open = { name: null, contentStart: m.index + full.length, line };
      } else if (open) {
        problems.push({ line, message: `site:begin '${name}' opens inside '${open.name}' (line ${open.line}); regions do not nest` });
      } else {
        open = { name, contentStart: m.index + full.length, line };
      }
      continue;
    }
    if (!open) {
      problems.push({ line, message: 'site:end without a matching site:begin' });
      continue;
    }
    const endLine = lineAt(text, m.index);
    const oldRegion = text.slice(open.contentStart, m.index);
    if (open.name === null) {
      open = null;
      continue;
    }
    let rendered;
    try {
      rendered = renderSiteBlock(open.name, facts);
    } catch (err) {
      problems.push({ line: open.line, message: err.message });
      open = null;
      continue;
    }
    const sameLine = open.line === endLine;
    const newRegion = sameLine ? rendered : `\n${rendered}\n`;
    out += text.slice(cursor, open.contentStart) + newRegion;
    cursor = m.index;
    blocks.push({ name: open.name, line: open.line, stale: oldRegion !== newRegion });
    open = null;
  }
  if (open) problems.push({ line: open.line, message: `unclosed site:begin '${open.name}'` });
  out += text.slice(cursor);
  return { text: out, blocks, problems };
}

/** Sync the marked regions of site/index.html in place. Returns the per-block report. */
export function syncSiteHtml(facts, root = repoRoot) {
  const rel = 'site/index.html';
  const abs = path.join(root, rel);
  const { text, blocks, problems } = applySiteMarkers(readFileSync(abs, 'utf8'), facts);
  if (problems.length === 0 && blocks.some((b) => b.stale)) writeFileSync(abs, text);
  return { file: rel, path: abs, blocks, problems };
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

const SCAN_DIRS = ['web/app', 'web/components', 'web/lib', 'site'];
const SCAN_FILE = /\.(ts|tsx|html)$/i;
const SKIP_DIR = /^(node_modules|\.next|dist|generated)$/;

function scanFiles(root) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) {
      if (SCAN_FILE.test(rel)) out.push(rel);
      return;
    }
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIR.test(entry.name)) continue;
      walk(path.join(rel, entry.name), out);
    }
  };
  for (const rel of SCAN_DIRS) walk(rel);
  return out.sort();
}

const NUM = `(\\d{1,5}|${[...NUMBER_WORDS.keys()].sort((a, b) => b.length - a.length).join('|')})`;

/**
 * Prose counts, same idea as scripts/check-facts.mjs but scoped to what the
 * two sites claim. Patterns are kept tight on purpose: a loose one becomes a
 * false failure and teaches people to ignore this script.
 */
const COUNT_CLAIMS = [
  { fact: 'tools', re: new RegExp(`\\b${NUM}\\s+(?:MCP\\s+|lexicon\\s+)?tools\\b`, 'i') },
  { fact: 'resources', re: new RegExp(`\\b${NUM}\\s+(?:MCP\\s+)?resources\\b`, 'i'), need: /\bMCP\b|\btools?\b|\bprompts?\b/i },
  { fact: 'prompts', re: new RegExp(`\\b${NUM}\\s+(?:MCP\\s+)?prompts\\b`, 'i'), need: /\bMCP\b|\btools?\b|\bresources?\b/i },
  { fact: 'exportFormats', re: new RegExp(`\\b${NUM}\\s+export\\s+formats\\b`, 'i') },
  { fact: 'importFormats', re: new RegExp(`\\b${NUM}\\s+(?:\\w+\\s+)?importers\\b|\\b${NUM}\\s+import\\s+formats\\b`, 'i'), need: /import|format/i },
  { fact: 'cliCommands', re: new RegExp(`\\b${NUM}\\s+(?:top-level\\s+|CLI\\s+)?commands\\b`, 'i') },
  { fact: 'packs', re: new RegExp(`\\b${NUM}\\s+starter\\s+packs\\b|\\b${NUM}\\s+packs\\b(?!\\s+(?:add|remove|list|show))`, 'i') },
  { fact: 'packTerms', re: new RegExp(`\\b${NUM}\\s+(?:curated\\s+|starter\\s+)?terms\\s+across\\b|\\b${NUM}\\s+curated\\s+terms\\b`, 'i') },
  { fact: 'clients', re: new RegExp(`\\b${NUM}\\s+supported\\s+clients\\b`, 'i') },
];

/** A `#vX.Y.Z` git-tag pin names the source version, per scripts/check-facts.mjs. */
const VERSION_PIN = /#v(\d+\.\d+\.\d+)/g;
/**
 * Any other semver literal on a site surface. The lookarounds keep IP-shaped
 * strings (127.0.0.1) and partial versions from matching.
 */
const VERSION_LITERAL = /(?<![\w.])v?(\d+\.\d+\.\d+)(?![\w.])/g;

/**
 * Every install command shape a page may print. Each maps to the derived
 * command it must equal; a command literal matching a prefix but not the
 * canonical string is drift.
 */
function commandClaims(facts) {
  const c = facts.commands;
  return [
    { re: /curl -fsSL https:\/\/[\w.-]+\/[\w./-]*install\.sh\s*\|\s*(?:sudo\s+)?sh/g, expect: c.script, label: 'the install script command' },
    { re: /npm i(?:nstall)? -g [@\w/.-]+/g, expect: c.npm, label: 'the npm install command' },
    { re: /npx @ashlr\/[\w@/.-]+ setup/g, expect: c.npx, label: 'the npx setup command' },
    { re: /brew install [\w/.-]+/g, expect: c.brew, label: 'the brew install command' },
    { re: /claude plugin marketplace add [\w/.-]+/g, expect: c.claudePlugin, label: 'the marketplace add command' },
    { re: /claude plugin install [\w@/.-]+/g, expect: c.claudePluginInstall, label: 'the plugin install command' },
  ];
}

/**
 * Literal `lexicon install <client>` lines: <client> must be a real
 * INSTALL_CLIENTS entry (or `generic`), never an invented one. A quote,
 * backtick or tag edge must precede `lexicon`, so prose like "lexicon install
 * writes the config into..." does not read as a command.
 */
const INSTALL_CLIENT_RE = /[`"'>]lexicon install ([a-z-]+)( --apply)?/g;

/**
 * Eval the `export const X = [...]` array of site.ts with FACTS in scope.
 * site.ts is plain data we own (same eval-slice pattern gen-faq-doc.mjs uses),
 * so interpolations like `${FACTS.words.tools}` evaluate rather than parse.
 */
function evalSiteArray(src, name, facts) {
  return evalSiteConst(src, name, '[', facts);
}

/** Eval `export const X = { ... }` object literals (TOOL_SUMMARIES). */
function evalSiteObject(src, name, facts) {
  return evalSiteConst(src, name, '{', facts);
}

function evalSiteConst(src, name, openCh, facts) {
  const marker = `export const ${name}`;
  const at = src.indexOf(marker);
  if (at < 0) return undefined;
  const open = src.indexOf(openCh, src.indexOf('=', at));
  if (open < 0) return undefined;
  const text = block(src, open);
  return eval(`(() => { const FACTS = ${JSON.stringify(factsDocument(facts))}; return ${text}; })()`);
}

/**
 * Structural checks on web/lib/site.ts: the lists it publishes must be the
 * derived lists, not merely lists of the same length. VERSION and the command
 * tables must route through FACTS rather than redeclare literals.
 */
function checkSiteTs(root, facts, problems) {
  const rel = 'web/lib/site.ts';
  const src = read(root, rel);
  const where = (m) => ({ file: rel, message: m });

  // MCP_TOOLS maps over the derived tool list; the hand-written part is
  // TOOL_SUMMARIES, one summary per registered name. A missing summary leaves
  // the site saying the generic fallback, which is the drift this catches.
  const summaries = evalSiteObject(src, 'TOOL_SUMMARIES', facts);
  if (summaries === undefined) {
    problems.push(where('no longer exports the TOOL_SUMMARIES map'));
  } else {
    const missing = facts.mcpTools.filter((n) => !(n in summaries));
    const extra = Object.keys(summaries).filter((n) => !facts.mcpTools.includes(n));
    if (missing.length) problems.push(where(`TOOL_SUMMARIES has no entry for registered tool(s): ${missing.join(', ')}`));
    if (extra.length) problems.push(where(`TOOL_SUMMARIES names tool(s) the server does not register: ${extra.join(', ')}`));
  }

  const resources = evalSiteArray(src, 'MCP_RESOURCES', facts);
  if (resources === undefined) {
    problems.push(where('no longer exports the MCP_RESOURCES list'));
  } else {
    const uris = resources.map((r) => r.uri);
    if (uris.join(',') !== facts.mcpResources.join(',')) {
      problems.push(where(`MCP_RESOURCES lists ${uris.join(', ')}, but the server registers ${facts.mcpResources.join(', ')}`));
    }
  }

  const prompts = evalSiteArray(src, 'MCP_PROMPTS', facts);
  if (prompts === undefined) {
    problems.push(where('no longer exports the MCP_PROMPTS list'));
  } else {
    const names = prompts.map((p) => p.name);
    if (names.join(',') !== facts.mcpPrompts.join(',')) {
      problems.push(where(`MCP_PROMPTS lists ${names.join(', ')}, but the server registers ${facts.mcpPrompts.join(', ')}`));
    }
  }

  // The benchmark rows the page renders must be the committed numbers, in the
  // order the tables show them.
  const stats = evalSiteArray(src, 'AUDIO_STATS', facts);
  if (stats === undefined) {
    problems.push(where('no longer exports the AUDIO_STATS list'));
  } else {
    const a = facts.bench.audio;
    const expected = [
      [a.raw.base, a.lexicon.base],
      [a.raw.promptSmall, a.lexicon.promptSmall],
    ];
    const got = stats.map((s) => [s.before, s.after]);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(where('AUDIO_STATS disagrees with bench/audio/results.md'));
    }
  }

  const comparison = evalSiteArray(src, 'COMPARISON', facts);
  if (comparison === undefined) {
    problems.push(where('no longer exports the COMPARISON table'));
  } else {
    const c = facts.bench.compare;
    const prose = `${c.cleanProse.hit} of ${c.cleanProse.total}`;
    const expected = [
      [c.raw, 'nothing runs'],
      [c.exact, prose],
      [c.exactCasing, prose],
      [c.prompt, 'nothing runs'],
      [c.lexicon, prose],
    ];
    const got = comparison.map((r) => [r.recovered, r.prose]);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      problems.push(where('COMPARISON disagrees with docs/BENCHMARK.md'));
    }
  }

  // These constants must be generated, not hand-maintained: a literal that
  // happens to be right today still rots on the next release.
  const routed = [
    ['VERSION', 'FACTS.version'],
    ['PRIMARY_COMMAND', 'FACTS.commands.script'],
    ['INSTALL_COMMANDS', 'FACTS.commands'],
    ['CLIENTS', 'FACTS.clients'],
    ['MCP_TOOLS', 'FACTS.mcpTools'],
    ['MCP_SERVER_CONFIG', 'FACTS.mcpServerConfig'],
  ];
  for (const [name, via] of routed) {
    const m = new RegExp(`export const ${name}[^=\\n]*=\\s*([^;\\n]+)`).exec(src);
    if (!m) {
      problems.push(where(`no longer exports ${name}`));
    } else if (!m[1].trim().startsWith(via)) {
      problems.push(where(`${name} is hand-maintained; route it through \`${via}\` (run: npm run site:facts)`));
    }
  }
}

/** The whole check. Returns one { file, line?, message } per problem. */
export function checkSite(root = repoRoot) {
  const facts = deriveSiteFacts(root);
  const problems = [];

  // 1. The generated artifact: when present it must be the truth rendered.
  const factsPath = factsJsonPath(root);
  if (existsSync(factsPath)) {
    const committed = readFileSync(factsPath, 'utf8');
    const generated = JSON.stringify(factsDocument(facts), null, 2) + '\n';
    if (committed !== generated) {
      problems.push({
        file: 'web/lib/generated/facts.json',
        message: 'is stale; run: npm run site:facts (or web: `node scripts/gen-facts.mjs`)',
      });
    }
  }

  // 2. site/index.html's marked regions.
  const html = read(root, 'site/index.html');
  const marked = applySiteMarkers(html, facts);
  for (const p of marked.problems) problems.push({ file: 'site/index.html', line: p.line, message: p.message });
  for (const b of marked.blocks) {
    if (b.stale) {
      problems.push({ file: 'site/index.html', line: b.line, message: `'${b.name}' is stale; run: npm run site:facts` });
    }
  }

  // 3. web/lib/site.ts structural checks.
  checkSiteTs(root, facts, problems);

  // 4. Literal scans: versions, commands, prose counts.
  for (const rel of scanFiles(root)) {
    for (const p of checkSiteLines(facts, rel, readFileSync(path.join(root, rel), 'utf8'))) {
      problems.push(p);
    }
  }
  return { facts, problems };
}

/**
 * The literal-claim scan for one file's text: version pins and literals,
 * install commands, `lexicon install <client>` names and prose counts. Exported
 * so the tests can feed a line rather than a whole fixture tree.
 */
export function checkSiteLines(facts, rel, text) {
  const problems = [];
  const allowedVersions = new Set([facts.version, facts.latestRelease?.version].filter(Boolean));
  const cmdClaims = commandClaims(facts);
  text.split(/\r?\n/).forEach((line, i) => {
    if (/check-facts:ignore|site-facts:ignore/.test(line)) return;
    // Marked regions are generated; a stale one is reported by the marker
    // pass, so the literal scans skip them to report drift once. SVG path
    // data holds digit.digit.digit runs that are geometry, not versions.
    const withoutMarkers = line
      .replace(/<!--\s*site:begin [A-Za-z][\w:.-]*\s*-->.*?<!--\s*site:end\s*-->/g, '')
      .replace(/<!--\s*site:(begin|end)[^>]*-->/g, '')
      .replace(/\bd="[^"]*"/g, '');

    for (const m of withoutMarkers.matchAll(VERSION_PIN)) {
      if (m[1] !== facts.version) {
        problems.push({ file: rel, line: i + 1, message: `pins #v${m[1]}, but package.json is ${facts.version}` });
      }
    }
    for (const m of withoutMarkers.matchAll(VERSION_LITERAL)) {
      if (!allowedVersions.has(m[1])) {
        problems.push({ file: rel, line: i + 1, message: `shows version ${m[1]}, but package.json is ${facts.version}` });
      }
    }
    for (const { re, expect, label } of cmdClaims) {
      for (const m of withoutMarkers.matchAll(re)) {
        if (m[0] !== expect) {
          problems.push({ file: rel, line: i + 1, message: `shows '${m[0]}'; ${label} is '${expect}'` });
        }
      }
    }
    for (const m of withoutMarkers.matchAll(INSTALL_CLIENT_RE)) {
      const client = m[1];
      if (![...facts.clients, 'generic'].includes(client)) {
        problems.push({ file: rel, line: i + 1, message: `names install client '${client}', which INSTALL_CLIENTS does not have` });
      }
    }
    for (const claim of COUNT_CLAIMS) {
      if (claim.need && !claim.need.test(withoutMarkers)) continue;
      const m = claim.re.exec(withoutMarkers);
      if (!m) continue;
      // Some claim patterns carry a second branch, shifting the number's
      // group index; take whichever capture actually matched.
      const claimed = wordToNum(m.slice(1).find((g) => g !== undefined));
      const truth = facts.counts[claim.fact];
      if (claimed === undefined || truth === undefined) continue;
      if (claimed !== truth) {
        problems.push({ file: rel, line: i + 1, message: `claims ${claim.fact} = ${claimed}, but the code says ${truth}` });
      }
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Imported as a module (web/scripts/gen-facts.mjs, scripts/build-site.mjs, the
// tests): the CLI half only runs when this file is the entry point.
const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  let root = repoRoot;
  const rootAt = argv.findIndex((a) => a === '--root');
  if (rootAt >= 0) root = path.resolve(argv[rootAt + 1]);

  if (flags.has('--help')) {
    console.log('usage: node scripts/site-facts.mjs [--check | --list | --blocks] [--root DIR]');
    process.exit(0);
  }

  const facts = deriveSiteFacts(root);

  if (flags.has('--list')) {
    console.log(JSON.stringify(factsDocument(facts), null, 2));
    process.exit(0);
  }
  if (flags.has('--blocks')) {
    for (const name of siteBlockNames()) console.log(name);
    process.exit(0);
  }

  if (flags.has('--check')) {
    const { problems } = checkSite(root);
    if (problems.length > 0) {
      console.error(`\n${problems.length} site fact(s) disagree with the code:\n`);
      for (const p of problems) {
        console.error(`  ${p.file}${p.line ? `:${p.line}` : ''}`);
        console.error(`    ${p.message}`);
      }
      console.error('');
      process.exit(1);
    }
    console.log('site-facts: every generated value and site claim agrees with the code');
    process.exit(0);
  }

  // Default: write the generated surfaces.
  const out = writeFactsJson(facts, root);
  console.log(`${path.relative(root, out)}  ${facts.mcpTools.length} tools, ${facts.exportFormats.length} export formats, ${facts.packs.terms} pack terms, v${facts.version}`);

  const synced = syncSiteHtml(facts, root);
  if (synced.problems.length > 0) {
    for (const p of synced.problems) console.error(`site/index.html:${p.line}  ${p.message}`);
    process.exit(1);
  }
  const stale = synced.blocks.filter((b) => b.stale);
  console.log(
    stale.length === 0
      ? `site/index.html  ${synced.blocks.length} generated region(s) already in sync`
      : `site/index.html  regenerated ${stale.map((b) => `'${b.name}'`).join(', ')}`,
  );
}
