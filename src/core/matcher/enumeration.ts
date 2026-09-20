/**
 * Text that is *about* spelling has to survive the matcher.
 *
 * A lexicon file, a docs table, the onboarding screen and any conversation about
 * which words to add all quote the misspellings on purpose. Rewriting those is
 * not a correction, it is destruction: a sentence listing what the recognizer
 * produces becomes the same word twice, and the only information it carried is
 * gone. The bug that prompted this turned "the chips Mason Wiatt / Mason Wyat"
 * into "the chips Mason Wyatt / Mason Wyatt".
 *
 * The tempting rule is "never collapse two different spellings into one". That
 * rule is wrong, and the benchmark corpus says so in `hard-022`: "the reddis and
 * red iss instances are the same box" is one person dictating one word twice and
 * both halves must be fixed. It is structurally identical to the bug above.
 *
 * Nor is delimiter adjacency enough on its own: the suite already requires
 * "ashler / ashlar" to be corrected, and it has the same shape as the bug.
 *
 * What the bug has and those cases lack is the canonical standing in the same
 * sentence, spelling out what the quoted forms are being contrasted against. So
 * a mention is either a span the matcher wants to rewrite or a place the
 * canonical already stands on its own, and the rewrite is declined when the
 * mentions collapse and either:
 *
 *  - **The canonical is present and two mentions sit side by side**, separated
 *    by nothing but a slash, comma, pipe, tab or dash. That is a list being
 *    contrasted with its canonical, as in "Mason Wyatt, the chips Mason Wiatt /
 *    Mason Wyat". Prose that merely repeats a term keeps words in between
 *    ("Kubernetes is fine but the cooper netties docs are not"), so it is safe.
 *  - **The sentence says in words that it is about spelling**: "sounds like",
 *    "writes it as", "misheard", "alias". These cues are deliberately narrow and
 *    name the act of transcribing, so an ordinary sentence repeating a term
 *    ("the Redis and Redis instances are the same box") never trips them.
 *
 * Mentions whose text is already identical are ordinary repetition and are
 * always corrected.
 */

export interface MentionSpan {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

/**
 * Narrow on purpose. Each of these names the act of spelling, transcribing or
 * listing alternatives, which is what distinguishes a sentence quoting a
 * misspelling from one that merely happens to contain the same term twice.
 */
const SPELLING_CUES: readonly string[] = [
  'sounds like',
  'sound like',
  'sounded like',
  'spelled',
  'spelling',
  'spells',
  'misspell',
  'misheard',
  'mishears',
  'hears it as',
  'heard as',
  'writes it',
  'writes as',
  'write it as',
  'written as',
  'wrote it as',
  'comes out as',
  'turns into',
  'transcrib',
  'renders it',
  'mangles',
  'autocorrect',
  'typo',
  'alias',
  'canonical',
  'stt',
  'speech-to-text',
  'speech to text',
];

/** Characters that make two neighbouring mentions list items rather than prose. */
const LIST_DELIMITERS: ReadonlySet<string> = new Set(['/', '|', ',', ';', '\t', '>', '→']);

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Sentence bounds, tolerant of the fact that canonicals contain periods.
 * A break needs terminal punctuation followed by whitespace, so the dot in
 * "Ashlr.AI" and "Otter.ai" never splits one, and a newline always does.
 */
function sentenceBounds(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const isNewline = ch === '\n' || ch === '\r';
    const isTerminal = (ch === '.' || ch === '!' || ch === '?') && /[ \t]/.test(text[i + 1] ?? '\n');
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

/** True when only whitespace and at least one list delimiter separate the two. */
function delimiterAdjacent(text: string, leftEnd: number, rightStart: number): boolean {
  if (rightStart < leftEnd) return false;
  const between = text.slice(leftEnd, rightStart);
  if (between.length === 0 || between.length > 8) return false;

  let sawDelimiter = false;
  for (const ch of between) {
    if (LIST_DELIMITERS.has(ch)) {
      sawDelimiter = true;
      continue;
    }
    // A dash counts only as a separator, never as the hyphen inside a word,
    // which the whitespace requirement around it already implies here.
    if (ch === '-' || ch === '–' || ch === '—') {
      sawDelimiter = true;
      continue;
    }
    if (!/\s/.test(ch)) return false;
  }
  return sawDelimiter;
}

function hasSpellingCue(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return SPELLING_CUES.some((cue) => lower.includes(cue));
}

/**
 * Drop the rewrites that would flatten a sentence which is quoting spellings.
 * Pure, and order-preserving for everything it keeps.
 */
export function declineCollapsedMentions<T extends MentionSpan>(text: string, spans: readonly T[]): T[] {
  if (spans.length === 0) return spans as T[];

  const declined = new Set<number>();

  for (const [from, to] of sentenceBounds(text)) {
    const here: Array<{ span: T; index: number }> = [];
    for (let i = 0; i < spans.length; i++) {
      if (spans[i].start >= from && spans[i].end <= to) here.push({ span: spans[i], index: i });
    }
    if (here.length === 0) continue;

    const covered = here.map((h) => h.span);
    const cued = hasSpellingCue(text.slice(from, to));

    const byResult = new Map<
      string,
      { originals: Set<string>; indices: number[]; points: Array<[number, number]> }
    >();
    for (const { span, index } of here) {
      let group = byResult.get(span.replacement);
      if (!group) {
        group = { originals: new Set<string>(), indices: [], points: [] };
        byResult.set(span.replacement, group);
      }
      group.originals.add(span.original);
      group.indices.push(index);
      group.points.push([span.start, span.end]);
    }

    for (const [result, group] of byResult) {
      const bare = bareOccurrences(text, from, to, result, covered);
      for (const at of bare) {
        group.originals.add(result);
        group.points.push([at, at + result.length]);
      }

      // Identical mentions are someone saying the word twice, not quoting it.
      if (group.originals.size < 2) continue;

      const adjacent = group.points
        .slice()
        .sort((a, b) => a[0] - b[0])
        .some(([, end], i, sorted) => i + 1 < sorted.length && delimiterAdjacent(text, end, sorted[i + 1][0]));

      // Side-by-side list items only read as quotation when the canonical is
      // there to be quoted against; an explicit cue speaks for itself.
      if (cued || (bare.length > 0 && adjacent)) for (const index of group.indices) declined.add(index);
    }
  }

  if (declined.size === 0) return spans as T[];
  return spans.filter((_, i) => !declined.has(i));
}
