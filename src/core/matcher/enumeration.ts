/**
 * Text that is *about* spelling has to survive the matcher.
 *
 * A lexicon file, a docs table, the onboarding screen and any conversation
 * about which words to add all quote the misspellings on purpose. Rewriting
 * those is not a correction, it is destruction: the sentence ends up naming the
 * same spelling twice and the only thing it was saying is gone. The reported
 * case turned "the chips Mason Wiatt / Mason Wyat" into "the chips Mason Wyatt
 * / Mason Wyatt". The sharpest case is the product's own teaching: `learn.ts`
 * tells users to say "it's Ashlr.AI, not Ashler", and flattening that to
 * "it's Ashlr.AI, not Ashlr.AI" makes `learnCorrection` reject its own example.
 *
 * Three rules, and the order of them is the whole design.
 *
 * **A mention** is either a span the matcher wants to rewrite or a place the
 * canonical already stands on its own.
 *
 * **The canonical must be present.** Every sentence that quotes a misspelling
 * says what the right spelling is; that is why it is being written. Two garbles
 * with no canonical between them is someone dictating, not quoting, and the
 * corpus insists on it: `hard-022` is "the reddis and red iss instances are the
 * same box", one word said twice, both halves to be fixed. So is the suite's
 * "ashler / ashlar". This single precondition is what separates them.
 *
 * **The evidence has to sit between the two mentions, not merely somewhere in
 * the sentence.** An earlier version looked for cue words anywhere in the
 * sentence and refused to fix "Kubernetes is fine but the canonical cooper
 * netties docs are not", because `canonical` appeared in it. Words like alias,
 * canonical and spelling are a working programmer's everyday vocabulary, so
 * sentence scope is far too wide. The gap between the two mentions is narrow,
 * and what sits in it is either punctuation that makes them list items or a
 * word that explicitly contrasts them.
 *
 * Mentions whose text is already identical are ordinary repetition and are
 * always corrected, unless the canonical is standing among them.
 */

export interface MentionSpan {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

/**
 * Words that contrast two spellings or name the act of transcribing one.
 * Matched as whole words and only inside the short gap between two mentions,
 * which is what keeps `spelled` and `writes` from firing on ordinary prose.
 * Deliberately excludes "and" and "or", which join dictated repetitions as
 * readily as they join quoted ones.
 */
const CONTRAST_WORDS: ReadonlySet<string> = new Set([
  'not',
  'instead',
  'vs',
  'versus',
  'rather',
  'nor',
  'aka',
  'sounds',
  'sounded',
  'spelled',
  'spelt',
  'spells',
  'misheard',
  'mishears',
  'hears',
  'heard',
  'writes',
  'wrote',
  'written',
  'renders',
  'transcribes',
  'transcribed',
  'becomes',
  'means',
  'eg',
  'ie',
]);

/** The longest gap between two mentions that can still be read as contrasting them. */
const MAX_CONTRAST_GAP = 30;

/**
 * A gap of nothing but these, and whitespace, makes the two mentions list
 * items rather than prose. The comma is deliberately absent: a comma splice
 * ("I pushed to Redis, reddis went down") is ordinary dictation, and every
 * quoting case that uses a comma also carries a contrast word next to it.
 */
const LIST_PUNCTUATION = /^[\s/|;>→()[\]"'“”‘’-]+$/u;

/** A gap of whitespace, digits and list punctuation, with a digit: "1." or "2)". */
const NUMBERED_ITEM = /^[\s\d.)\]]*\d[\s\d.)\]]*$/u;

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Sentence bounds, tolerant of the periods that legitimately sit mid-sentence.
 * A canonical can carry one (Ashlr.AI, Otter.ai, Node.js), and so can an
 * enumeration's own scaffolding: breaking on "e.g. " or "1. " used to strand
 * the quoted aliases in a sentence of their own, away from the canonical they
 * were being contrasted with, which silently disabled every rule below.
 */
function sentenceBounds(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isNewline = ch === '\n' || ch === '\r';

    let isTerminal = (ch === '.' || ch === '!' || ch === '?') && /[ \t]/.test(text[i + 1] ?? '\n');
    if (isTerminal && ch === '.') {
      const prev = text[i - 1] ?? '';
      // "1." and "2)" are list scaffolding, not the end of a thought.
      if (/\d/.test(prev)) isTerminal = false;
      // "e.g." and "i.e." and "U.S.": a lone letter standing after a period.
      else if (/\p{L}/u.test(prev) && (text[i - 2] ?? '') === '.') isTerminal = false;
    }
    if (!isNewline && !isTerminal) continue;

    const end = isNewline ? i : i + 1;
    if (end > start) bounds.push([start, end]);
    start = i + 1;
  }
  if (start < text.length) bounds.push([start, text.length]);
  return bounds;
}

/** Offsets where `needle` stands as its own word and no rewrite span covers it. */
function bareOccurrences(
  text: string,
  from: number,
  to: number,
  needle: string,
  covered: readonly MentionSpan[],
): number[] {
  if (needle.length === 0) return [];
  const found: number[] = [];
  const window = text.slice(from, to);
  let at = window.indexOf(needle);
  while (at !== -1) {
    const start = from + at;
    const end = start + needle.length;
    const bounded = !isWordChar(text[start - 1] ?? '') && !isWordChar(text[end] ?? '');
    if (bounded && !covered.some((s) => start < s.end && s.start < end)) found.push(start);
    at = window.indexOf(needle, at + 1);
  }
  return found;
}

/**
 * True when what sits between two mentions contrasts them: list punctuation and
 * nothing else, a numbered item, or a contrast word within a short gap.
 */
function hasContrastWord(fragment: string): boolean {
  // "e.g." and "i.e." survive as themselves; splitting on non-letters would
  // shred them into single characters too common to match on.
  if (/\b(?:e\.g|i\.e)\./i.test(fragment)) return true;
  for (const word of fragment.toLowerCase().split(/[^\p{L}]+/u)) {
    if (word && CONTRAST_WORDS.has(word)) return true;
  }
  return false;
}

function contrastsBetween(gap: string): boolean {
  if (gap.length === 0) return false;
  if (LIST_PUNCTUATION.test(gap)) return true;
  if (gap.length <= 12 && NUMBERED_ITEM.test(gap)) return true;
  if (gap.length > MAX_CONTRAST_GAP) return false;
  return hasContrastWord(gap);
}

/**
 * The contrast word does not always sit between the two mentions. "not Ashler,
 * Ashlr.AI" is one of the phrasings `learn.ts` teaches, and there the word
 * leads. Only a very short run is considered, because widening it to a clause
 * brings back the sentence-scope false positives: "That sounds like the
 * Kubernetes issue, cooper netties keeps crashing" must still be corrected.
 */
const MAX_LEAD_IN = 8;

function contrastsBefore(text: string, from: number, firstMention: number): boolean {
  const lead = text.slice(Math.max(from, firstMention - MAX_LEAD_IN), firstMention);
  return hasContrastWord(lead);
}

/**
 * Drop the rewrites that would flatten a sentence which is quoting spellings.
 * Pure, and order-preserving for everything it keeps.
 */
export function declineCollapsedMentions<T extends MentionSpan>(text: string, spans: readonly T[]): T[] {
  if (spans.length === 0) return spans as T[];

  const declined = new Set<number>();
  // Both lists are sorted by offset, so one pointer walks the spans once across
  // all sentences. Rescanning every span per sentence made this quadratic: a
  // 1 MB document, which is what the local API accepts, took seconds.
  let cursor = 0;

  for (const [from, to] of sentenceBounds(text)) {
    while (cursor < spans.length && spans[cursor].start < from) cursor++;

    const here: Array<{ span: T; index: number }> = [];
    for (let i = cursor; i < spans.length && spans[i].start < to; i++) {
      if (spans[i].end <= to) here.push({ span: spans[i], index: i });
    }
    if (here.length === 0) continue;

    const covered = here.map((h) => h.span);
    const byResult = new Map<string, { indices: number[]; points: Array<[number, number]> }>();
    for (const { span, index } of here) {
      let group = byResult.get(span.replacement);
      if (!group) {
        group = { indices: [], points: [] };
        byResult.set(span.replacement, group);
      }
      group.indices.push(index);
      group.points.push([span.start, span.end]);
    }

    for (const [result, group] of byResult) {
      // The canonical has to be standing here on its own. Without it there is
      // nothing being contrasted against, and this is someone dictating.
      const bare = bareOccurrences(text, from, to, result, covered);
      if (bare.length === 0) continue;
      for (const at of bare) group.points.push([at, at + result.length]);

      const points = group.points.slice().sort((a, b) => a[0] - b[0]);
      let contrasted = contrastsBefore(text, from, points[0][0]);
      for (let i = 0; i + 1 < points.length && !contrasted; i++) {
        const gapStart = points[i][1];
        const gapEnd = points[i + 1][0];
        if (gapEnd >= gapStart) contrasted = contrastsBetween(text.slice(gapStart, gapEnd));
      }

      if (contrasted) for (const index of group.indices) declined.add(index);
    }
  }

  if (declined.size === 0) return spans as T[];
  return spans.filter((_, i) => !declined.has(i));
}
