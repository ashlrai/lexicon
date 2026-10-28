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
  /** Language family tag propagated onto generated cases (the non-English subset). */
  lang?: string;
  /**
   * Per heard-variant diagnosis for variants the current matcher is not
   * expected to recover; the generated case is marked expected-hard with the
   * note, the same convention the hand-written case files use.
   */
  hard?: Record<string, string>;
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
// Non-English names (issue #8): the measurement fixture for how an
// English-tuned double metaphone plus fuzzy does on colleague names in other
// language families. Generated as ne-NNN cases from the person templates;
// `lang` tags each case so bench/lib.ts can score the subset separately.
// Heard variants are what English STT plausibly writes for these names:
// romanizations, word-shaped splits and phoneme substitutions.
// ---------------------------------------------------------------------------

const NONENGLISH_TERMS: TermSpec[] = [
  // German
  { canonical: 'Jürgen Meyer', category: 'person', lang: 'german', heard: ['jurgen meyer', 'yurgen mayer', 'your gin meyer'], hard: { 'your gin meyer': 'three-token split of a two-token name; \'your\' is a function word so inexact windows starting there are refused' } },
  { canonical: 'Katja Schröder', category: 'person', lang: 'german', heard: ['katja schroder', 'katya shroder', 'cat ya shroder'], hard: { 'cat ya shroder': 'three-word spelling of the given name; \'cat ya\' and \'katja\' share no metaphone key' } },
  { canonical: 'Lukas Weiß', category: 'person', lang: 'german', heard: ['lucas weiss', 'lukas vice', 'lucas vice'], hard: { 'lukas vice': 'STT wrote the English word \'vice\' for the ß sibilant; \'vice\' and \'weiss\' share no key', 'lucas vice': 'STT wrote the English word \'vice\' for the ß sibilant; \'vice\' and \'weiss\' share no key' } },
  { canonical: 'Götz Neumann', category: 'person', lang: 'german', heard: ['goetz neumann', 'gerts noiman', 'guts newman'], hard: { 'gerts noiman': 'the umlaut vowel pushed STT to \'gerts\'; \'gerts\' and \'goetz\' share no key' } },
  { canonical: 'Anke Bräutigam', category: 'person', lang: 'german', heard: ['anke brautigam', 'anka broytigam', 'anchor broytee gam'], hard: { 'anchor broytee gam': 'four tokens for a two-token name; the window never spans that many words' } },
  { canonical: 'Bärbel Hoffmann', category: 'person', lang: 'german', heard: ['barbel hoffmann', 'bear bell hoffman', 'barbell hoffman'] },
  { canonical: 'Friedrich Vogel', category: 'person', lang: 'german', heard: ['friedrich fogle', 'freed rich fogel', 'frederick vogel'], hard: { 'frederick vogel': 'anglicized \'frederick\' for \'friedrich\'; past the fuzzy floor and no shared key' } },
  // Spanish
  { canonical: 'José García', category: 'person', lang: 'spanish', heard: ['jose garcia', 'hose garcia', 'jose garsia'] },
  { canonical: 'Joaquín Fernández', category: 'person', lang: 'spanish', heard: ['joaquin fernandez', 'wa keen fernandez', 'wah keen fern and es'], hard: { 'wa keen fernandez': 'Spanish \'joa\' written as English \'wa keen\'; no shared key', 'wah keen fern and es': 'four-token split with the function word \'and\' inside the surname' } },
  { canonical: 'Guillermo Ortega', category: 'person', lang: 'spanish', heard: ['gillermo ortega', 'gear mo ortega', 'wee yermo ortega'], hard: { 'gear mo ortega': 'Spanish \'gui\' written as the English word \'gear\'; \'gear mo\' and \'guillermo\' share no key', 'wee yermo ortega': 'Spanish \'gue\' written \'wee ye\'; \'wee yermo\' and \'guillermo\' share no key' } },
  { canonical: 'Ximena Navarro', category: 'person', lang: 'spanish', heard: ['jimena navarro', 'he mena navarro', 'zimena navarro'], hard: { 'he mena navarro': 'STT split \'xi\' into the word \'he\'; the name is recovered but the leftover \'he\' fails the sentence' } },
  { canonical: 'Iñaki Mendoza', category: 'person', lang: 'spanish', heard: ['inaki mendoza', 'inyaki mendoza', 'e naki mendoza'] },
  { canonical: 'Rafael Muñoz', category: 'person', lang: 'spanish', heard: ['rafael munoz', 'rafael munez', 'raphael munoz'] },
  { canonical: 'Rodrigo Villalobos', category: 'person', lang: 'spanish', heard: ['rodrigo villalobos', 'rodrigo villa lobos', 'rod rigo via lobos'], hard: { 'rod rigo via lobos': 'four tokens for a two-token name; the window never spans that many words' } },
  // Polish
  { canonical: 'Szymon Kowalski', category: 'person', lang: 'polish', heard: ['shimon kowalski', 'simon kovalski', 'shy mon kowalski'] },
  { canonical: 'Wojciech Zieliński', category: 'person', lang: 'polish', heard: ['wojciech zielinski', 'voy tech zielinski', 'voycek zielinski'], hard: { 'voy tech zielinski': 'Polish \'wojciech\' written as English \'voy tech\'; \'voy\' shares no key', 'voycek zielinski': 'the English ear writes \'voycek\' for \'wojciech\'; the metaphone keys disagree' } },
  { canonical: 'Łukasz Nowak', category: 'person', lang: 'polish', heard: ['lukasz nowak', 'wukash novak', 'lucas novak'], hard: { 'wukash novak': 'Polish ł -> w and sz -> sh; \'wukash\' and \'lukasz\' share no key', 'lucas novak': 'anglicized both tokens (\'lucas\', \'novak\'); each is near fuzzy range but the pair is below the floor' } },
  { canonical: 'Grzegorz Brzęczyszczykiewicz', category: 'person', lang: 'polish', heard: ['grzegorz brzeczyszczykiewicz', 'gregors shes kovitch', 'gregory brzezinski'], hard: { 'gregors shes kovitch': 'three-word approximation of a nine-syllable name; no shared key and past the fuzzy floor', 'gregory brzezinski': 'STT substituted a different Polish surname; \'brzezinski\' and \'brzeczyszczykiewicz\' are too far for fuzzy' } },
  { canonical: 'Katarzyna Wiśniewska', category: 'person', lang: 'polish', heard: ['katarzyna wisniewska', 'katarzina vishnevska', 'catalina wish nevsky'], hard: { 'katarzina vishnevska': 'Polish ś written \'sh\' gives \'vishnevska\'; it and \'wisniewska\' share no key', 'catalina wish nevsky': 'STT anglicized the given name too (\'catalina\'); both tokens miss the keys' } },
  { canonical: 'Mikołaj Zielonka', category: 'person', lang: 'polish', heard: ['mikolaj zielonka', 'mikoy zelonka', 'nicolai zelonka'], hard: { 'mikoy zelonka': 'Polish ł lands as \'y\' in the English ear; \'mikoy\' and \'mikolaj\' share no key', 'nicolai zelonka': 'anglicized \'nicolai\' for \'mikolaj\'; no shared key' } },
  { canonical: 'Agnieszka Szczepańska', category: 'person', lang: 'polish', heard: ['agnieszka szczepanska', 'agnieska shepanska', 'agnes che panska'], hard: { 'agnieska shepanska': 'szcz written \'shp\' gives \'shepanska\'; it and \'szczepanska\' share no key', 'agnes che panska': 'three-token split plus anglicized \'agnes\'; no shared key' } },
  // Japanese (romaji)
  { canonical: 'Yuki Tanaka', category: 'person', lang: 'japanese', heard: ['yuki tanaka', 'you key tanaka', 'yookie tanaka'], hard: { 'you key tanaka': 'STT spells the syllables as English words \'you key\'; the window starts on a function word' } },
  { canonical: 'Rin Takahashi', category: 'person', lang: 'japanese', heard: ['rin takahashi', 'wren takahashi', 'rin taka hashi'] },
  { canonical: 'Satoshi Nakamura', category: 'person', lang: 'japanese', heard: ['satoshi nakamura', 'sato shi nakamura', 'sa toshee nakamura'] },
  { canonical: 'Naoki Kobayashi', category: 'person', lang: 'japanese', heard: ['naoki kobayashi', 'now key kobayashi', 'nah oki koba yashi'], hard: { 'now key kobayashi': 'STT spells \'nao\' as the English word \'now\'; the window starts on a function word', 'nah oki koba yashi': 'four tokens for a two-token name' } },
  { canonical: 'Keisuke Yamaguchi', category: 'person', lang: 'japanese', heard: ['keisuke yamaguchi', 'kay suke yamaguchi', 'case kay yamaguchi'] },
  { canonical: 'Miyuki Tsukamoto', category: 'person', lang: 'japanese', heard: ['miyuki tsukamoto', 'mi yuki sukamoto', 'me yuki tsuka moto'], hard: { 'mi yuki sukamoto': 'the ts- onset is written \'s\'; \'sukamoto\' and \'tsukamoto\' share no key', 'me yuki tsuka moto': 'four tokens for a two-token name' } },
  { canonical: 'Ryota Miyazaki', category: 'person', lang: 'japanese', heard: ['ryota miyazaki', 'rio ta miyazaki', 'ryo tah mia zaki'] },
  // Arabic (transliteration)
  { canonical: 'Mohammed Al-Rashid', category: 'person', lang: 'arabic', heard: ['muhammad al rashid', 'mohammed al rasheed', 'mohamed al rasheed'] },
  { canonical: 'Fatima Zahra', category: 'person', lang: 'arabic', heard: ['fatima zahra', 'fatima zara', 'fatema zahra'] },
  { canonical: 'Khalid Nasser', category: 'person', lang: 'arabic', heard: ['khaled nasser', 'khalid naser', 'called nasser'] },
  { canonical: 'Aisha Bakr', category: 'person', lang: 'arabic', heard: ['aisha bakr', 'aisha bakker', 'asia bakr'], hard: { 'asia bakr': '\'asia\' is an English word for \'aisha\'; the window falls below the fuzzy floor' } },
  { canonical: 'Zainab Qureshi', category: 'person', lang: 'arabic', heard: ['zaynab qureshi', 'zainab koreshi', 'zane ab koreshi'] },
  { canonical: 'Omar Farouk', category: 'person', lang: 'arabic', heard: ['omar farooq', 'omar faruk', 'oh mar farouk'] },
  { canonical: 'Abdulrahman Haddad', category: 'person', lang: 'arabic', heard: ['abdulrahman haddad', 'abdul rahman haddad', 'abdul rock man haddad'], hard: { 'abdul rock man haddad': '\'rock man\' inserts a word inside \'rahman\'; the window never spans four tokens' } },
  // Nordic
  { canonical: 'Åsa Lindqvist', category: 'person', lang: 'nordic', heard: ['asa lindqvist', 'oh sa lindqvist', 'osa lindkvist'] },
  { canonical: 'Søren Kjær', category: 'person', lang: 'nordic', heard: ['soren kjaer', 'sorin care', 'soren chair'], hard: { 'soren chair': '\'kjær\' written as the English word \'chair\' shares no key' } },
  { canonical: 'Kåre Strøm', category: 'person', lang: 'nordic', heard: ['kare strom', 'kore strom', 'core a strum'] },
  { canonical: 'Øystein Aas', category: 'person', lang: 'nordic', heard: ['oystein aas', 'oy stein oss', 'oi stein os'] },
  { canonical: 'Päivi Mäkinen', category: 'person', lang: 'nordic', heard: ['paivi makinen', 'pavi makkinen', 'pie vee makinen'] },
  { canonical: 'Guðrún Sigurðardóttir', category: 'person', lang: 'nordic', heard: ['gudrun sigurdardottir', 'guthrun sigurthardottir', 'good run sigurdar daughter'] },
  { canonical: 'Eero Saarinen', category: 'person', lang: 'nordic', heard: ['eero sarinen', 'ero saarinen', 'arrow saarinen'] },
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
  // Already-correct non-English spellings, diacritics and all: the matcher may
  // not "help" them toward a different term.
  'José García', 'Søren Kjær', 'Yuki Tanaka', 'Mohammed Al-Rashid', 'Wojciech Zieliński',
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
  for (const spec of [...TERMS, ...NONENGLISH_TERMS]) {
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
  const bySpec = new Map([...TERMS, ...NONENGLISH_TERMS].map((t) => [t.canonical, t] as const));
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
      ...(spec.lang !== undefined ? { lang: spec.lang } : {}),
    });
  });

  // (d) non-English names. Runs after (a)-(c) so the rng draws that placed the
  // existing cases are unchanged; ne- ids keep the subset greppable even
  // without the lang tag.
  let ne = 0;
  for (const spec of NONENGLISH_TERMS) {
    const pool = TEMPLATES[spec.category];
    const offset = Math.floor(random() * pool.length);
    spec.heard.forEach((heard, i) => {
      const template = pool[(offset + i * 5) % pool.length];
      ne++;
      const c: BenchCase = {
        id: `ne-${pad(ne)}`,
        category: spec.category,
        heard: fill(template, '{T}', heard),
        expected: fill(template, '{T}', spec.canonical),
        terms: [spec.canonical],
        lang: spec.lang,
      };
      if (heard.toLowerCase() === spec.canonical.toLowerCase()) c.note = 'casing-only';
      const why = spec.hard?.[heard];
      if (why) c.note = `expected-hard: ${why}`;
      cases.push(c);
    });
  }

  // (e) hand-written cases.
  cases.push(...readCases('positives.jsonl'));
  cases.push(...readCases('negatives.jsonl'));
  cases.push(...readCases('hard.jsonl'));
  cases.push(...readCases('nonenglish.jsonl'));

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
