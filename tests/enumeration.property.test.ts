/**
 * The quoting guard, tested by property rather than by example.
 *
 * `src/core/matcher/enumeration.ts` decides whether a sentence is *quoting* two
 * spellings (leave it alone) or *dictating* one word twice (fix both). It has
 * been tuned twice against hand-picked lists of phrasings and been wrong in
 * both directions both times, because a list of 28 strings says nothing about
 * the 29th. The failures were always a string nobody had thought to write down.
 *
 * So this file does not write strings down. It generates them from parts:
 *
 *   quoting    = canonical + connective + alias, in either order, wrapped in
 *                prose, lists, tables, YAML and multi-line blocks, with the
 *                casing and punctuation that real text carries.
 *   dictation  = the same two spellings joined by ordinary English about the
 *                world, plus every quoting template with the canonical removed.
 *
 * and asserts the round trip both ways:
 *
 *   QUOTING    both spellings still stand in the output.
 *   DICTATION  the garble is gone.
 *
 * The two directions are mirrors, and a guard that cheats in either one fails
 * here. Declining everything fails DICTATION; correcting everything fails
 * QUOTING. Neither number may be traded for the other silently.
 *
 * Cases the matcher itself cannot see are skipped, not failed: every case is
 * first run as a control with the canonical swapped for an unrelated word, so
 * the guard cannot fire. If the control does not correct the garble, the
 * matcher never offered the guard anything and the case proves nothing. The
 * control is also a DICTATION case in its own right, which is what covers
 * "the same templates with the canonical absent".
 */
import { describe, expect, it } from 'vitest';
import { buildIndex, findReplacements } from '../src/core/matcher.js';
import type { Lexicon, Replacement, Term } from '../src/core/types.js';

function lex(terms: Term[]): Lexicon {
  return { version: 1, terms };
}

function apply(text: string, reps: Replacement[]): string {
  let out = text;
  for (let i = reps.length - 1; i >= 0; i--) out = out.slice(0, reps[i].start) + reps[i].replacement + out.slice(reps[i].end);
  return out;
}

function rewrite(text: string, term: Term): string {
  return apply(text, findReplacements(text, buildIndex(lex([term]))));
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

/**
 * Connectives that say "these are two spellings of one thing". Both orders are
 * generated for each; a phrasing that only reads naturally one way still has to
 * be survivable the other way, because the recognizer does not care.
 */
const CONNECTIVES: readonly string[] = [
  ' not ',
  ', not ',
  ' and not ',
  ' rather than ',
  ' instead of ',
  ' vs ',
  ' vs. ',
  ' versus ',
  ' nor ',
  ' aka ',
  ' sounds like ',
  ' sounded like ',
  ' is misheard as ',
  ' gets misheard as ',
  ' keeps coming out as ',
  ' comes out as ',
  ' came out as ',
  ' keeps giving ',
  ' is transcribed as ',
  ' gets transcribed as ',
  ' renders as ',
  ' is rendered as ',
  ' is spelled ',
  ' spelled ',
  ' is written as ',
  ' is typed as ',
  ' is misspelled as ',
  ' is a misspelling of ',
  ' is a typo for ',
  ' is the wrong spelling of ',
  ' should be ',
  ' must be ',
  ' is actually ',
  ' really means ',
  ' means ',
  ' becomes ',
  ' is short for ',
  ' is an alias of ',
  ' as an alias of ',
  ' is the alias for ',
  ' maps to ',
  ' expands to ',
  ' stands for ',
  ' e.g. ',
  ' i.e. ',
  ' -> ',
  ' => ',
  ' → ',
  ' = ',
  ' == ',
  ': ',
  ' : ',
  ' / ',
  ' | ',
  '; ',
  ' ; ',
];

/** Sentence-initial phrasings, where the evidence leads instead of sitting between. */
const LEAD_TEMPLATES: readonly string[] = [
  'not {A}, {C}',
  'Not {A}, {C}',
  'Replace {A} with {C}',
  'Replaced {A} with {C}',
  'Swap {A} for {C}',
  'Correct {A} to {C}',
  'Change {A} to {C}',
  'Add {A} as an alias of {C}',
  'Add {A} as an alias for {C}',
  'alias {A} canonical {C}',
  'canonical: {C}, alias: {A}',
  'canonical {C} alias {A}',
  'Alias {A} for {C}',
  'Spelling: {C}, heard as {A}',
];

/** Shapes that carry two garbles at once: tables, lists, YAML, multi-line blocks. */
const SHAPE_TEMPLATES: readonly string[] = [
  '| {C} | {A}, {B} | brand |',
  '| {C} | {A} | brand |',
  'Aliases for {C}: {A}, {B}',
  'aliases for {C} include {A} and {B}',
  '{C} is often wrong, e.g. {A} and {B}.',
  '{C} has 1. {A} 2. {B} as variants.',
  'Aliases for {C}:\n- {A}\n- {B}',
  'canonical: {C}\naliases:\n  - {A}\n  - {B}',
  '| canonical | alias |\n| --- | --- |\n| {C} | {A} |\n| {C} | {B} |',
  '- {A} -> {C}\n- {B} -> {C}',
  '1. {C}\n2. {A}\n3. {B}',
  'The chips {A} / {B}, and the canonical {C}.',
  '{C}\n  {A}\n  {B}',
  'Lexicon\n\n{C} = {A}\n{C} = {B}',
];

/** Ways the pair sits inside ordinary text. Only applied to gap phrasings. */
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

/** Punctuation a writer puts around a quoted spelling. */
const QUOTERS: ReadonlyArray<(s: string) => string> = [
  (s) => s,
  (s) => `"${s}"`,
  (s) => `'${s}'`,
  (s) => `(${s})`,
];

/**
 * Ordinary dictation: one word said twice, joined by language about the world.
 * Six of these are the regressions a reviewer found against the version before
 * last; the rest are the same shape with different furniture.
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
];

interface Case {
  readonly text: string;
  readonly label: string;
  readonly aliases: readonly string[];
  readonly canonical: string;
  readonly subject: Subject;
}

function fill(template: string, c: string, a: string, b: string): string {
  return template.split('{C}').join(c).split('{A}').join(a).split('{B}').join(b);
}

/** Only the garbles the template actually put in the text can be asked to survive it. */
function present(text: string, aliases: readonly string[]): string[] {
  return aliases.filter((a) => has(text, a));
}

function buildQuotingCases(): Case[] {
  const cases: Case[] = [];
  for (const subject of SUBJECTS) {
    const [alias, alias2] = subject.aliases;
    for (const canonical of subject.canonicals) {
      for (const connective of CONNECTIVES) {
        for (const wrap of WRAPS) {
          for (const quoter of QUOTERS) {
            const c = quoter(canonical);
            const a = quoter(alias);
            const cFirst = wrap(`${c}${connective}${a}`);
            cases.push({ text: cFirst, label: `gap C-first ${JSON.stringify(connective)}`, aliases: present(cFirst, [alias]), canonical, subject });
            const aFirst = wrap(`${a}${connective}${c}`);
            cases.push({ text: aFirst, label: `gap A-first ${JSON.stringify(connective)}`, aliases: present(aFirst, [alias]), canonical, subject });
          }
        }
      }
      for (const template of LEAD_TEMPLATES) {
        const text = fill(template, canonical, alias, alias2);
        cases.push({ text, label: `lead ${JSON.stringify(template)}`, aliases: present(text, [alias]), canonical, subject });
      }
      for (const template of SHAPE_TEMPLATES) {
        const text = fill(template, canonical, alias, alias2);
        cases.push({ text, label: `shape ${JSON.stringify(template)}`, aliases: present(text, [alias, alias2]), canonical, subject });
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
        cases.push({ text, label: `prose ${JSON.stringify(template)}`, aliases: present(text, [alias]), canonical, subject });
      }
    }
  }
  return cases;
}

/**
 * The control: the same text with the canonical swapped for an unrelated word
 * of the same shape. The guard's precondition is that the canonical is present,
 * so the control can never decline and shows what the matcher alone would do.
 */
function control(c: Case): { text: string; out: string; clean: boolean } {
  const text = c.text.split(c.canonical).join(c.subject.neutral);
  const out = rewrite(text, c.subject.term);
  // What a clean matcher decision looks like: every garble becomes the
  // canonical and nothing around it moves. When the matcher's span is wider
  // than the garble - it currently swallows a trailing token, so "cooper
  // netties i.e." matches as one window - the guard is being asked about a
  // different string and the case cannot say whether its answer was right.
  let expected = text;
  for (const alias of c.aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expected = expected.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'), c.subject.term.canonical);
  }
  return { text, out, clean: out === expected };
}

interface Report {
  readonly checked: number;
  readonly skipped: number;
  readonly failures: string[];
}

function run(cases: readonly Case[], direction: 'quoting' | 'dictation'): Report {
  const failures: string[] = [];
  let checked = 0;
  let skipped = 0;
  for (const c of cases) {
    const ctl = control(c);
    // The matcher has to be able to see every garble on its own, and see
    // exactly it, before the guard's answer means anything.
    if (c.aliases.length === 0 || !ctl.clean) {
      skipped++;
      continue;
    }
    checked++;
    const out = rewrite(c.text, c.subject.term);
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
    const ctl = control(c);
    if (ctl.text === c.text || c.aliases.length === 0) {
      skipped++;
      continue;
    }
    checked++;
    const left = c.aliases.filter((a) => has(ctl.out, a));
    if (left.length > 0) failures.push(`[control ${c.label}] refused ${JSON.stringify(left)}: ${JSON.stringify(ctl.text)} -> ${JSON.stringify(ctl.out)}`);
  }
  return { checked, skipped, failures };
}

/**
 * One line per distinct template, with a count and one example. The cross
 * product runs to tens of thousands of strings; a flat list of them says
 * nothing, and the template is the thing that is actually right or wrong.
 */
function summarize(name: string, report: Report): void {
  if (report.failures.length === 0) {
    expect(report.failures).toEqual([]);
    return;
  }
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
  throw new Error(
    `${name}: ${report.failures.length} of ${report.checked} generated cases failed across ${byLabel.size} templates (${report.skipped} skipped as invisible to the matcher).\n  ${lines.join('\n  ')}${byLabel.size > 40 ? `\n  ... and ${byLabel.size - 40} more templates` : ''}`,
  );
}

describe('quoting guard, generated round trips', () => {
  const quoting = buildQuotingCases();
  const dictation = buildDictationCases();

  it('generates enough cases, and actually checks them', () => {
    expect(quoting.length).toBeGreaterThan(2000);
    expect(dictation.length).toBeGreaterThan(100);
    // Coverage is part of the property: a guard cannot be made to pass by
    // making the matcher blind to the cases that would fail it. If these
    // floors ever drop, the suite got quieter, not better.
    const q = run(quoting, 'quoting');
    expect(q.checked).toBeGreaterThan(30000);
    expect(q.skipped).toBeLessThan(quoting.length * 0.2);
    expect(run(dictation, 'dictation').checked).toBeGreaterThan(200);
  });

  it('QUOTING: canonical + connective + alias keeps both spellings', () => {
    summarize('QUOTING', run(quoting, 'quoting'));
  });

  it('DICTATION: one word said twice in ordinary prose is corrected', () => {
    summarize('DICTATION', run(dictation, 'dictation'));
  });

  it('DICTATION: with no canonical present, every quoting shape is corrected', () => {
    summarize('DICTATION-no-canonical', runControls([...quoting, ...dictation]));
  });
});
