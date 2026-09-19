/**
 * suggestAliases(): guess the spellings a speech-to-text engine is likely to
 * produce for an invented name. Deterministic, at most 8 results, never the
 * canonical itself.
 *
 * Techniques, in priority order (earlier ones survive the cap):
 *   1. split on dots / hyphens / underscores / camelCase  ("Ashlr.AI" -> "Ashlr AI")
 *   2. strip a domain-style suffix                        ("Ashlr.AI" -> "Ashlr")
 *   3. insert a vowel into a word-final consonant cluster ("Ashlr" -> "Ashler", "Ashlar")
 *   4. acronyms: pronounced form and spelled letters      ("SaaS" -> "sass", "S a a S")
 *   5. common phoneme confusions                          (ph->f, hard c->k, k->c, y->i, doubled letters collapsed)
 */

const DOMAIN_SUFFIX = /^(.{2,}?)\.(ai|io|com|dev|app|co|net|org|sh|xyz|me|so|gg)$/i;
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
/** Digraphs treated as a single consonant unit when measuring clusters. */
const DIGRAPHS = new Set(['sh', 'ch', 'th', 'ph', 'wh', 'ck', 'ng']);

export function suggestAliases(canonical: string): string[] {
  const base = canonical.trim();
  const out: string[] = [];
  const seen = new Set<string>([base.toLowerCase()]);
  const add = (s: string): void => {
    const v = s.replace(/\s+/g, ' ').trim();
    if (!v) return;
    const key = v.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(v);
  };
  if (!base) return out;

  const acronym = isAcronym(base);

  // 1. split into words (acronyms are not camelCase, "SaaS" is not "Saa S")
  const words = acronym ? [base] : splitWords(base);
  const spaced = words.join(' ');
  if (!acronym) add(spaced);

  // 2. domain suffix stripped
  const stemMatch = DOMAIN_SUFFIX.exec(base);
  const stem = stemMatch ? stemMatch[1] : undefined;
  if (stem) add(stem);

  // 3. vowel insertion into word-final consonant clusters
  const vowelTargets = stem ? [stem, spaced] : [spaced];
  for (const target of vowelTargets) {
    for (const variant of insertVowels(target)) add(variant);
  }

  // 4. acronyms
  if (acronym) {
    add(pronounceAcronym(base));
    add(base.replace(/[^\p{L}\p{N}]/gu, '').split('').join(' '));
  }

  // 5. phoneme confusions, applied to the canonical and to the spaced form
  for (const target of stem ? [stem, spaced] : [spaced, base]) {
    for (const variant of confusions(target)) add(variant);
  }

  return out.slice(0, 8);
}

/** Split on separators and camelCase boundaries. "OpenClaw" -> ["Open", "Claw"]. */
function splitWords(s: string): string[] {
  return s
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s._\-/]+/u)
    .filter((w) => w.length > 0);
}

function isVowel(ch: string): boolean {
  return VOWELS.has(ch.toLowerCase());
}

/** Break a word into consonant "units" (digraphs count as one). */
function consonantUnits(tail: string): string[] {
  const units: string[] = [];
  let i = 0;
  while (i < tail.length) {
    const pair = tail.slice(i, i + 2).toLowerCase();
    if (pair.length === 2 && DIGRAPHS.has(pair)) {
      units.push(tail.slice(i, i + 2));
      i += 2;
    } else {
      units.push(tail[i]);
      i += 1;
    }
  }
  return units;
}

/**
 * For each word ending in a cluster of >= 3 consonant units (a name with a
 * swallowed vowel, "Ashlr"), insert 'e' and 'a' before the last unit.
 */
function insertVowels(phrase: string): string[] {
  const results: string[] = [];
  const words = phrase.split(' ');
  words.forEach((word, wi) => {
    const letters = word.replace(/[^\p{L}]/gu, '');
    if (letters.length < 4) return;
    let k = letters.length;
    while (k > 0 && !isVowel(letters[k - 1])) k--;
    const tail = letters.slice(k);
    const units = consonantUnits(tail);
    if (units.length < 3) return;
    const head = letters.slice(0, k) + units.slice(0, -1).join('');
    const last = units[units.length - 1];
    for (const vowel of ['e', 'a']) {
      const next = [...words];
      next[wi] = head + vowel + last;
      results.push(next.join(' '));
    }
  });
  return results;
}

function isAcronym(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2 || letters.length > 6) return false;
  const upper = (letters.match(/\p{Lu}/gu) ?? []).length;
  return upper >= 2 && upper >= letters.length / 2;
}

/** "SaaS" -> "sass", "PaaS" -> "pass", "AWS" -> "aws". */
function pronounceAcronym(s: string): string {
  let w = s.replace(/[^\p{L}]/gu, '').toLowerCase();
  // collapse repeated vowels: "saas" -> "sas"
  w = w.replace(/([aeiou])\1+/g, '$1');
  // short vowel + single final consonant reads better doubled: "sas" -> "sass"
  if (w.length >= 3) {
    const last = w[w.length - 1];
    const prev = w[w.length - 2];
    if (!isVowel(last) && isVowel(prev) && last !== 'w' && last !== 'y') w += last;
  }
  return w;
}

/** Common STT phoneme confusions, one variant each (only when something changes). */
function confusions(s: string): string[] {
  const results: string[] = [];
  const tryAdd = (v: string): void => {
    if (v !== s) results.push(v);
  };
  tryAdd(s.replace(/ph/gi, (m) => (m[0] === 'P' ? 'F' : 'f')));
  // hard c (before a/o/u or a consonant, not "ch") -> k
  tryAdd(s.replace(/c(?=[aou]|[^\p{L}eihy]|$)/giu, (m) => (m === 'C' ? 'K' : 'k')));
  tryAdd(s.replace(/k(?!e|i|y)/gi, (m) => (m === 'K' ? 'C' : 'c')));
  // y as a vowel (not word-initial) -> i
  tryAdd(s.replace(/(?<=\p{L})y/giu, (m) => (m === 'Y' ? 'I' : 'i')));
  tryAdd(s.replace(/(\p{L})\1/giu, '$1'));
  return results;
}
