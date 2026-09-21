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
 * Two earlier versions looked for cue words *somewhere near* the mentions:
 * a cue anywhere in the sentence, then a cue anywhere inside a thirty-character
 * gap. Both were wrong in both directions, because "somewhere near" is an open
 * test. `not`, `heard`, `wrote` and `means` are ordinary English, so "I heard
 * red iss went down but Redis Cloud is fine" tripped a guard meant for "it's
 * Redis, not red iss". Widening or narrowing the window only moved which
 * sentences were wrong.
 *
 * So the test here is closed, not proximate. Three rules, in this order.
 *
 * **A mention** is either a span the matcher wants to rewrite or a place the
 * canonical already stands. The canonical counts in any spelling that folds to
 * it, so "ashlr.ai" and "Ashlr AI" anchor a sentence exactly as "Ashlr.AI" does.
 *
 * **The canonical must be present in the block.** Every passage that quotes a
 * misspelling says what the right spelling is; that is why it is being written.
 * Two garbles with no canonical anywhere is someone dictating, and the corpus
 * insists on it: `hard-022` is "the reddis and red iss instances are the same
 * box", one word said twice, both halves to be fixed.
 *
 * **What sits between two mentions must be made *only* of words about writing.**
 * Not "must contain one of them" - must contain nothing else. Punctuation that
 * makes the two mentions list items counts, and so does a phrase built entirely
 * from a closed metalinguistic vocabulary (`not`, `spelled`, `alias`, `comes
 * out as`) plus closed-class glue (`is`, `the`, `of`, `as`). One word about the
 * world - `caching`, `upgrade`, `scripts`, `again` - and the passage is
 * dictation, whatever cues sit beside it. That single change is what lets the
 * vocabulary be generous without the guard becoming greedy.
 *
 * **The refusal is local.** Contrast links adjacent mentions into a run; only
 * the run is declined. A block that quotes once and then mentions the term
 * ordinarily gets the first left alone and the second fixed, without depending
 * on sentence detection being perfect - which it cannot be, since a period
 * after a digit or an abbreviation does not end a thought.
 *
 * `tests/enumeration.property.test.ts` is the specification: it generates the
 * round trip in both directions from templates rather than pinning phrasings,
 * because every failure this file has ever had was a string nobody listed.
 */

export interface MentionSpan {
  start: number;
  end: number;
  original: string;
  replacement: string;
}

/**
 * Words that name the act of writing, spelling, hearing or substituting a name.
 * A gap made only of these (and GLUE) is talking about spelling; a gap with any
 * other word in it is talking about the world. Generous on purpose: the closed
 * test above, not the size of this set, is what keeps ordinary prose safe.
 */
const MARKERS: ReadonlySet<string> = new Set([
  // contrast
  'not', 'no', 'never', 'nor', 'instead', 'rather', 'vs', 'versus', 'aka', 'eg', 'ie', 'namely', 'sic',
  // hearing
  'hear', 'hears', 'heard', 'hearing', 'mishear', 'mishears', 'misheard', 'sound', 'sounds', 'sounded',
  // spelling
  'spell', 'spells', 'spelled', 'spelt', 'spelling', 'spellings',
  'misspell', 'misspells', 'misspelled', 'misspelt', 'misspelling', 'misspellings',
  'typo', 'typos', 'capital', 'capitalized', 'capitalised', 'lowercase', 'uppercase', 'hyphen', 'hyphenated',
  'abbreviation', 'abbreviated', 'acronym', 'initials',
  // writing and transcribing
  'write', 'writes', 'wrote', 'written', 'writing', 'type', 'typed', 'types', 'typing',
  'render', 'renders', 'rendered', 'rendering',
  'transcribe', 'transcribes', 'transcribed', 'transcription', 'transcript',
  'dictate', 'dictated', 'dictation', 'recognizer', 'recogniser',
  // naming
  'alias', 'aliases', 'canonical', 'variant', 'variants', 'term', 'terms', 'word', 'words', 'form', 'forms',
  'name', 'named', 'names', 'naming', 'label', 'labeled', 'labelled', 'labels',
  'say', 'says', 'said', 'saying', 'call', 'called', 'calls', 'calling',
  'quote', 'quoted', 'quotes', 'literally', 'verbatim',
  // substitution
  'replace', 'replaces', 'replaced', 'replacing', 'swap', 'swaps', 'swapped', 'substitute', 'substituted',
  'change', 'changes', 'changed', 'correct', 'corrects', 'corrected', 'correction', 'fix', 'fixes', 'fixed',
  'mean', 'means', 'meant', 'meaning', 'become', 'becomes', 'became',
  'map', 'maps', 'mapped', 'expand', 'expands', 'expanded', 'stand', 'stands', 'short',
  // production
  'give', 'gives', 'giving', 'gave', 'come', 'comes', 'coming', 'came', 'keep', 'keeps', 'kept',
  'produce', 'produces', 'output', 'outputs', 'print', 'prints', 'show', 'shows', 'shown',
  // enumeration
  'include', 'includes', 'including', 'list', 'listed', 'lists', 'example', 'examples',
  // judgement about a spelling
  'wrong', 'right', 'proper', 'properly', 'actual', 'actually', 'really', 'should', 'must', 'ought',
  'prefer', 'prefers', 'preferred',
]);

/**
 * Closed-class glue. Allowed inside a gap, never enough on its own: "Ashler is
 * Ashlr.AI" reads as dictation as readily as it reads as a definition, so a gap
 * of pure glue is not evidence of anything.
 *
 * `and` and `or` are deliberately absent. They join dictated repetitions at
 * least as often as quoted ones ("so Kubernetes and cooper netties both
 * resolve"), and leaving them out is what stops a lead-in like "Check the
 * spelling on the" from reaching across one into an ordinary sentence. They
 * chain an already-established contrast instead; see CHAIN_WORDS.
 */
const GLUE: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'of', 'to', 'as', 'at', 'in', 'on', 'for', 'from', 'by', 'with', 'into', 'than', 'then',
  'that', 'this', 'these', 'those', 'it', 'its', 'like', 'out', 'up', 'off',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had',
  'do', 'does', 'did', 'get', 'gets', 'got', 'getting', 's',
]);

/** Words that extend a contrast that is already established, but can never start one. */
const CHAIN_WORDS: ReadonlySet<string> = new Set(['and', 'or', 'plus', 'amp']);

/** Non-word characters allowed in a chaining gap: a comma or an ampersand, nothing louder. */
const CHAIN_PUNCTUATION = /^[\s,&+]*$/u;

/**
 * A gap of nothing but these makes the two mentions list items rather than
 * prose: a table cell, an arrow, a definition colon, a slash-delimited pair.
 * The comma is deliberately absent, because a comma splice ("I pushed to Redis,
 * reddis went down") is ordinary dictation; a comma chains instead.
 */
const LIST_PUNCTUATION = /^[\s/|;>→=*•·()[\]"'“”‘’:-]+$/u;

/** A gap of whitespace, digits and list punctuation, with a digit: "1." or "2)". */
const NUMBERED_ITEM = /^[\s\d.)\]]*\d[\s\d.)\]]*$/u;

/**
 * "e.g." and "i.e." survive as themselves. Splitting a gap on non-letters
 * shreds them into single characters too common to match on, and they are the
 * one abbreviation whose whole job is to introduce the examples that follow.
 */
const ENUMERATING_ABBREVIATION = /\b(?:e\.g|i\.e)\./i;

/**
 * Abbreviations whose period does not end a thought. "vs." is the one that
 * matters: it is the plainest way to write a pair of spellings, and breaking
 * the block on it put the two halves of "Ashlr.AI vs. Ashler" out of each
 * other's reach. Closed and short on purpose - a period after any other word
 * still ends the block, so "Kubernetes is not. cooper netties shipped." keeps
 * being two thoughts.
 */
const ABBREVIATIONS: ReadonlySet<string> = new Set(['vs', 'eg', 'ie', 'cf', 'etc', 'al', 'approx', 'resp']);

/** Bullets and numbering that can stand before a mention on its own line. */
const LINE_BULLET = /^[\s\d.)\]*+•·>|-]*$/u;
/** Punctuation that can trail a mention that is alone on its line. */
const LINE_TRAILER = /^[\s.,;:)|\]"'”’!?-]*$/u;

type Link = 'contrast' | 'chain' | 'none';

interface Point {
  readonly start: number;
  readonly end: number;
  /** Index into the caller's span list, or null when this is a bare canonical. */
  readonly index: number | null;
  /** True when this point already reads as the canonical. */
  readonly anchor: boolean;
}

function isWordChar(ch: string): boolean {
  return ch !== '' && /[\p{L}\p{N}]/u.test(ch);
}

/** Case and punctuation folded away: "ashlr.ai" and "Ashlr AI" both become "ashlrai". */
function foldSpelling(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function wordsOf(fragment: string): string[] {
  return fragment.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length > 0);
}

function inVocabulary(word: string): boolean {
  return MARKERS.has(word) || GLUE.has(word);
}

/**
 * Block bounds: a run of text inside which two mentions can be contrasted.
 *
 * Terminal punctuation ends one, tolerant of the periods that legitimately sit
 * mid-sentence - a canonical can carry one (Ashlr.AI, Node.js), and so can an
 * enumeration's own scaffolding ("e.g. ", "1. "). A blank line ends one too.
 *
 * A single newline does **not**, which is the change from the last version. A
 * markdown list and a YAML block put every alias on its own line, and breaking
 * there stranded each one in a block with no canonical in it, silently
 * disabling every rule below for exactly the files this guard exists to
 * protect. Widening the block is only safe because the gap test is closed:
 * two mentions on different lines still need nothing but spelling words
 * between them.
 */
/** The run of letters immediately before `at`, lowercased: "vs" in "vs.". */
function wordBefore(text: string, at: number): string {
  let i = at;
  while (i > 0 && /\p{L}/u.test(text[i - 1])) i--;
  return text.slice(i, at).toLowerCase();
}

function blockBounds(text: string): Array<[number, number]> {
  const bounds: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let isBreak = false;

    if (ch === '.' || ch === '!' || ch === '?') {
      isBreak = i + 1 >= text.length || /\s/.test(text[i + 1]);
      if (isBreak && ch === '.') {
        const prev = text[i - 1] ?? '';
        // "1." and "2)" are list scaffolding, not the end of a thought.
        if (/\d/.test(prev)) isBreak = false;
        // "e.g." and "i.e." and "U.S.": a lone letter standing after a period.
        else if (/\p{L}/u.test(prev) && (text[i - 2] ?? '') === '.') isBreak = false;
        else if (ABBREVIATIONS.has(wordBefore(text, i))) isBreak = false;
      }
    } else if (ch === '\n') {
      let k = i + 1;
      while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\r')) k++;
      isBreak = k >= text.length || text[k] === '\n';
    }
    if (!isBreak) continue;

    const end = ch === '\n' ? i : i + 1;
    if (end > start) bounds.push([start, end]);
    start = i + 1;
  }
  if (start < text.length) bounds.push([start, text.length]);
  return bounds;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every offset where `needle` stands as its own word, case folded away. The
 * exact-case search this replaced missed the canonical in the casing dictation
 * actually produces, so "it's ashlr.ai, not Ashler" had no anchor and was
 * flattened to the one thing it must never say.
 */
function wordOccurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  if (needle.length === 0) return found;
  const re = new RegExp(escapeRegExp(needle), 'giu');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (!isWordChar(text[start - 1] ?? '') && !isWordChar(text[end] ?? '')) found.push(start);
    if (re.lastIndex <= start) re.lastIndex = start + 1;
  }
  return found;
}

function lineStart(text: string, at: number): number {
  const i = text.lastIndexOf('\n', Math.max(at - 1, 0));
  return i === -1 ? 0 : i + 1;
}

function lineEnd(text: string, at: number): number {
  const i = text.indexOf('\n', at);
  return i === -1 ? text.length : i;
}

/** True when the mention is the only thing on its line, bullets aside: a list item. */
function isOwnLineItem(text: string, start: number, end: number): boolean {
  return LINE_BULLET.test(text.slice(lineStart(text, start), start)) && LINE_TRAILER.test(text.slice(end, lineEnd(text, end)));
}

/** A gap of commas, ampersands and the words "and"/"or": enough to extend a contrast, never to start one. */
function isChainGap(gap: string, words: readonly string[]): boolean {
  if (!CHAIN_PUNCTUATION.test(gap.replace(/[\p{L}\p{N}]+/gu, ''))) return false;
  return words.every((w) => CHAIN_WORDS.has(w));
}

/**
 * Words about writing and nothing else, with at least one that names the act.
 * A chain word may ride along ("and not"), because a marker is still required
 * and the marker is what is being trusted; a gap of chain words alone has none
 * and falls through to isChainGap.
 */
function isSpellingPhrase(words: readonly string[]): boolean {
  if (words.length === 0) return false;
  if (!words.every((w) => inVocabulary(w) || CHAIN_WORDS.has(w))) return false;
  return words.some((w) => MARKERS.has(w));
}

function linkBetween(text: string, a: Point, b: Point): Link {
  const gap = text.slice(a.end, b.start);
  if (gap.length === 0) return 'contrast';

  if (/^\s+$/u.test(gap)) {
    // Whitespace alone is a list only when both mentions stand alone on their
    // lines. Otherwise it is a wrapped line of prose: "we deployed to Redis\n
    // reddis went down" has the same shape as a two-item list and is not one.
    const stacked = gap.includes('\n') && isOwnLineItem(text, a.start, a.end) && isOwnLineItem(text, b.start, b.end);
    return stacked ? 'contrast' : 'none';
  }

  if (LIST_PUNCTUATION.test(gap)) return 'contrast';
  if (gap.length <= 12 && NUMBERED_ITEM.test(gap)) return 'contrast';
  if (ENUMERATING_ABBREVIATION.test(gap)) return 'contrast';

  const words = wordsOf(gap);
  if (isSpellingPhrase(words)) return 'contrast';
  if (isChainGap(gap, words)) return 'chain';
  return 'none';
}

/**
 * The evidence does not always sit between the two mentions. "not Ashler,
 * Ashlr.AI" and "Replace Ashler with Ashlr.AI" are phrasings a user types to
 * teach the lexicon, and there the word leads.
 *
 * It only counts when the passage *opens* with it - from the start of the block
 * or of the line, whichever is nearer - and when everything from there to the
 * second mention is still made only of spelling words. "Not cooper netties
 * again, the Kubernetes cluster is flaky" opens with a marker too, and "again"
 * is what tells it apart.
 */
function leadContrasts(text: string, blockFrom: number, first: Point, second: Point): boolean {
  const leadFrom = Math.max(blockFrom, lineStart(text, first.start));
  const leadWords = wordsOf(text.slice(leadFrom, first.start));
  if (!isSpellingPhrase(leadWords)) return false;
  if (leadWords.some((w) => CHAIN_WORDS.has(w))) return false;
  const gapWords = wordsOf(text.slice(first.end, second.start));
  return gapWords.every((w) => inVocabulary(w) && !CHAIN_WORDS.has(w));
}

/**
 * Drop the rewrites that would flatten a passage which is quoting spellings.
 * Pure, and order-preserving for everything it keeps.
 */
export function declineCollapsedMentions<T extends MentionSpan>(text: string, spans: readonly T[]): T[] {
  if (spans.length === 0) return spans as T[];

  const declined = new Set<number>();
  const occurrences = new Map<string, number[]>();
  // Both lists are sorted by offset, so one pointer walks the spans once across
  // all blocks. Rescanning every span per block made this quadratic: a 1 MB
  // document, which is what the local API accepts, took seconds.
  let cursor = 0;

  for (const [from, to] of blockBounds(text)) {
    while (cursor < spans.length && spans[cursor].start < from) cursor++;

    const here: Array<{ span: T; index: number }> = [];
    for (let i = cursor; i < spans.length && spans[i].start < to; i++) {
      if (spans[i].end <= to) here.push({ span: spans[i], index: i });
    }
    if (here.length === 0) continue;

    const byResult = new Map<string, Point[]>();
    for (const { span, index } of here) {
      let group = byResult.get(span.replacement);
      if (!group) {
        group = [];
        byResult.set(span.replacement, group);
      }
      group.push({ start: span.start, end: span.end, index, anchor: foldSpelling(span.original) === foldSpelling(span.replacement) });
    }

    for (const [result, points] of byResult) {
      let bare = occurrences.get(result);
      if (!bare) {
        bare = wordOccurrences(text, result);
        occurrences.set(result, bare);
      }
      for (const at of bare) {
        if (at < from || at + result.length > to) continue;
        if (here.some(({ span }) => at < span.end && span.start < at + result.length)) continue;
        points.push({ start: at, end: at + result.length, index: null, anchor: true });
      }

      // The canonical has to be standing somewhere in this block. Without it
      // there is nothing being contrasted against, and this is someone
      // dictating one word twice.
      if (!points.some((p) => p.anchor)) continue;

      points.sort((a, b) => a.start - b.start);
      const links: Link[] = [];
      for (let i = 0; i + 1 < points.length; i++) {
        let link = linkBetween(text, points[i], points[i + 1]);
        if (link !== 'contrast' && i === 0 && leadContrasts(text, from, points[0], points[1])) link = 'contrast';
        links.push(link);
      }

      // Decline by run, not by block: only the mentions actually linked to a
      // contrast are left alone, so an ordinary mention further along the same
      // block is still corrected however the sentence bounds happened to fall.
      for (let i = 0; i < points.length; ) {
        let j = i;
        let contrasted = false;
        while (j + 1 < points.length && links[j] !== 'none') {
          if (links[j] === 'contrast') contrasted = true;
          j++;
        }
        if (contrasted) {
          for (let k = i; k <= j; k++) {
            const index = points[k].index;
            if (index !== null) declined.add(index);
          }
        }
        i = j + 1;
      }
    }
  }

  if (declined.size === 0) return spans as T[];
  return spans.filter((_, i) => !declined.has(i));
}
