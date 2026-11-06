/**
 * Syntactic rule layer: passive voice and dangling pronouns. Pure functions,
 * no IO.
 *
 * Ported from Pellucid's spaCy-backed detectors (apps/api/app/detectors/
 * spacy_rules.py). spaCy cannot run in this dependency-free TypeScript core,
 * so POS tagging is approximated: sentence splitting is boundary-regex based,
 * passive voice matches be/get auxiliaries plus a participle lexicon and -ed/
 * -en morphology, and the pronoun check estimates noun counts in the previous
 * sentence from capitalization, plural and noun-suffix morphology and a small
 * requirements-domain noun glossary. Findings carry the same types,
 * severities and confidences as the original detectors; the tests pin the
 * contract on requirement-style prose.
 */
import type { AmbiguityFinding, Span } from './types.js';
import { SOURCE_RULES } from './types.js';

export interface Sentence extends Span {
  /** The sentence's text with outer whitespace trimmed off the span. */
  text: string;
}

/**
 * Split text into sentence spans with offsets.
 *
 * A boundary is a run of [.!?] followed by end-of-text, a newline, or
 * whitespace before a capital, digit, quote or list marker. Newlines always
 * split so bulleted requirement lists are one sentence per line. A period
 * followed by a lowercase word ("etc. the next") does not split, which keeps
 * abbreviations like i.e./e.g. from fragmenting a sentence in the common case.
 */
export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const boundary = /[.!?]+(?=\s*(?:[A-Z0-9"'“‘(\[*#>-]|$))|\n+/g;
  let start = 0;
  for (let m = boundary.exec(text); m !== null; m = boundary.exec(text)) {
    pushSentence(sentences, text, start, m.index + m[0].length);
    start = m.index + m[0].length;
  }
  pushSentence(sentences, text, start, text.length);
  return sentences;
}

function pushSentence(out: Sentence[], doc: string, start: number, end: number): void {
  const raw = doc.slice(start, end);
  const lead = raw.match(/^\s+/);
  const trail = raw.match(/\s+$/);
  const s = start + (lead ? lead[0].length : 0);
  const e = end - (trail ? trail[0].length : 0);
  if (e > s) out.push({ start: s, end: e, text: doc.slice(s, e) });
}

// ---------------------------------------------------------------------------
// Passive voice
// ---------------------------------------------------------------------------

const AUX = '(?:is|are|was|were|be|been|being|get|gets|got|gotten|getting)';

/**
 * Irregular and -en past participles that -ed morphology misses. Compiled
 * into a single alternation for speed.
 */
const IRREGULAR_PARTICIPLES =
  'known|given|taken|eaten|beaten|bitten|mistaken|shaken|woven|proven|swollen|fallen|gotten|hewn|mown|sewn|sown|blown|flown|made|done|seen|written|built|sent|met|held|kept|left|lost|put|set|shut|split|spread|told|thought|brought|caught|taught|bought|found|bound|fed|led|read|said|sold|shown|grown|thrown|drawn|driven|chosen|frozen|hidden|ridden|risen|stolen|sworn|torn|worn|broken|spoken|woken|forgotten|forbidden|understood|overcome|undertaken|begun|run|won|sung|swum|paid|laid|dealt|felt|heard|meant|stood|struck|spent|lent|slept|lit|fit|quit|rid|bet|broadcast|cost|cut|hit|hurt|let|upset|shed|thrust|burst|cast|undone|rebuilt|rerun|resold|rewritten|overwritten|withstood';

/**
 * -ed words that are not passive complements: high-frequency adjectives,
 * adverbs ("indeed") and color nouns that would otherwise false-positive.
 */
const PARTICIPLE_EXCLUSIONS = new Set([
  'red', 'bed', 'wed', 'naked', 'wicked', 'beloved', 'aged', 'sacred', 'indeed',
  'hundred', 'kindred', 'hatred', 'rugged', 'jagged', 'dogged', 'wretched',
  'crooked', 'ragged',
]);

/**
 * be/get auxiliary, up to two intervening words of any kind (adverb stacking:
 * "is also silently dropped", "was once thought"), then a participle: an
 * -ed word not on the exclusion list, or a known irregular/-en participle.
 * A generic -en suffix is deliberately not a participle: "then", "when",
 * "often" and friends false-positive constantly.
 */
const PASSIVE_RE = new RegExp(
  `\\b${AUX}\\s+(?:[\\w'-]+\\s+){0,2}(\\w{3,}ed|${IRREGULAR_PARTICIPLES})\\b`,
  'gi',
);

/**
 * Flag sentences containing a passive construction (be/get + past participle).
 * spaCy's nsubjpass/auxpass check is approximated by the aux + participle
 * pattern above; adverb stacking ("must be carefully reviewed") is allowed
 * between them. One finding per sentence, matching Pellucid.
 */
export function findPassiveVoice(text: string): AmbiguityFinding[] {
  const results: AmbiguityFinding[] = [];
  for (const sent of splitSentences(text)) {
    PASSIVE_RE.lastIndex = 0;
    for (let m = PASSIVE_RE.exec(sent.text); m !== null; m = PASSIVE_RE.exec(sent.text)) {
      const participle = m[1].toLowerCase();
      if (!PARTICIPLE_EXCLUSIONS.has(participle)) {
        results.push({
          start: sent.start,
          end: sent.end,
          text: sent.text,
          type: 'passive_voice',
          severity: 'medium',
          rationale:
            'Passive voice obscures the actor - rewrite to name who or what performs the action.',
          confidence: 0.7,
          source: SOURCE_RULES,
        });
        break;
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Dangling pronouns
// ---------------------------------------------------------------------------

const OPENER_PRONOUNS = new Set(['it', 'they', 'this', 'these', 'that', 'those']);
const DETERMINER_PRONOUNS = new Set(['this', 'that', 'these', 'those']);

/**
 * Words that after this/that/these/those mean the pronoun is standalone, not a
 * determiner: "This is required" is a pronoun; "This document is" is a
 * determiner+noun and is skipped.
 */
const VERBISH_NEXT = new Set(
  `
is are was were be been being will would shall should may might must can could
do does did has have had needs seems appears remains becomes gets proves means
requires allows provides takes makes keeps shows gives holds stays turns looks
feels sounds works fails breaks stands sits runs goes comes falls grows
not never only just also even still
`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Closed-class words that never count as a nominal antecedent. Determiners,
 * pronouns, prepositions, conjunctions, auxiliaries/modals, quantifiers and
 * particles; extends past a pure function-word list to include common
 * requirement-prose adverbs so the nominal estimate stays meaningful.
 */
const CLOSED_CLASS = new Set(
  `
a an the and or but nor so yet if then than because although while whether
unless as at by for from in into of off on onto to with without about over
under up down out through across between among after before during until
since around near above below behind beside upon toward towards via per
i me my mine you your yours he him his she hers it its we us our ours they
them their theirs this that these those who whom whose which what there here
now when where why how am is are was were be been being do does did done have
has had having can could may might must shall should will would not no yes
all any both each every few more most other some such only own same very just
also even still rather quite too enough once again ever never always often
sometimes usually typically generally normally possibly probably really etc
per each via vs etcetera within onto upon amongst amid amidst
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Verb/-adjective morphology that disqualifies a token as a nominal. */
const NON_NOMINAL_RE = /(?:ing|ed|ify|ize|ise|ly)$/i;

/**
 * After one of these the next token is in verb position ("shall process",
 * "is handled", "not configured") and does not count as a nominal. Modals
 * and auxiliaries only: 'to' is more often a preposition ("to Memcache")
 * than an infinitive marker, and 'no' is a determiner ("no devices").
 */
const VERB_POSITION_PREV = new Set(
  'shall should will would can could may might must is are was were be been being do does did has have had not'.split(' '),
);

/**
 * After one of these the next token is almost always nominal: determiners
 * and possessives ("the requests", "its state", "each device"). This is the
 * main non-glossary source of noun evidence without a POS tagger.
 */
const DETERMINER_PREV = new Set(
  'the a an this that these those each every its their our your his her my no any some such'.split(' '),
);

/** Noun morphology: suffixes that mark a token as probably nominal. */
const NOUN_SUFFIX_RE =
  /(?:tion|sion|ment|ness|ity|acy|ence|ance|ancy|ency|ery|ary|ory|ure|age|ism|ist|dom|ship|hood|ics|th|um|ix|ie|y)s?$/i;

/**
 * Requirements-domain nouns, singular and plural forms both, with no
 * giveaway morphology. The main noun evidence besides determiner-adjacent
 * words, noun suffixes and mid-sentence capitals.
 */
const DOMAIN_NOUNS = new Set(
  `
system systems user users data datum server servers client clients service
services module modules component components interface interfaces application
applications app apps document documents record records file files process
processes network networks database databases table tables schema schemas
message messages event events error errors warning warnings state states
status value values field fields key keys token tokens credential credentials
session sessions request requests response responses endpoint endpoints api
apis payload payloads function functions method methods object objects class
classes type types instance instances attribute attributes parameter
parameters argument arguments variable variables constant constants index
indices item items entry entries list lists array arrays map maps set sets
queue queues stack stacks cache caches buffer buffers stream streams socket
sockets packet packets frame frames signal signals channel channels port
ports device devices driver drivers sensor sensors actuator actuators motor
motors engine engines machine machines vehicle vehicles robot robots drone
drones controller controllers processor processors memory disk disks drive
drives volume volumes partition partitions backup backups snapshot snapshots
replica replicas node nodes cluster clusters container containers pod pods
worker workers job jobs task tasks thread threads lock locks batch batches
schedule schedules timer timers alarm alarms alert alerts notification
notifications dashboard dashboards metric metrics monitor monitors report
reports log logs audit audits trace traces span spans policy policies rule
rules role roles permission permissions account accounts profile profiles
tenant tenants organization organizations workspace workspaces project
projects repository repositories build builds deploy deploys release releases
version versions package packages library libraries dependency dependencies
pipeline pipelines workflow workflows step steps stage stages gate gates
check checks test tests spec specs requirement requirements acceptance
contract contracts agreement agreements invoice invoices payment payments
subscription subscriptions plan plans tier tiers feature features flag flags
experiment experiments risk risks incident incidents outage outages breach
breaches threat threats vulnerability vulnerabilities patch patches control
controls compliance safety security privacy latency throughput bandwidth
availability reliability scalability performance efficiency quality capacity
configuration configurations config configs setting settings option options
parameter parameters mode modes level levels limit limits threshold
thresholds rate rates window windows interval intervals timeout timeouts
deadline deadlines duration durations delay delays frequency frequencies
rate rates amount amounts number numbers count counts total totals range
ranges maximum minimum average averages percent percentage percentages
name names label labels title titles description descriptions note notes
comment comments tag tags category categories group groups team teams member
members owner owners admin admins operator operators stakeholder stakeholders
manager managers reviewer reviewers approver approvers author authors editor
editors viewer viewers guest guests customer customers vendor vendors partner
partners supplier suppliers manufacturer manufacturers operator operators
product products platform platforms tool tools framework frameworks model
models agent agents detector detectors analyzer analyzers engine engines
`
    .split(/\s+/)
    .filter(Boolean),
);

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Count likely nouns in a sentence. Used as the antecedent-count heuristic
 * where spaCy counted NOUN/PROPN tokens. POS-free approximation: a token is
 * nominal when it is capitalized mid-sentence, a glossary word, noun-suffixed,
 * or follows a determiner - unless it is closed-class, verb-shaped, or sits
 * in verb position right after a modal/auxiliary/ 'to'.
 */
export function estimateNominalCount(sentence: string): number {
  let count = 0;
  let prev = '';
  let first = true;
  for (const m of sentence.matchAll(WORD_RE)) {
    const word = m[0];
    const lower = word.toLowerCase();
    const wasFirst = first;
    first = false;
    const nominal =
      !CLOSED_CLASS.has(lower) &&
      !NON_NOMINAL_RE.test(lower) &&
      !VERB_POSITION_PREV.has(prev) &&
      ((/^\p{Lu}/u.test(word) && !wasFirst) ||
        DOMAIN_NOUNS.has(lower) ||
        NOUN_SUFFIX_RE.test(lower) ||
        DETERMINER_PREV.has(prev));
    if (nominal) count += 1;
    prev = lower;
  }
  return count;
}

/**
 * Flag sentences that open with it/they/this/these/that/those and have no
 * unambiguous antecedent. Port of Pellucid's heuristic: skip determiner uses
 * ("this document"), flag sentence-initial position, otherwise flag when the
 * previous sentence holds zero or more than two plausible nominals.
 */
export function findDanglingPronouns(text: string): AmbiguityFinding[] {
  const results: AmbiguityFinding[] = [];
  const sentences = splitSentences(text);
  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const first = WORD_RE.exec(sent.text);
    WORD_RE.lastIndex = 0;
    if (!first) continue;
    const pronoun = first[0].toLowerCase();
    if (!OPENER_PRONOUNS.has(pronoun)) continue;

    // Determiner use: 'this report shall ...' names its referent.
    if (DETERMINER_PRONOUNS.has(pronoun)) {
      const rest = sent.text.slice(first.index + first[0].length);
      const next = WORD_RE.exec(rest);
      WORD_RE.lastIndex = 0;
      if (next && !VERBISH_NEXT.has(next[0].toLowerCase()) && !/^(?:to|of|for|in|on|at|by|and|or|that|which)\b/i.test(next[0])) {
        continue;
      }
    }

    if (i === 0) {
      results.push(pronounFinding(sent, pronoun));
      continue;
    }
    const nominals = estimateNominalCount(sentences[i - 1].text);
    if (nominals === 0 || nominals > 2) {
      results.push(pronounFinding(sent, pronoun));
    }
  }
  return results;
}

function pronounFinding(sent: Sentence, pronoun: string): AmbiguityFinding {
  return {
    start: sent.start,
    end: sent.end,
    text: sent.text,
    type: 'pronoun_antecedent',
    severity: 'medium',
    rationale: `Pronoun '${pronoun}' opens this sentence with no unambiguous antecedent - name the referent explicitly.`,
    confidence: 0.65,
    source: SOURCE_RULES,
  };
}
