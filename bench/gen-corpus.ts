/**
 * Deterministic corpus generator for the accuracy benchmark.
 *
 *   node --import tsx bench/gen-corpus.ts
 *
 * Positive cases are produced from TEMPLATES x HEARD (what STT actually emits
 * for each canonical), with a seeded PRNG choosing the template so the output
 * is byte-for-byte reproducible. Hand-written cases (bench/cases/*.jsonl:
 * clean-prose negatives, expected-hard cases, mixed code/URL positives) are
 * appended verbatim. The result is written to bench/corpus.jsonl.
 *
 * The generator deliberately does not import the matcher, so the corpus is a
 * fixed target that does not drift with matcher changes. The one exception is
 * a sanity check that no template mutates on its own (a template containing a
 * lexicon alias would contaminate every case built from it).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { normalize } from '../src/core/normalize.js';
import { parseLexicon } from '../src/core/schema.js';
import type { BenchCase, BenchCategory } from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 20260919;

// ---------------------------------------------------------------------------
// What STT hears for each term. Variants marked in bench/lexicon.yaml as
// aliases are recovered by the alias pass; the rest exercise phonetic/fuzzy.
// ---------------------------------------------------------------------------

interface TermSpec {
  canonical: string;
  category: Exclude<BenchCategory, 'prose'>;
  heard: string[];
}

const TERMS: TermSpec[] = [
  // brands
  { canonical: 'Ashlr.AI', category: 'brand', heard: ['ashler', 'ashlar', 'ashler ai', 'ashley our ai'] },
  { canonical: 'Hetzner', category: 'brand', heard: ['hetsner', 'head sner', 'hets nur'] },
  { canonical: 'Vercel', category: 'brand', heard: ['versel', 'ver cell', 'vercell'] },
  { canonical: 'Supabase', category: 'brand', heard: ['soup a base', 'super base', 'supa base'] },
  { canonical: 'Neon', category: 'brand', heard: ['knee on', 'nee on', 'neon'] },
  { canonical: 'Upstash', category: 'brand', heard: ['up stash', 'upstache', 'up stache'] },
  { canonical: 'Deepgram', category: 'brand', heard: ['deep gram', 'deep graham', 'deepgram'] },
  { canonical: 'Wispr Flow', category: 'brand', heard: ['whisper flow', 'whisper flo', 'wisper flow'] },
  { canonical: 'Superwhisper', category: 'brand', heard: ['super whisper', 'superwisper', 'super wisper'] },
  { canonical: 'OpenClaw', category: 'brand', heard: ['open claw', 'open clause', 'open klaw'] },
  { canonical: 'Anthropic', category: 'brand', heard: ['anthropik', 'an thropic', 'anthropic'] },
  { canonical: 'Cloudflare', category: 'brand', heard: ['cloud flare', 'cloudflair', 'cloud flair'] },
  // products
  { canonical: 'Kubernetes', category: 'product', heard: ['cooper netties', 'cube or netties', 'kubernetties', "cooper nettie's"] },
  { canonical: 'Pydantic', category: 'product', heard: ['pie dantic', 'pie dentic', 'pie dan tick'] },
  { canonical: 'PostgreSQL', category: 'product', heard: ['post gress', 'postgress', 'post grass', 'postgre sequel'] },
  { canonical: 'SQLite', category: 'product', heard: ['sequel light', 'sequel lite', 'ess queue lite'] },
  { canonical: 'Redis', category: 'product', heard: ['reddis', 'red iss', 'readis'] },
  { canonical: 'Next.js', category: 'product', heard: ['next js', 'next jay ess', 'next jazz'] },
  { canonical: 'Tailwind', category: 'product', heard: ['tail wind', 'tailwin', 'tale wind'] },
  { canonical: 'Zod', category: 'product', heard: ['zawed', 'zaad', 'zod'] },
  { canonical: 'Vite', category: 'product', heard: ['veet', 'vee t', 'veat'] },
  { canonical: 'Vitest', category: 'product', heard: ['vee test', 'vi test', 'vitest'] },
  { canonical: 'Prisma', category: 'product', heard: ['prizma', 'prism a', 'prismo'] },
  { canonical: 'Drizzle', category: 'product', heard: ['drizzel', 'drizzl', 'drizzle'] },
  { canonical: 'tRPC', category: 'product', heard: ['t r p c', 'tea r p c', 'trpc', 't rpc'] },
  { canonical: 'GraphQL', category: 'product', heard: ['graph q l', 'graph queue el', 'graph cool'] },
  { canonical: 'OAuth', category: 'product', heard: ['oh auth', 'o off', 'oh off'] },
  { canonical: 'JWT', category: 'product', heard: ['jot', 'j w t', 'jay double u tee'] },
  { canonical: 'Nginx', category: 'product', heard: ['engine x', 'engine ex', 'en jinx'] },
  { canonical: 'Terraform', category: 'product', heard: ['terra form', 'tera form', 'terraform'] },
  { canonical: 'Docker', category: 'product', heard: ['docker', 'dock her', 'doker'] },
  { canonical: 'Kafka', category: 'product', heard: ['cough ka', 'kaf ka', 'cafca'] },
  { canonical: 'Grafana', category: 'product', heard: ['gra fauna', 'graph fauna', 'gravana'] },
  { canonical: 'Prometheus', category: 'product', heard: ['promethius', 'pro metheus', 'prometheus'] },
  { canonical: 'Playwright', category: 'product', heard: ['playwrite', 'playwright', 'play wright'] },
  { canonical: 'Puppeteer', category: 'product', heard: ['puppet ear', 'puppet tear', 'pup a tear'] },
  { canonical: 'LangChain', category: 'product', heard: ['lang chain', 'langchain', 'lang chane'] },
  { canonical: 'Ollama', category: 'product', heard: ['oh llama', 'o llama', 'olama'] },
  { canonical: 'Whisper', category: 'product', heard: ['wisper', 'whisper', 'whispr'] },
  { canonical: 'Metaphone', category: 'product', heard: ['meta phone', 'metafone', 'meta fone'] },
  { canonical: 'Levenshtein', category: 'product', heard: ['levenstein', 'leven shtine', 'levenshtine'] },
  // acronyms
  { canonical: 'SaaS', category: 'acronym', heard: ['sas', 'saas'] },
  { canonical: 'MCP', category: 'acronym', heard: ['m c p', 'em see pee', 'mcp'] },
  { canonical: 'CLI', category: 'acronym', heard: ['c l i', 'see el eye', 'cli'] },
  { canonical: 'YAML', category: 'acronym', heard: ['yammel', 'yamel', 'yam l'] },
  { canonical: 'JSON', category: 'acronym', heard: ['jason', 'jay son', 'json'] },
  { canonical: 'RLS', category: 'acronym', heard: ['r l s', 'are el ess', 'rls'] },
  { canonical: 'SSO', category: 'acronym', heard: ['s s o', 'ess ess oh', 'sso'] },
  { canonical: 'CRM', category: 'acronym', heard: ['c r m', 'see are em', 'crm'] },
  { canonical: 'ARR', category: 'acronym', heard: ['a r r', 'ay are are', 'arr'] },
  { canonical: 'MRR', category: 'acronym', heard: ['m r r', 'em are are', 'mrr'] },
  { canonical: 'GTM', category: 'acronym', heard: ['g t m', 'gee tee em', 'gtm'] },
  { canonical: 'PRD', category: 'acronym', heard: ['p r d', 'pee are dee', 'prd'] },
  { canonical: 'OKR', category: 'acronym', heard: ['o k r', 'oh kay are', 'okr'] },
  { canonical: 'KPI', category: 'acronym', heard: ['k p i', 'kay pee eye', 'kpi'] },
  { canonical: 'SDK', category: 'acronym', heard: ['s d k', 'ess dee kay', 'sdk'] },
  { canonical: 'API', category: 'acronym', heard: ['a p i', 'ay pee eye', 'api'] },
  { canonical: 'TTS', category: 'acronym', heard: ['t t s', 'tee tee ess', 'tts'] },
  { canonical: 'STT', category: 'acronym', heard: ['s t t', 'ess tee tee', 'stt'] },
  // people
  { canonical: 'Mason Wyatt', category: 'person', heard: ['mason white', 'mason wyat', 'mason why it'] },
  { canonical: 'Siobhan Reilly', category: 'person', heard: ['shivon riley', 'shavon riley', 'she von riley', 'siobhan riley'] },
  { canonical: 'Kwame Mensah', category: 'person', heard: ['kwame mensa', 'kwamay mensah', 'quame mensah'] },
  { canonical: 'Xiuying Zhao', category: 'person', heard: ['shooing zhao', 'shu ying zhao', 'shoe ying jow'] },
  { canonical: 'Bjørn Halvorsen', category: 'person', heard: ['bjorn halvorsen', 'bjorn halverson', 'byorn halvorsen'] },
  { canonical: 'Priyanka Raghunathan', category: 'person', heard: ['priyanka ragunathan', 'pre yanka raghunathan', 'priyanka raghu nathan'] },
  { canonical: 'Tadeusz Wróblewski', category: 'person', heard: ['tadeusz wroblewski', 'tadeus vroblevski', 'ta dash roblesky'] },
  // identifiers
  { canonical: 'LexiconStore', category: 'identifier', heard: ['lexicon store', 'lexicon stor', 'lexi con store'] },
  { canonical: 'normalizeTranscript', category: 'identifier', heard: ['normalize transcript', 'normalise transcript', 'normal eyes transcript'] },
  { canonical: 'UserPromptSubmit', category: 'identifier', heard: ['user prompt submit', 'user prompt summit', 'user prompts submit'] },
  { canonical: 'harvestRepo', category: 'identifier', heard: ['harvest repo', 'harvest ripo', 'harvest re po'] },
];

// ---------------------------------------------------------------------------
// Sentence templates in the founder/dev dictation register: lowercase, mostly
// unpunctuated, some run-ons. {T} is the term slot; {T}'s is a possessive slot.
// Templates must not contain any lexicon term or alias (checked below).
// ---------------------------------------------------------------------------

const TEMPLATES: Record<Exclude<BenchCategory, 'prose'>, string[]> = {
  brand: [
    'can you ping {T} about the invoice',
    'move the staging box off {T} before friday',
    'the {T} bill doubled last month can you check why',
    'spin up a new {T} project for the demo',
    'is {T} down or is it just me',
    'we should migrate the billing service to {T} this sprint',
    'add {T} to the stack slide in the pitch deck',
    "{T}'s dashboard shows zero traffic since the deploy",
    "can we get {T}'s pricing page into the comparison doc",
    'set up alerts in {T} for the checkout path',
    'does {T} support the new region yet',
    'i want to swap {T} for something cheaper honestly',
    'reply to the {T} support ticket with the logs attached',
    'our {T} usage is way over the free tier',
    'write a quick adr on why we picked {T} over the alternatives',
    'ok so the {T} integration keeps timing out on cold start',
  ],
  product: [
    'add a {T} model for the sync job',
    'the tests fail whenever {T} is upgraded',
    'pin the {T} version in the lockfile',
    "let's use {T} instead of hand rolling it",
    'why is {T} throwing on startup',
    'rewrite the {T} config so it works locally too',
    'can you add {T} to the new service',
    "{T}'s docs say this should just work",
    'the {T} layer is where the latency is coming from',
    'swap the old thing for {T} and rerun the tests',
    'um so {T} is not picking up the env file',
    'can you write a migration guide from the legacy setup to {T}',
    'i think {T} is the wrong tool here but lets try it',
    'the {T} upgrade broke the build again',
    'set {T} up on the new laptop',
    "grep the repo for anything touching {T}",
  ],
  acronym: [
    "what's our {T} looking like this quarter",
    'put the {T} numbers in the board update',
    'the {T} doc needs a section on pricing',
    'tighten the {T} policy on the users table',
    'add {T} support to the settings page',
    'the {T} is broken again after the merge',
    'regenerate the {T} from the schema',
    'wire the {T} into the onboarding flow',
    'our {T} for q3 is ambitious',
    'the {T} endpoint returns a 500 on empty payloads',
    'document the {T} flags in the readme',
    'can you draft the {T} for the voice feature',
    'the {T} spec is in the shared drive',
    "{T}'s not the metric i care about right now",
  ],
  person: [
    'ask {T} if the invoice went out',
    'loop in {T} on the design review',
    '{T} told me the demo is thursday',
    'can you schedule thirty minutes with {T} next week',
    "{T}'s pr is still waiting on review",
    'forward the contract to {T}',
    'i talked to {T} about the roadmap yesterday',
    'cc {T} on the launch announcement',
    '{T} owns the billing migration',
    'remind {T} about the offsite',
    "so {T}'s point was that we ship too slowly",
    'get {T} access to the repo',
  ],
  identifier: [
    'rename {T} so it matches the new naming scheme',
    'add a unit test for {T}',
    '{T} throws when the file is empty',
    'can you refactor {T} to take an options object',
    'move {T} into its own module',
    "{T}'s return type should be readonly",
    'why does {T} read the file twice',
    'add a doc comment to {T}',
    'the bug is somewhere in {T} i think',
  ],
};

/** Multi-term sentences. Slots are {A} {B} {C}; terms are canonicals. */
const MULTI: Array<{ template: string; terms: string[] }> = [
  { template: 'can you ping {A} about the {B} invoice', terms: ['Ashlr.AI', 'Hetzner'] },
  { template: 'add a {A} model for the {B} sync', terms: ['Pydantic', 'CRM'] },
  { template: 'deploy the {A} app to {B} and put {C} in front of it', terms: ['Next.js', 'Kubernetes', 'Nginx'] },
  { template: '{A} and {B} both want the {C} numbers before the board meeting', terms: ['Mason Wyatt', 'Siobhan Reilly', 'ARR'] },
  { template: 'switch the queue from {A} to {B} and keep {C} for caching', terms: ['Kafka', 'Upstash', 'Redis'] },
  { template: 'the {A} schema should mirror the {B} types', terms: ['Zod', 'Prisma'] },
  { template: 'run the {A} tests before you touch {B}', terms: ['Vitest', 'normalizeTranscript'] },
  { template: '{A} wants the {B} export to work with {C}', terms: ['Kwame Mensah', 'YAML', 'Wispr Flow'] },
  { template: 'scrape {A} with {B} and chart it in {C}', terms: ['Nginx', 'Prometheus', 'Grafana'] },
  { template: 'the {A} hook should call {B} not {C}', terms: ['UserPromptSubmit', 'normalizeTranscript', 'harvestRepo'] },
  { template: '{A} is fine but {B} on {C} is cheaper', terms: ['Vercel', 'Docker', 'Hetzner'] },
  { template: 'ask {A} whether {B} handles {C} tokens', terms: ['Priyanka Raghunathan', 'Supabase', 'JWT'] },
  { template: 'replace {A} with {B} in the e2e tests', terms: ['Puppeteer', 'Playwright'] },
  { template: 'get {A} talking to {B} through the {C} server', terms: ['Ollama', 'LangChain', 'MCP'] },
  { template: '{A} and {B} are on the {C} call at ten', terms: ['Xiuying Zhao', 'Tadeusz Wróblewski', 'GTM'] },
  { template: 'move the {A} tables to {B} and turn on {C}', terms: ['PostgreSQL', 'Neon', 'RLS'] },
];

/** Terms that appear already spelled correctly and must be left untouched. */
const KEEP: string[] = [
  'Kubernetes', 'Ashlr.AI', 'Mason Wyatt', 'Next.js', 'tRPC', 'Bjørn Halvorsen', 'PostgreSQL',
  'normalizeTranscript', 'OAuth', 'SaaS', 'Wispr Flow', 'Siobhan Reilly', 'GraphQL', 'Tadeusz Wróblewski',
  'Cloudflare', 'JWT',
];

// ---------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG, good enough for template selection. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function fill(template: string, slot: string, value: string): string {
  return template.split(slot).join(value);
}

function readCases(file: string): BenchCase[] {
  return readFileSync(join(HERE, 'cases', file), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as BenchCase);
}

function main(): void {
  const lexicon = parseLexicon(parseYaml(readFileSync(join(HERE, 'lexicon.yaml'), 'utf8')));
  const canonicals = new Set(lexicon.terms.map((t) => t.canonical));
  for (const spec of TERMS) {
    if (!canonicals.has(spec.canonical)) throw new Error(`gen-corpus: ${spec.canonical} is not in bench/lexicon.yaml`);
  }

  // Templates must be inert: with a neutral placeholder no replacement may fire.
  const allTemplates = [...Object.values(TEMPLATES).flat(), ...MULTI.map((m) => m.template)];
  const offenders: string[] = [];
  for (const t of allTemplates) {
    const probe = t.replace(/\{[ABCT]\}/g, 'xqzv');
    const r = normalize(probe, lexicon);
    if (r.changed) offenders.push(`  "${t}" -> "${r.output}"`);
  }
  if (offenders.length > 0) {
    throw new Error(`gen-corpus: ${offenders.length} template(s) mutate on their own:\n${offenders.join('\n')}`);
  }

  const random = rng(SEED);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const cases: BenchCase[] = [];

  // (a) one case per heard variant, template chosen deterministically.
  let n = 0;
  for (const spec of TERMS) {
    const pool = TEMPLATES[spec.category];
    // Rotate through the pool so every term sees a possessive at least sometimes
    // and no single template dominates.
    const offset = Math.floor(random() * pool.length);
    spec.heard.forEach((heard, i) => {
      const template = pool[(offset + i * 5) % pool.length];
      n++;
      const alreadyCorrect = heard === spec.canonical;
      const c: BenchCase = {
        id: `pos-${pad(n)}`,
        category: spec.category,
        heard: fill(template, '{T}', heard),
        expected: fill(template, '{T}', spec.canonical),
        terms: [spec.canonical],
      };
      if (alreadyCorrect) c.note = 'already-correct: must stay untouched';
      else if (heard.toLowerCase() === spec.canonical.toLowerCase()) c.note = 'casing-only';
      cases.push(c);
    });
  }

  // (b) multi-term sentences.
  const bySpec = new Map(TERMS.map((t) => [t.canonical, t] as const));
  MULTI.forEach((m, i) => {
    let heard = m.template;
    let expected = m.template;
    m.terms.forEach((canonical, k) => {
      const spec = bySpec.get(canonical);
      if (!spec) throw new Error(`gen-corpus: MULTI references unknown term ${canonical}`);
      const slot = `{${'ABC'[k]}}`;
      const misheard = spec.heard.filter((h) => h !== canonical);
      heard = fill(heard, slot, pick(misheard));
      expected = fill(expected, slot, canonical);
    });
    cases.push({
      id: `multi-${pad(i + 1)}`,
      category: bySpec.get(m.terms[0])!.category,
      heard,
      expected,
      terms: m.terms,
      note: `multi-term (${m.terms.length})`,
    });
  });

  // (c) already-correct canonicals inside a sentence: nothing may change.
  KEEP.forEach((canonical, i) => {
    const spec = bySpec.get(canonical);
    if (!spec) throw new Error(`gen-corpus: KEEP references unknown term ${canonical}`);
    const template = pick(TEMPLATES[spec.category]);
    const text = fill(template, '{T}', canonical);
    cases.push({
      id: `keep-${pad(i + 1)}`,
      category: spec.category,
      heard: text,
      expected: text,
      terms: [canonical],
      note: 'already-correct: must stay untouched',
    });
  });

  // (d) hand-written cases.
  cases.push(...readCases('positives.jsonl'));
  cases.push(...readCases('negatives.jsonl'));
  cases.push(...readCases('hard.jsonl'));

  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`gen-corpus: duplicate id ${c.id}`);
    ids.add(c.id);
    for (const t of c.terms) {
      if (!canonicals.has(t)) throw new Error(`gen-corpus: case ${c.id} references unknown term ${t}`);
    }
  }

  const out = cases.map((c) => JSON.stringify(c)).join('\n') + '\n';
  writeFileSync(join(HERE, 'corpus.jsonl'), out);
  const positives = cases.filter((c) => c.terms.length > 0).length;
  console.log(`wrote bench/corpus.jsonl: ${cases.length} cases (${positives} positive, ${cases.length - positives} negative)`);
}

main();
