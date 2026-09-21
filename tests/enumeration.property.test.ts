/**
 * The quoting guard, tested by property rather than by example.
 *
 * `src/core/matcher/enumeration.ts` decides whether a passage is *quoting* two
 * spellings (leave it alone) or *dictating* one word twice (fix both).
 *
 * The version of this file it replaces generated its phrasings from the guard's
 * own vocabulary: a reviewer counted 54 of 56 connectives and 12 of 14 lead
 * templates built entirely out of words the guard already knew. A generator
 * assembled from the list under test cannot find a hole in that list; it proves
 * the vocabulary matches itself and nothing more. Every sentence it could
 * produce was, by construction, one the guard was going to accept.
 *
 * So the phrasings here are sourced from English instead, on the axes the guard
 * has no opinion about at all:
 *
 *   MODALITY    is / can be / may be / might be / will be / has to be / ...
 *   FREQUENCY   often / usually / sometimes / commonly / always / ...
 *   SUBORDINATION   , which ... / , but ... / because ... / although ...
 *   NAMING      the one topical axis: the verb that names writing a word down,
 *               deliberately including ordinary verbs (garbled, mangled,
 *               mistaken, autocorrected) that the guard does not know and that
 *               nobody should add to it to make this file pass.
 *
 * `it('draws its phrasings from outside the guard')` holds that open: a fixed
 * share of the generated connectives must contain a word the guard's vocabulary
 * does not have. Widening the vocabulary to silence a failure here makes that
 * assertion fail instead, which is the whole point.
 *
 * ## Two tiers, because the guard is two different things
 *
 * A vocabulary test cannot be complete, and a generator that is honestly
 * independent of the vocabulary will always find prose it does not cover. So
 * the QUOTING direction is split by what evidence the passage carries:
 *
 *   MARKED   the passage carries a signal that needs no vocabulary at all: the
 *            mention is tight-quoted ("Ashler", 'Ashler', `Ashler`), or it is a
 *            table cell, a list item, an arrow or a colon definition. These are
 *            asserted. Zero failures, always.
 *   PROSE    free sentences about spelling, where the guard is admittedly a
 *            word list. These are *measured* against a ceiling that may only go
 *            down. A regression raises the number and fails; tuning the list
 *            lowers it and the ceiling has to be lowered with it, in the open.
 *
 * DICTATION is asserted in full, in both the with-canonical and the control
 * direction. Declining everything fails it; correcting everything fails MARKED.
 *
 * ## The floors are real floors
 *
 * `checked` counts cases the matcher was actually consulted about. Visibility
 * comes from running `findReplacements` over the control text - the same text
 * with the canonical swapped out, where the guard's precondition cannot hold -
 * and asking which garbles it proposed to rewrite. The predecessor computed it
 * from a regex over the input instead, so stubbing `findReplacements` to return
 * `[]` left every floor and the whole QUOTING direction passing. It does not
 * now: a blinded matcher reports zero visible garbles and the floors fail.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { buildIndex, findReplacements } from '../src/core/matcher.js';
import type { MatcherIndex } from '../src/core/matcher.js';
import { GUARD_VOCABULARY } from '../src/core/matcher/enumeration.js';
import { parseLexicon } from '../src/core/schema.js';
import type { Lexicon, Replacement, Term } from '../src/core/types.js';

function lex(terms: Term[]): Lexicon {
  return { version: 1, terms };
}

function apply(text: string, reps: Replacement[]): string {
  let out = text;
  for (let i = reps.length - 1; i >= 0; i--) out = out.slice(0, reps[i].start) + reps[i].replacement + out.slice(reps[i].end);
  return out;
}

function fold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Word-bounded containment. A plain substring test would report "Mason Wyat" as
 * surviving inside the corrected "Mason Wyatt", which is the opposite of true.
 */
function has(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/** The canonical counts as present in any spelling that folds to it: "ashlr.ai", "Ashlr AI". */
function hasCanonical(haystack: string, canonical: string): boolean {
  return fold(haystack).includes(fold(canonical));
}

interface Subject {
  readonly name: string;
  readonly term: Term;
  /** Spellings of the canonical that a human would write, all folding to it. */
  readonly canonicals: readonly string[];
  /** Garbles the recognizer produces. */
  readonly aliases: readonly string[];
  /** An unrelated word of the same token shape, used for the control. */
  readonly neutral: string;
}

const SUBJECTS: readonly Subject[] = [
  {
    name: 'Ashlr.AI',
    term: { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashler AI'] },
    canonicals: ['Ashlr.AI', 'ashlr.ai', 'Ashlr AI'],
    aliases: ['Ashler', 'Ashlar', 'ashler'],
    neutral: 'Vercel',
  },
  {
    name: 'Kubernetes',
    term: { canonical: 'Kubernetes', aliases: [] },
    canonicals: ['Kubernetes', 'kubernetes'],
    aliases: ['cooper netties', 'Cooper Netties', 'kubernets'],
    neutral: 'Terraform',
  },
  {
    name: 'Redis',
    term: { canonical: 'Redis', aliases: ['reddis', 'red iss'] },
    canonicals: ['Redis', 'redis'],
    aliases: ['reddis', 'red iss', 'Reddis'],
    neutral: 'Postgres',
  },
  {
    name: 'Mason Wyatt',
    term: { canonical: 'Mason Wyatt', aliases: ['Mason Wyat', 'mason white'], category: 'person' },
    canonicals: ['Mason Wyatt', 'mason wyatt'],
    aliases: ['Mason Wyat', 'Mason Wiatt', 'mason white'],
    neutral: 'Dana Fletcher',
  },
];

// ---------------------------------------------------------------------------
// The generator's own English. None of this is read off the guard.
// ---------------------------------------------------------------------------

/**
 * Modality. A genuinely closed class of English - the modal auxiliaries and the
 * handful of semi-modals - and the axis that decides whether a sentence about a
 * spelling is a report or a possibility. The guard's vocabulary contained two
 * of these when this file was written, which is why "Ashlr.AI can come out as
 * Ashler" was being flattened and nothing in the suite noticed.
 */
const MODALITY: readonly string[] = [
  'is',
  'can be',
  'could be',
  'may be',
  'might be',
  'will be',
  'would be',
  'should be',
  'must be',
  'has to be',
  'needs to be',
  'tends to be',
  'used to be',
  'keeps being',
  'ends up',
  'gets',
  'winds up',
];

/**
 * Frequency. Another small closed set, and the other half of what a person
 * writes when they describe what a recognizer does to a name: it does not do it
 * once, it does it often.
 */
const FREQUENCY: readonly string[] = [
  '',
  'often ',
  'usually ',
  'sometimes ',
  'commonly ',
  'frequently ',
  'always ',
  'occasionally ',
  'typically ',
  'normally ',
  'still ',
  'nearly always ',
];

/**
 * The one topical axis: past participles for putting a name on paper wrong.
 * A third of these are outside the guard's vocabulary on purpose and must stay
 * that way - see the independence assertion. They are what a person writes, not
 * what a word list was tuned to.
 */
const PARTICIPLES: readonly string[] = [
  'spelled',
  'written',
  'typed',
  'heard',
  'transcribed',
  'rendered',
  'misspelled',
  'mistyped',
  'read',
  'garbled',
  'mangled',
  'shortened',
  'abbreviated',
  'autocorrected',
  'mistaken',
];

/** The participles that read grammatically without a following "as". */
const PLAIN_PARTICIPLES: readonly string[] = ['spelled', 'written', 'typed', 'read', 'misspelled', 'mistyped'];

/** The same act in the active voice, which is how people describe a recognizer. */
const ACTIVE: readonly string[] = [
  'writes',
  'types',
  'spells',
  'hears',
  'reads',
  'renders',
  'transcribes',
  'garbles',
  'mangles',
  'shortens',
  'autocorrects',
  'mistakes',
];

/**
 * Sentence frames. `{m}` takes a modality, `{f}` a frequency, `{p}` a
 * participle, `{q}` one of the participles that stands without "as", `{v}` an
 * active verb. Subordination and coordination are here because they are how
 * people actually join a canonical to its garble, and because the guard has
 * never had an opinion about `which`, `but`, `because` or `although`.
 */
const FRAMES: readonly string[] = [
  ' {m} {f}{p} as ',
  ' {m} {f}{q} ',
  ' {m} not {f}{p} as ',
  ', which {m} {f}{p} as ',
  ', which the recognizer {f}{v} as ',
  ', but the recognizer {f}{v} ',
  ' because the recognizer {f}{v} ',
  ', although the recognizer {f}{v} ',
  ' and never ',
  ', never ',
  ', not to be confused with ',
  ', and definitely not ',
];

/**
 * Connectives, assembled rather than listed. The four strides are coprime with
 * their axis lengths, so every modal, every frequency adverb and every verb
 * appears many times over and in varying company, and the set is fully
 * determined by the axes above rather than by anybody's judgement about which
 * phrasings matter.
 */
function buildConnectives(count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < count && i < count * 8; i++) {
    const connective = FRAMES[i % FRAMES.length]
      .replace('{m}', MODALITY[(i * 5) % MODALITY.length])
      .replace('{f}', FREQUENCY[(i * 7) % FREQUENCY.length])
      .replace('{p}', PARTICIPLES[(i * 11) % PARTICIPLES.length])
      .replace('{q}', PLAIN_PARTICIPLES[(i * 5) % PLAIN_PARTICIPLES.length])
      .replace('{v}', ACTIVE[(i * 7) % ACTIVE.length])
      .replace(/\s+/g, ' ');
    if (seen.has(connective)) continue;
    seen.add(connective);
    out.push(connective);
  }
  return out;
}

const CONNECTIVES: readonly string[] = buildConnectives(216);

/** Notation, which carries its own evidence and needs no words at all. */
const NOTATION: readonly string[] = [' -> ', ' => ', ' → ', ' = ', ' == ', ': ', ' / ', ' | ', '; '];

/**
 * Sentence-initial phrasings, where the evidence leads instead of sitting
 * between. Built on the same independent axes: the opener is an ordinary
 * English verb or label and the modality rides behind it.
 */
const LEAD_OPENERS: readonly string[] = [
  'not',
  'Not',
  'Never',
  'Replace',
  'Replaced',
  'Swap',
  'Correct',
  'Change',
  'Rewrite',
  'Expand',
  'Add',
  'Alias',
  'Spelling:',
  'Canonical:',
  'Misspelling:',
];

/** What sits between the two mentions in a lead phrasing. Prepositions, not vocabulary. */
const LEAD_JOINS: readonly string[] = [' with ', ' to ', ' for ', ' as ', ', ', ' into ', ' and not '];

function buildLeadTemplates(): string[] {
  const out: string[] = [];
  for (let i = 0; i < LEAD_OPENERS.length; i++) {
    const opener = LEAD_OPENERS[i];
    const join = LEAD_JOINS[(i * 3) % LEAD_JOINS.length];
    out.push(`${opener} {A}${join}{C}`);
    out.push(`${opener} {C}${join}{A}`);
  }
  out.push('Canonical: {C}, alias: {A}');
  out.push('canonical {C} alias {A}');
  out.push('Two spellings, {C} and {A}, same company');
  out.push('Two spellings of one name: {C} and {A}');
  return out;
}

const LEAD_TEMPLATES: readonly string[] = buildLeadTemplates();

/**
 * Shapes that carry two garbles at once: tables, lists, YAML, multi-line blocks
 * and the README pattern of a canonical, a blank line, and then the garbles.
 * Every one of these is structural, so every one of them is MARKED.
 */
const SHAPE_TEMPLATES: readonly string[] = [
  '| {C} | {A}, {B} | brand |',
  '| {C} | {A} | brand |',
  'Aliases for {C}: {A}, {B}',
  '{C} has 1. {A} 2. {B} as variants.',
  'Aliases for {C}:\n- {A}\n- {B}',
  'canonical: {C}\naliases:\n  - {A}\n  - {B}',
  '| canonical | alias |\n| --- | --- |\n| {C} | {A} |\n| {C} | {B} |',
  '- {A} -> {C}\n- {B} -> {C}',
  '1. {C}\n2. {A}\n3. {B}',
  '{C}\n  {A}\n  {B}',
  'Lexicon\n\n{C} = {A}\n{C} = {B}',
  // The blank-line README shape. The canonical is a heading of its own and the
  // garbles are a paragraph below it, so there is no anchor inside the block.
  'Canonical: {C}\n\nMisspellings: {A}, {B}',
  '# {C}\n\nMisspellings: {A}, {B}',
  '{C}\n\nHeard as: {A}, {B}',
  '## Spellings\n\nCanonical: {C}\n\nGarbles:\n- {A}\n- {B}',
];

/** Ways the pair sits inside ordinary text. */
const WRAPS: ReadonlyArray<(s: string) => string> = [
  (s) => s,
  (s) => `${s}.`,
  (s) => `${s}!`,
  (s) => `Quick note, ${s}, thanks.`,
  (s) => `Heads up: ${s}. Please update the docs.`,
  (s) => `In the README we say ${s} everywhere.`,
  (s) => `The transcript shows ${s} again, since 2024. Ship it.`,
  (s) => `- ${s}`,
  (s) => `1. ${s}`,
];

/**
 * Punctuation a writer puts around a spelling. The quoting ones are the
 * use-mention convention of written English, which is evidence in itself and
 * needs no vocabulary; parentheses are not, so they stay in the PROSE tier.
 */
const TIGHT_QUOTERS: ReadonlyArray<(s: string) => string> = [
  (s) => `"${s}"`,
  (s) => `'${s}'`,
  (s) => `\`${s}\``,
  (s) => `“${s}”`,
];
const LOOSE_QUOTERS: ReadonlyArray<(s: string) => string> = [(s) => s, (s) => `(${s})`];

/**
 * Ordinary dictation: one word said twice, joined by language about the world.
 * Three groups. The first is the witnesses from earlier reviews. The second is
 * imperatives - `Fix {C} on the {A} box` - which the guard declines because a
 * lead needs only a marker before the first mention and glue after it; the
 * predecessor's list had no imperative opener in it, which is why the suite
 * could not see that. The third carries the same modality and frequency the
 * quoting frames do, so widening the guard to accept "can be spelled" cannot
 * quietly buy itself "can be rebooted".
 */
const DICTATION_TEMPLATES: readonly string[] = [
  'I heard {A} went down but {C} is fine',
  'We wrote {A} scripts for the {C} migration',
  '{C} is not caching, the {A} box is down',
  '{C} is down and that means {A} is too',
  'Not {A} again, the {C} cluster is flaky',
  'The {C} upgrade becomes {A} work next week',
  '{C} is fine but the canonical {A} docs are not',
  'That sounds like the {C} issue, {A} keeps crashing',
  'Add a shell alias so {C} and {A} both resolve',
  'Fix the anti-aliasing before {C} and {A} ship',
  'The typography on the {C} page and the {A} page differ',
  'Check the spelling on the {C} and {A} pages',
  'I pushed to {C}, {A} went down',
  'Ping {C}, {A} is on call tonight',
  'We moved {C} to the new cluster and {A} followed',
  'The {C} dashboard and the {A} dashboard disagree',
  'After {C} restarted, {A} started dropping writes',
  'Everyone on the {C} team says {A} is slow',
  '{C} went down at noon and {A} went down at two',
  'I told the {C} folks that {A} needs more memory',
  'The {A} outage hit {C} customers hard',
  'Between {C} and {A} we lost an hour',
  '{C} costs more than {A} does per month',
  'We use {A} every day',
  'The {A} cluster is down',
  '{C} is fine.\n{A} is not.',
  'Standup notes\n\n{C} shipped on time\n{A} needs another week',
  // Imperatives. A marker opens each one and nothing but glue reaches the
  // second mention, which is the whole of what the lead rule asks for.
  'Fix {C} on the {A} box',
  'Show {C} in the {A} output',
  'Type {C} into the {A} field',
  'Keep {C} out of the {A} cluster',
  'List {C} before the {A} rollout',
  'Write {C} on the {A} form',
  'Print {C} from the {A} host',
  'Map {C} onto the {A} shard',
  'Correct {C} on the {A} invoice',
  'Replace {C} in the {A} config',
  'Swap {C} for the {A} node tomorrow',
  'Change {C} to the {A} plan next quarter',
  // Modality and frequency, carrying ordinary predicates about the world.
  '{C} can be slow when {A} is busy',
  '{C} will always be cheaper than {A}',
  '{C} often goes down before {A} does',
  '{C} might need more memory than {A}',
  '{C} usually restarts faster than the {A} box',
  'We should move {C} and {A} to the new rack',
  '{C} must be upgraded because {A} is failing',
  '{C} is down, which means {A} is next',
  '{C} tends to be noisier than {A} under load',
  '{C} has to be drained before {A} reboots',
  '{C} ends up paging whoever owns {A}',
  '{C} keeps being slower than {A} on Fridays',
];

type Tier = 'marked' | 'prose';

interface Case {
  readonly text: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly canonical: string;
  readonly subject: Subject;
  readonly tier: Tier;
}

function fill(template: string, c: string, a: string, b: string): string {
  return template.split('{C}').join(c).split('{A}').join(a).split('{B}').join(b);
}

const INDEXES = new Map<string, MatcherIndex>();
function indexFor(subject: Subject): MatcherIndex {
  let index = INDEXES.get(subject.name);
  if (!index) {
    index = buildIndex(lex([subject.term]));
    INDEXES.set(subject.name, index);
  }
  return index;
}

/**
 * What the matcher can actually see, asked of the matcher.
 *
 * The probe is the case with the canonical swapped for an unrelated word, which
 * is the one text where the guard's precondition provably cannot hold, so what
 * comes back is the matcher's opinion alone. A case the matcher proposes
 * nothing for is not evidence about the guard either way and is skipped; a
 * matcher that proposes nothing for anything skips everything, and the coverage
 * floors below turn that into a failure instead of a green run.
 */
interface Probe {
  readonly text: string;
  readonly out: string;
  readonly visible: readonly string[];
}

function probe(text: string, canonical: string, subject: Subject, aliases: readonly string[]): Probe {
  const probed = text.split(canonical).join(subject.neutral);
  const reps = findReplacements(probed, indexFor(subject));
  const proposed = new Set(reps.map((r) => fold(r.original)));
  return { text: probed, out: apply(probed, reps), visible: aliases.filter((a) => proposed.has(fold(a))) };
}

function makeCase(text: string, label: string, tier: Tier, canonical: string, subject: Subject, aliases: readonly string[]): Case {
  return { text, label, tier, canonical, subject, aliases: probe(text, canonical, subject, aliases).visible };
}

function buildQuotingCases(): Case[] {
  const cases: Case[] = [];
  for (const subject of SUBJECTS) {
    const [alias, alias2] = subject.aliases;
    for (const canonical of subject.canonicals) {
      for (let i = 0; i < CONNECTIVES.length; i++) {
        const connective = CONNECTIVES[i];
        for (const wrap of WRAPS) {
          // Unquoted and parenthesised: prose, where the guard is a word list.
          for (const quoter of LOOSE_QUOTERS) {
            const c = quoter(canonical);
            const a = quoter(alias);
            for (const [order, text] of [
              ['C-first', wrap(`${c}${connective}${a}`)],
              ['A-first', wrap(`${a}${connective}${c}`)],
            ] as const) {
              cases.push(makeCase(text, `prose ${order} ${JSON.stringify(connective)}`, 'prose', canonical, subject, [alias]));
            }
          }
          // Tight-quoted: the use-mention convention, which is structural.
          const quoter = TIGHT_QUOTERS[i % TIGHT_QUOTERS.length];
          const qc = quoter(canonical);
          const qa = quoter(alias);
          for (const [order, text] of [
            ['C-first', wrap(`${qc}${connective}${qa}`)],
            ['A-first', wrap(`${qa}${connective}${qc}`)],
          ] as const) {
            cases.push(makeCase(text, `quoted ${order} ${JSON.stringify(connective)}`, 'marked', canonical, subject, [alias]));
          }
        }
      }
      for (const notation of NOTATION) {
        for (const wrap of WRAPS) {
          for (const [order, text] of [
            ['C-first', wrap(`${canonical}${notation}${alias}`)],
            ['A-first', wrap(`${alias}${notation}${canonical}`)],
          ] as const) {
            cases.push(makeCase(text, `notation ${order} ${JSON.stringify(notation)}`, 'marked', canonical, subject, [alias]));
          }
        }
      }
      for (const template of LEAD_TEMPLATES) {
        const text = fill(template, canonical, alias, alias2);
        cases.push(makeCase(text, `lead ${JSON.stringify(template)}`, 'prose', canonical, subject, [alias]));
      }
      for (const template of SHAPE_TEMPLATES) {
        const text = fill(template, canonical, alias, alias2);
        cases.push(makeCase(text, `shape ${JSON.stringify(template)}`, 'marked', canonical, subject, [alias, alias2]));
      }
    }
  }
  return cases;
}

function buildDictationCases(): Case[] {
  const cases: Case[] = [];
  for (const subject of SUBJECTS) {
    const [alias, alias2] = subject.aliases;
    for (const canonical of subject.canonicals) {
      for (const template of DICTATION_TEMPLATES) {
        const text = fill(template, canonical, alias, alias2);
        cases.push(makeCase(text, `prose ${JSON.stringify(template)}`, 'prose', canonical, subject, [alias]));
      }
    }
  }
  return cases;
}

interface Report {
  readonly checked: number;
  readonly skipped: number;
  readonly failures: string[];
}

function rewrite(text: string, subject: Subject): string {
  return apply(text, findReplacements(text, indexFor(subject)));
}

function run(cases: readonly Case[], direction: 'quoting' | 'dictation'): Report {
  const failures: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.aliases.length === 0) {
      skipped++;
      continue;
    }
    checked++;
    const out = rewrite(c.text, c.subject);
    if (direction === 'quoting') {
      const lost = c.aliases.filter((a) => !has(out, a));
      if (lost.length > 0) failures.push(`[${c.label}] flattened ${JSON.stringify(lost)}: ${JSON.stringify(c.text)} -> ${JSON.stringify(out)}`);
      else if (!hasCanonical(out, c.subject.term.canonical))
        failures.push(`[${c.label}] lost the canonical: ${JSON.stringify(c.text)} -> ${JSON.stringify(out)}`);
    } else {
      const left = c.aliases.filter((a) => has(out, a));
      if (left.length > 0) failures.push(`[${c.label}] refused ${JSON.stringify(left)}: ${JSON.stringify(c.text)} -> ${JSON.stringify(out)}`);
    }
  }
  return { checked, skipped, failures };
}

/** The controls are themselves dictation: canonical absent, so every garble must go. */
function runControls(cases: readonly Case[]): Report {
  const failures: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const c of cases) {
    if (c.aliases.length === 0) {
      skipped++;
      continue;
    }
    const p = probe(c.text, c.canonical, c.subject, c.aliases);
    if (p.text === c.text) {
      skipped++;
      continue;
    }
    checked++;
    const left = c.aliases.filter((a) => has(p.out, a));
    if (left.length > 0) failures.push(`[control ${c.label}] refused ${JSON.stringify(left)}: ${JSON.stringify(p.text)} -> ${JSON.stringify(p.out)}`);
  }
  return { checked, skipped, failures };
}

/**
 * One line per distinct template, with a count and one example. The cross
 * product runs to tens of thousands of strings; a flat list of them says
 * nothing, and the template is the thing that is actually right or wrong.
 */
function describeFailures(name: string, report: Report): string {
  const byLabel = new Map<string, { count: number; example: string }>();
  for (const f of report.failures) {
    const label = f.slice(0, f.indexOf(']') + 1);
    const seen = byLabel.get(label);
    if (seen) seen.count++;
    else byLabel.set(label, { count: 1, example: f.slice(label.length).trim() });
  }
  const lines = [...byLabel.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 40)
    .map(([label, { count, example }]) => `${label} x${count}  ${example}`);
  return (
    `${name}: ${report.failures.length} of ${report.checked} generated cases failed across ${byLabel.size} templates ` +
    `(${report.skipped} skipped as invisible to the matcher).\n  ${lines.join('\n  ')}` +
    `${byLabel.size > 40 ? `\n  ... and ${byLabel.size - 40} more templates` : ''}`
  );
}

function summarize(name: string, report: Report): void {
  if (report.failures.length === 0) {
    expect(report.failures).toEqual([]);
    return;
  }
  throw new Error(describeFailures(name, report));
}

/**
 * The PROSE ceiling, and the headline number of this whole file.
 *
 * 41.5% of the free sentences generated above are still flattened. They are not
 * exotic: "Ashlr.AI can be garbled as Ashler", "Ashlr.AI, not to be confused
 * with Ashler", "Ashlr.AI, but the recognizer nearly always mistakes Ashler".
 * The guard misses them because `garbled`, `confused`, `mistakes`, `mistyped`,
 * `reads`, `mangles` and `autocorrects` are not in its 228-word vocabulary, and
 * they never will all be there - that is what an open word class means.
 *
 * So this is a recorded measurement with a ratchet, not a target. It may be
 * lowered; raising it means a regression was accepted and the commit that does
 * it has to say so. Do not lower it by adding the missing words: the
 * independence assertion above is calibrated against the same vocabulary and
 * will fail if you do. The MARKED tier is where zero failures are demanded,
 * because that is the tier whose evidence does not depend on a word list.
 */
const PROSE_CEILING = 0.42;

describe('quoting guard, generated round trips', () => {
  const quoting = buildQuotingCases();
  const dictation = buildDictationCases();
  const marked = quoting.filter((c) => c.tier === 'marked');
  const prose = quoting.filter((c) => c.tier === 'prose');

  it('draws its phrasings from outside the guard', () => {
    // The defect this file was rewritten to fix: 54 of the predecessor's 56
    // connectives were built entirely from the guard's own vocabulary, so the
    // suite could only ever confirm that the list agreed with itself. A fixed
    // share of these has to contain a word the guard does not know, and the way
    // to keep this passing is to leave the vocabulary alone.
    const foreign = CONNECTIVES.filter((c) =>
      c
        .toLowerCase()
        .split(/[^\p{L}]+/u)
        .filter((w) => w.length > 0)
        .some((w) => !GUARD_VOCABULARY.has(w)),
    );
    // 0.43 as of this commit, down from 0.55 before the guard's closed-class
    // glue was completed. That drop is the ratchet working: every word the
    // guard learns makes this generator that much less independent of it, and
    // when the number reaches the floor the answer is a new axis of English
    // here, not a quieter assertion.
    expect(foreign.length / CONNECTIVES.length).toBeGreaterThan(0.4);
    expect(CONNECTIVES.length).toBeGreaterThan(200);
  });

  it('generates enough cases, and actually checks them', () => {
    expect(quoting.length).toBeGreaterThan(2000);
    expect(dictation.length).toBeGreaterThan(100);
    // Coverage is part of the property. `checked` counts cases the matcher was
    // consulted about, through findReplacements, so a matcher that stopped
    // seeing garbles fails here instead of passing QUOTING vacuously.
    const m = run(marked, 'quoting');
    const p = run(prose, 'quoting');
    expect(m.checked).toBeGreaterThan(9000);
    expect(p.checked).toBeGreaterThan(18000);
    expect(m.skipped + p.skipped).toBeLessThan(quoting.length * 0.2);
    expect(run(dictation, 'dictation').checked).toBeGreaterThan(200);
    expect(runControls([...quoting, ...dictation]).checked).toBeGreaterThan(28000);
  });

  it('QUOTING, marked: a quote, a cell, a list item or an arrow is never flattened', () => {
    summarize('QUOTING-marked', run(marked, 'quoting'));
  });

  it('QUOTING, prose: free sentences about spelling, measured against a ceiling', () => {
    const report = run(prose, 'quoting');
    const rate = report.failures.length / report.checked;
    if (rate > PROSE_CEILING) {
      throw new Error(
        `prose failure rate ${rate.toFixed(4)} is over the ceiling ${PROSE_CEILING}. ` +
          `The guard's word list covers less English than it did.\n${describeFailures('QUOTING-prose', report)}`,
      );
    }
  });

  it('DICTATION: one word said twice in ordinary prose is corrected', () => {
    summarize('DICTATION', run(dictation, 'dictation'));
  });

  it('DICTATION: with no canonical present, every quoting shape is corrected', () => {
    summarize('DICTATION-no-canonical', runControls([...quoting, ...dictation]));
  });
});

/**
 * The corpus the project already has.
 *
 * The repo's own markdown is 50-odd files of text *about* spellings, written by
 * hand, carrying every shape this guard exists to protect and none that a
 * generator invented. Running the committed `.lexicon.yaml` over it costs
 * nothing and it is the only evidence here that nobody wrote for the test.
 *
 * The assertion is the vocabulary-free one, because that is the one that ought
 * to hold everywhere: a spelling that stands inside its own quotation marks, in
 * a paragraph where the canonical also stands, is being named and must survive.
 * The wider count - every rewrite the matcher proposes in these files - is
 * printed rather than asserted, because a good share of it is the matcher
 * reaching past this guard entirely ("lexicon file" -> `LexiconFile`) and is
 * not this module's to fix.
 */
describe('the repo, as a corpus', () => {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));

  function repoMarkdown(): string[] {
    return execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  }

  const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
    ['‘', '’'],
  ];

  function tightQuoted(text: string, start: number, end: number): boolean {
    const before = text[start - 1] ?? '';
    const after = text[end] ?? '';
    return QUOTE_PAIRS.some(([open, close]) => before === open && after === close);
  }

  it('never flattens a quoted spelling in the project\'s own documentation', () => {
    const lexicon = parseLexicon(YAML.parse(readFileSync(join(ROOT, '.lexicon.yaml'), 'utf8')));
    const index = buildIndex(lexicon);
    const flattened: string[] = [];
    let proposed = 0;
    for (const file of repoMarkdown()) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const r of findReplacements(text, index)) {
        proposed++;
        if (!tightQuoted(text, r.start, r.end)) continue;
        // The guard's own precondition: the canonical has to be standing in the
        // same paragraph, or there is nothing here it could have known.
        const from = text.lastIndexOf('\n\n', r.start) + 1;
        const to = text.indexOf('\n\n', r.end) === -1 ? text.length : text.indexOf('\n\n', r.end);
        const rest = text.slice(from, r.start) + text.slice(r.end, to);
        if (!hasCanonical(rest, r.replacement)) continue;
        const line = text.slice(0, r.start).split('\n').length;
        flattened.push(`${file}:${line}  ${JSON.stringify(r.original)} -> ${JSON.stringify(r.replacement)} [${r.reason}]`);
      }
    }
    expect(proposed).toBeGreaterThan(0);
    expect(flattened).toEqual([]);
  });
});
