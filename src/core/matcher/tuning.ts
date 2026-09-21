/**
 * Every tuning knob the matcher has, in one place: window sizes, the phonetic
 * and fuzzy score weights, the thresholds a candidate has to clear, and the
 * word lists that hold false positives down.
 *
 * These numbers are what `npm run bench` measures. Changing one moves the
 * prose false-positive rate and the term recall together, so change one at a
 * time and re-run the benchmark.
 */
import { STOPLIST } from '../stoplist.js';

export const DEFAULT_MIN_CONFIDENCE = 0.82;
/** Longest token window we ever consider. */
export const MAX_WINDOW = 5;
/** Base confidence of a phonetic hit before the length penalty. */
export const PHONETIC_BASE = 0.9;
/**
 * How strongly a length mismatch reduces phonetic confidence. Double-metaphone
 * keys ignore vowels, so identical keys with a moderate length difference are
 * still the same word said differently ("coopernetties" vs "kubernetes",
 * 13 vs 10 chars). A full-strength penalty (weight 1) would push every real
 * STT mangling below the default threshold; 0.25 lets a ~35% length gap pass.
 */
export const PHONETIC_LENGTH_WEIGHT = 0.25;
/** Upper bound on distinct phonetic keys indexed per term. */
export const MAX_PHONETIC_KEYS_PER_TERM = 24;
/**
 * Shortest double-metaphone key the phonetic pass will match on. One- and
 * two-consonant keys (Zod/ST, Neon/NN, SSO/S, Vite/FT, KPI/KP) collide with
 * dozens of everyday words; on the benchmark corpus they were wrong 22 of 26 times.
 */
export const PHONETIC_MIN_KEY = 3;
/** A window shorter than this (letters only) is not phonetic-matched unless the alias is just as short. */
export const PHONETIC_MIN_WINDOW = 4;
/**
 * When the user listed explicit aliases for a term, the inexact passes are a
 * fallback and a lone token (single-token window) needs to clear a higher bar
 * than minConfidence: "prism" -> Prisma at 0.86 is wrong far more often than
 * "prizma" -> Prisma, and the latter is what the aliases are for.
 *
 * In the phonetic pass the bar applies regardless of case: phonetic confidence
 * is a length formula with no spelling evidence in it, and a capital at the
 * start of a sentence or on a proper noun is no evidence of a garble ("Inter",
 * the font, became Entire.io at 0.86). In the fuzzy pass only an all-lowercase
 * word is held to it, hyphenated compounds included ("prism", "email",
 * "per-category"): fuzzy confidence is an edit similarity, so a capitalised
 * token one edit from a listed alias ("Ashlet" / "Ashler", 0.83) is what the
 * alias was listed for. Multi-token windows keep the normal bar; STT rarely
 * splits an ordinary word into several.
 *
 * **It fires for almost no term the tools now create.** The condition is the
 * existence of explicit aliases, and `lexicon harvest` and `lexicon add
 * <Canonical>` both write `aliases: []`, so the bar is off for every term
 * either one proposes and the phonetic and fuzzy passes are that term's only
 * path rather than its fallback. Dropping the condition was measured and is
 * not taken, because the same reasoning that motivates the bar argues against
 * it here: a term with no aliases has nothing else to be reached by.
 *
 *   both passes    recall 96.5% -> 93.6%, positives 94.2% -> 91.4%, F1 95.1%
 *                  -> 93.8%, precision 93.8% -> 93.9%
 *   phonetic only  recall 96.5% -> 95.8%, F1 95.1% -> 94.8%, precision flat
 *   fuzzy only     recall 96.5% -> 95.8%, F1 95.1% -> 94.9%, precision 94.0%
 *
 * Nine positives go for one false positive ("llama" -> Ollama). The nine are
 * "doker" -> Docker, "olama's" and "ollamas" -> Ollama, "wisper" and "whispr"
 * -> Whisper, "kubernetties" -> Kubernetes, "tailwin" -> Tailwind,
 * "playwrite" -> Playwright, "metafone" -> Metaphone: every one alias-less,
 * every one a headline case, and two of them ("doker", "olama") the pair
 * PHONETIC_LONE_KEY3_MIN_SIM was tiered to keep. The prose false-positive rate
 * excluding expected-hard does not move at all (0.0% either way), and neither
 * does this repository's own markdown (47 rewrites either way). See
 * docs/MATCHING.md.
 */
export const ALIASED_PLAIN_WORD_MIN = 0.88;
/**
 * Double metaphone folds every initial vowel to "A", so "inter" and "entire"
 * share ANTR while agreeing on nothing else (similarity 0.5). A lone phonetic
 * candidate whose window or alias starts with a vowel (a e i o u y) must start
 * with the same letter (diacritics folded) or reach this edit similarity.
 * Two different initial consonants ("coopernetties" / "kubernetes") already
 * agreed on the key's first consonant and are exempt; "ashlur"/"ashlr" and
 * "hetsner"/"hetzner" start alike and never reach the check.
 */
export const PHONETIC_LONE_TOKEN_MIN_SIM = 0.6;
export const VOWEL_RE = /^[aeiouy]/;
/**
 * A lone token's metaphone key is all the phonetic evidence there is, and a
 * short key is shared by dozens of everyday words: LKS is "lacks", "locks",
 * "likes", "leaks" and "Locus"; TKR is "docker", "decor", "tucker", "taker".
 * So a single-token phonetic candidate must also look like the alias in
 * spelling, and the shorter the key the more it must: edit similarity >= 0.8
 * on a 3-consonant key ("lokus"/"locus" 0.8, "doker"/"docker" 0.83 pass;
 * "lacks"/"locus" 0.6, "tucker"/"docker" 0.67 fail) and >= 0.65 on a 4-consonant
 * key ("playwrite"/"playwright" 0.7 passes; "inter"/"entire" 0.5 fails). Five
 * or more consonants agreeing in order is spelling evidence in itself, so
 * longer keys keep only the initial-vowel guard above ("coopernetties" /
 * "kubernetes", KPRNTS, similarity 0.46, still matches). A flat key >= 4 rule
 * was measured instead and lost two headline positives ("doker" -> Docker,
 * "olama" -> Ollama, both alias-less); the tiers keep them. Multi-token windows
 * are exempt: STT rarely splits an ordinary word into several.
 */
export const PHONETIC_LONE_KEY3_MIN_SIM = 0.8;
export const PHONETIC_LONE_KEY4_MIN_SIM = 0.65;

/** Edit similarity a single-token phonetic candidate must reach for a key of the given length. */
export function loneTokenMinSim(keyLength: number): number {
  if (keyLength <= 3) return PHONETIC_LONE_KEY3_MIN_SIM;
  if (keyLength === 4) return PHONETIC_LONE_KEY4_MIN_SIM;
  return 0;
}
/**
 * Confidence of an exact hit that had to invent a word boundary the alias does
 * not have. Everything else in the exact pass stays at 1.
 *
 * The exact pass compares a window against an alias with every separator
 * stripped, so one map entry serves two very different claims. "ashlr ai" ->
 * Ashlr.AI and "next js" -> Next.js break exactly where the user's own
 * spelling breaks; the matcher is only forgiving punctuation, and those are
 * still 1. "lexicon file" -> LexiconFile and "open ai" -> OpenAI break where
 * the canonical has no separator at all: the split is read off a case hump,
 * which is a convention of written code and not a sound. That is a guess, and
 * a guess scored 1.00 is a guess `--min-confidence` cannot reach and `--diff`
 * cannot show you. See separatorOffsets in matcher/build.ts.
 *
 * 0.95 is deliberately above every inexact pass rather than near them: the
 * split is exact on every letter and digit, so it should still win a span a
 * phonetic or fuzzy candidate also wants, exactly as it does today. What
 * changes is that raising minConfidence past it now turns invented boundaries
 * off while leaving the rest of the exact pass alone, and that a split shows up
 * in --dry-run and --diff as the guess it is.
 *
 * Implicit aliases only. An alias the user listed is a string they asked to
 * have replaced, and the stoplist is already overridden for the same reason.
 *
 * This is a confidence, not a guard: it does not decide that "the lexicon file"
 * is prose and "lexicon store" is a symbol, because nothing in the text does.
 * See docs/MATCHING.md.
 */
export const INVENTED_BOUNDARY_CONFIDENCE = 0.95;

/** Domain-style suffixes stripped to derive an implicit short alias ("Ashlr.AI" -> "Ashlr"). */
export const DOMAIN_SUFFIX = /^(.{2,}?)\.(ai|io|com|dev|app|co|net|org|sh|xyz|me|so|gg)$/i;

/**
 * Built-in stoplist (src/core/stoplist.ts): common English words plus
 * everyday tech vocabulary that the phonetic/fuzzy passes must never rewrite.
 * Exact aliases the user listed explicitly still fire on these words (user
 * intent wins). Re-exported here so `STOPLIST` keeps its import path.
 */
export { STOPLIST };

/**
 * A token that carries no word sound of its own: a bare numeral ("2", "42",
 * "3.5") or an abbreviation spelled out with periods ("i.e", "e.g", "a.m").
 *
 * Phonetic confidence is a ratio of letter counts, so a numeral costs nothing
 * at all and a one- or two-letter abbreviation costs almost nothing. The
 * sliding window could take one in for free, stay above the threshold, and then
 * win overlap resolution on span length, so the number or the abbreviation was
 * swallowed by the replacement: "cooper netties i.e. Terraform" came out as
 * "Kubernetes. Terraform". A multi-token window therefore never starts or ends
 * on one in the phonetic pass.
 *
 * The test is against the alias, not against the window alone, because the
 * argument below is symmetric and the canonical side of it was missed once
 * already. A numeral contributes no letters wherever it sits, so it cannot
 * distinguish "Kubernetes 1" from "Kubernetes" either, and blocking every
 * window with a numeral at its edge blocked every phonetic garble of a term
 * whose own name ends in a version number: "clawd 4" stopped reaching
 * "Claude 4", and "cooper netties 1" was rewritten by the narrower window into
 * "Kubernetes 1 1". So the window's edge token has to be matched by one of the
 * same kind at the same end of the alias; then the wider window spans the
 * number instead of stranding it, and wins overlap resolution as it should.
 *
 * Deliberately narrow, and not the more general rule it looks like it should
 * be. Asking instead whether the extra token added anything to the window's
 * metaphone key sounds more principled and is unusable: a trailing "ai" / "io"
 * / "ay" adds nothing to a key either, so that rule loses "opin ay" -> OpenAI,
 * "vertexx ay" -> Vertex AI and "ashlur ay" -> Ashlr.AI. Reweighting the length
 * penalty cannot separate them either, because a numeral contributes zero
 * letters and so scores exactly the same as no token at all.
 *
 * Phonetic pass only. The exact pass is untouched, because "b 2 b", "auth 0"
 * and "11 labs" are aliases users really list. The fuzzy pass cannot have the
 * bug: it only compares a window against aliases of the same token count, so a
 * swallowed token moves the window into a different bucket.
 */
const NO_LETTERS_RE = /^[^\p{L}]+$/u;
const SPELLED_ABBREVIATION_RE = /^\p{L}{1,2}(?:\.\p{L}{1,2})+$/u;

export function isNonWordToken(lower: string): boolean {
  return NO_LETTERS_RE.test(lower) || SPELLED_ABBREVIATION_RE.test(lower);
}

/**
 * Function words: articles, prepositions, conjunctions, pronouns, auxiliaries,
 * wh-words. STT garbles a proper noun into sound-alike syllables; a bare
 * "to" / "is" / "a" next to it belongs to the sentence, so an inexact
 * multi-token window never starts or ends on one ("normalizeTranscript to",
 * "said to", "a grey"). Explicit aliases are unaffected. "her" is deliberately
 * absent: "-er" is the commonest word-final syllable and STT splits it off
 * ("dock her" -> Docker).
 */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set<string>(
  `
a an the
and or but nor so yet if then than because although while whether unless
at by for from in into of off on onto to with without about over under up down out through across between among
after before during until since around near above below behind beside upon toward towards via per
i me my mine you your yours he him his she hers it its we us our ours they them their theirs
this that these those who whom whose which what
am is are was were be been being do does did done have has had having
can could may might must shall should will would
not no yes there here now when where why how
`
    .split(/\s+/)
    .filter((w) => w.length > 0),
);
