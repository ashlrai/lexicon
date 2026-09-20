/**
 * Alternatives comparison: the same audio, four ways of fixing it.
 *
 * bench/audio/run.ts measures Lexicon against raw Whisper. This script answers
 * the question a reader actually has, which is how Lexicon compares to the
 * things they would otherwise reach for:
 *
 *   raw            whisper.cpp with no help at all
 *   prompt         whisper.cpp with its own --prompt hint list
 *                  (`lexicon export whisper-prompt`, canonicals only)
 *   exact          exact-string substitution over the transcript, the
 *                  macOS Text Replacement / "I'll just hand-roll it" baseline
 *   lexicon        normalize(): alias > phonetic > fuzzy, with the guardrails
 *
 * Every condition is scored on the SAME cached transcripts that
 * `npm run bench:audio` produced, so nothing is re-synthesized or
 * re-transcribed and no number here is an estimate. `raw` and `lexicon` are
 * read off the no-prompt transcripts; `prompt` is read off the transcripts
 * whisper produced when it was given the hint list. `exact` is a post-pass
 * over the no-prompt transcripts.
 *
 *   npm run bench:compare
 *   npm run bench:compare -- --models base.en
 *   npm run bench:compare -- --out /tmp/compare.md    (default: stdout only)
 *
 * Requires the transcript cache at bench/audio/out/transcripts.json, which
 * `npm run bench:audio` writes. This script never calls say(1) or whisper, and
 * never writes bench/audio/results.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportWhisperPrompt, normalize } from '../../src/core/index.js';
import type { Lexicon } from '../../src/core/types.js';
import { DEFAULT_LEXICON, loadLexicon, type BenchCategory } from '../lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SENTENCES = join(HERE, 'sentences.jsonl');
const CACHE_PATH = join(HERE, 'out', 'transcripts.json');

const DEFAULT_MODELS = ['base.en', 'small.en'];
const DEFAULT_VOICES = ['Samantha', 'Daniel', 'Karen'];

// ---------------------------------------------------------------------------
// Shared with run.ts. Kept identical on purpose so the two reports agree.
// ---------------------------------------------------------------------------

const DIACRITICS: Record<string, string> = { ø: 'o', ł: 'l', ß: 'ss', æ: 'ae', œ: 'oe', đ: 'd' };

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[øłßæœđ]/g, (ch) => DIACRITICS[ch] ?? ch);
}

function stripEdges(tok: string): string {
  return tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function tokens(s: string): string[] {
  return s
    .replace(/[‘’]/g, "'")
    .split(/\s+/)
    .map(stripEdges)
    .filter((t) => t.length > 0);
}

/** Case- and edge-punctuation-insensitive sentence key. "Ashlr AI" != "Ashlr.AI". */
function loose(s: string): string {
  return tokens(fold(s).toLowerCase()).join(' ');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

function hash8(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface Sentence {
  id: string;
  category: BenchCategory;
  expected: string;
  spoken: string;
  terms: string[];
  note?: string;
}

function loadSentences(): Sentence[] {
  return readFileSync(SENTENCES, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const c = JSON.parse(l) as Record<string, unknown>;
      return {
        id: c.id as string,
        category: c.category as BenchCategory,
        expected: c.expected as string,
        spoken: (c.spoken as string | undefined) ?? (c.expected as string),
        terms: c.terms as string[],
        ...(c.note === undefined ? {} : { note: c.note as string }),
      };
    });
}

function isHard(s: Sentence): boolean {
  return (s.note ?? '').startsWith('expected-hard');
}

interface Cache {
  version: 1;
  entries: Record<string, { heard: string; at: string }>;
}

function loadCache(): Cache {
  if (!existsSync(CACHE_PATH)) {
    throw new Error(
      `no transcript cache at ${CACHE_PATH}.\nRun \`npm run bench:audio\` once first; this script only re-scores what that produced.`,
    );
  }
  return JSON.parse(readFileSync(CACHE_PATH, 'utf8')) as Cache;
}

function cacheKey(model: string, prompt: string | undefined, voice: string, s: Sentence): string {
  const p = prompt === undefined ? 'nop' : `p:${hash8(prompt)}`;
  return `${model}|${p}|${voice}|${s.id}|${hash8(s.spoken)}`;
}

// ---------------------------------------------------------------------------
// Condition 3: exact-string substitution (the macOS Text Replacement baseline)
// ---------------------------------------------------------------------------

/**
 * What a user gets if they paste every alias in the lexicon into macOS
 * Settings > Keyboard > Text Replacement, or write the equivalent sed script:
 * a flat table of "this exact phrase becomes that one", applied on word
 * boundaries, longest phrase first, non-overlapping, one pass.
 *
 * No phonetic pass, no fuzzy pass, no confidence, no protected spans. It is
 * given exactly the same 175 aliases the matcher has, so the only difference
 * measured is the matching strategy.
 *
 * `caseInsensitive` is the generous reading, and the one reported: real Text
 * Replacement fires regardless of how the user capitalized, and the aliases in
 * bench/lexicon.yaml are written lowercase while Whisper capitalizes freely.
 * The strict reading is reported alongside it so the gap is visible.
 */
function buildExactRules(lexicon: Lexicon, includeCanonicalCasing: boolean): Array<{ alias: string; canonical: string }> {
  const rules: Array<{ alias: string; canonical: string }> = [];
  for (const term of lexicon.terms) {
    for (const alias of term.aliases ?? []) {
      if (alias.trim().length > 0) rules.push({ alias, canonical: term.canonical });
    }
    // The determined hand-roller also adds "drizzle -> Drizzle", so that a
    // recognizer that heard the word but lower-cased it still gets fixed. This
    // is where a flat table stops being free: the rule cannot tell the product
    // from the weather.
    if (includeCanonicalCasing) rules.push({ alias: term.canonical, canonical: term.canonical });
  }
  // Longest first so "Ashler AI" wins over "Ashler".
  rules.sort((a, b) => b.alias.length - a.alias.length);
  return rules;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyExact(
  text: string,
  rules: Array<{ alias: string; canonical: string }>,
  caseInsensitive: boolean,
): string {
  // Single left-to-right pass over the original text: find the earliest match
  // of any rule, emit it, continue after it. This is non-overlapping and never
  // rewrites text a previous rule already produced.
  let out = '';
  let i = 0;
  const compiled = rules.map((r) => ({
    canonical: r.canonical,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(r.alias)}(?![\\p{L}\\p{N}])`, caseInsensitive ? 'giu' : 'gu'),
  }));
  while (i < text.length) {
    let bestAt = -1;
    let bestLen = 0;
    let bestCanonical = '';
    for (const c of compiled) {
      c.re.lastIndex = i;
      const m = c.re.exec(text);
      if (!m) continue;
      if (bestAt === -1 || m.index < bestAt || (m.index === bestAt && m[0].length > bestLen)) {
        bestAt = m.index;
        bestLen = m[0].length;
        bestCanonical = c.canonical;
      }
    }
    if (bestAt === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, bestAt) + bestCanonical;
    i = bestAt + bestLen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Score {
  label: string;
  /** Whether this condition runs a post-pass over the transcript at all. */
  postProcesses: boolean;
  clips: number;
  termSlots: number;
  termHit: number;
  /** Canonicals present in the output that the sentence never asked for. */
  spurious: number;
  positives: number;
  sentenceOk: number;
  /** Non-hard negatives whose text the post-pass altered. */
  proseTotal: number;
  proseChanged: number;
  /** All negatives, hard included. */
  proseTotalAll: number;
  proseChangedAll: number;
}

interface Condition {
  label: string;
  /** undefined = read the no-prompt transcripts; string = the whisper prompt used. */
  transcriptPrompt: string | undefined;
  postProcesses: boolean;
  transform: (heard: string) => string;
}

function score(
  condition: Condition,
  sentences: Sentence[],
  voices: string[],
  model: string,
  cache: Cache,
  allCanonicals: string[],
): Score {
  const s: Score = {
    label: condition.label,
    postProcesses: condition.postProcesses,
    clips: 0,
    termSlots: 0,
    termHit: 0,
    spurious: 0,
    positives: 0,
    sentenceOk: 0,
    proseTotal: 0,
    proseChanged: 0,
    proseTotalAll: 0,
    proseChangedAll: 0,
  };

  for (const voice of voices) {
    for (const sentence of sentences) {
      const key = cacheKey(model, condition.transcriptPrompt, voice, sentence);
      const entry = cache.entries[key];
      if (!entry) throw new Error(`transcript cache miss: ${key}\nRe-run \`npm run bench:audio\` to fill it.`);
      const heard = entry.heard;
      const output = condition.transform(heard);
      s.clips++;

      const negative = sentence.terms.length === 0;
      if (negative) {
        s.proseTotalAll++;
        if (output !== heard) s.proseChangedAll++;
        if (!isHard(sentence)) {
          s.proseTotal++;
          if (output !== heard) s.proseChanged++;
        }
      } else {
        s.positives++;
        if (loose(output) === loose(sentence.expected)) s.sentenceOk++;
      }

      const want = new Set(sentence.terms);
      for (const canonical of want) {
        s.termSlots++;
        const need = Math.max(1, countOccurrences(sentence.expected, canonical));
        if (countOccurrences(output, canonical) >= need) s.termHit++;
      }
      for (const canonical of allCanonicals) {
        if (want.has(canonical)) continue;
        const before = countOccurrences(heard, canonical);
        const after = countOccurrences(output, canonical);
        if (after > before) s.spurious += after - before;
      }
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function pct(hit: number, total: number): string {
  if (total === 0) return '-';
  return `${((hit / total) * 100).toFixed(1)}% (${hit}/${total})`;
}

function table(rows: string[][]): string {
  const head = rows[0];
  const sep = head.map(() => '---');
  return [head, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  let models = DEFAULT_MODELS;
  let voices = DEFAULT_VOICES;
  let lexiconPath = DEFAULT_LEXICON;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error('missing value');
        process.exit(2);
      }
      return v;
    };
    switch (argv[i]) {
      case '--models':
        models = next().split(',').map((x) => x.trim()).filter(Boolean);
        break;
      case '--voices':
        voices = next().split(',').map((x) => x.trim()).filter(Boolean);
        break;
      case '--lexicon':
        lexiconPath = next();
        break;
      case '--out':
        out = next();
        break;
      case '--help':
      case '-h':
        console.error(
          'usage: node --import tsx bench/audio/compare.ts [--models a,b] [--voices a,b] [--lexicon f] [--out file.md]',
        );
        process.exit(2);
        break;
      default:
        console.error(`unknown option: ${argv[i]}`);
        process.exit(2);
    }
  }

  const lexicon = loadLexicon(lexiconPath);
  const sentences = loadSentences();
  const cache = loadCache();
  const whisperPrompt = exportWhisperPrompt(lexicon);
  const rules = buildExactRules(lexicon, false);
  const rulesPlusCasing = buildExactRules(lexicon, true);
  const allCanonicals = lexicon.terms.map((t) => t.canonical);

  const lines: string[] = [];
  lines.push('# Lexicon against the alternatives');
  lines.push('');
  lines.push(
    `Generated ${new Date().toISOString()} by \`npm run bench:compare\`. Every row is scored on the same cached whisper.cpp transcripts that \`npm run bench:audio\` produced, so the audio, the voices and the recognizer are identical across conditions and only the fix differs. Nothing here is estimated.`,
  );
  lines.push('');
  lines.push(
    `Corpus: ${sentences.length} sentences (${sentences.filter((s) => s.terms.length > 0).length} carrying lexicon terms, ${sentences.filter((s) => s.terms.length === 0).length} clean prose) x ${voices.length} macOS voices = ${sentences.length * voices.length} clips per condition. Lexicon: ${lexicon.terms.length} terms, ${rules.length} aliases, no \`never\` lists, default settings.`,
  );
  lines.push('');

  for (const model of models) {
    const conditions: Condition[] = [
      {
        label: 'raw whisper.cpp',
        transcriptPrompt: undefined,
        postProcesses: false,
        transform: (h) => h,
      },
      {
        label: 'whisper.cpp `--prompt`',
        transcriptPrompt: whisperPrompt,
        postProcesses: false,
        transform: (h) => h,
      },
      {
        label: 'exact substitution',
        transcriptPrompt: undefined,
        postProcesses: true,
        transform: (h) => applyExact(h, rules, true),
      },
      {
        label: 'exact substitution, case-sensitive',
        transcriptPrompt: undefined,
        postProcesses: true,
        transform: (h) => applyExact(h, rules, false),
      },
      {
        label: 'exact substitution + canonical casing rules',
        transcriptPrompt: undefined,
        postProcesses: true,
        transform: (h) => applyExact(h, rulesPlusCasing, true),
      },
      {
        label: 'Lexicon',
        transcriptPrompt: undefined,
        postProcesses: true,
        transform: (h) => normalize(h, lexicon).output,
      },
    ];

    const scores = conditions.map((c) => score(c, sentences, voices, model, cache, allCanonicals));

    lines.push(`## ${model}`);
    lines.push('');
    lines.push(
      table([
        ['condition', 'terms recovered', 'sentences exactly right', 'clean prose wrongly changed', 'spurious terms introduced'],
        ...scores.map((s) => [
          s.label,
          `**${pct(s.termHit, s.termSlots)}**`,
          pct(s.sentenceOk, s.positives),
          s.postProcesses ? pct(s.proseChanged, s.proseTotal) : 'n/a, nothing runs',
          s.postProcesses ? String(s.spurious) : 'n/a, nothing runs',
        ]),
      ]),
    );
    lines.push('');
    lines.push(
      `"Terms recovered" is term slots where the canonical spelling appears in the final text, exact and case-sensitive. "Sentences exactly right" is the loose comparison (case and edge punctuation folded, internal punctuation kept) over the ${scores[0].positives} term-carrying clips. "Clean prose wrongly changed" counts the ${scores[0].proseTotal} ordinary prose clips whose text the post-pass altered; the ${scores[0].proseTotalAll - scores[0].proseTotal} \`expected-hard\` prose clips, which are built to trip a matcher, are excluded here and counted in the next row.`,
    );
    lines.push('');
    lines.push(
      table([
        ['condition', 'clean prose wrongly changed, expected-hard included'],
        ...scores.map((s) => [
          s.label,
          s.postProcesses ? pct(s.proseChangedAll, s.proseTotalAll) : 'n/a, nothing runs',
        ]),
      ]),
    );
    lines.push('');
  }

  lines.push('## How to read the two baselines that do nothing');
  lines.push('');
  lines.push(
    'Raw whisper.cpp and `--prompt` cannot wrongly change clean prose, because neither runs a rewrite step. That is not a safety advantage, it is the absence of the feature: they also cannot fix anything after the fact. The honest comparison between those two rows and the last two is the "terms recovered" column.',
  );
  lines.push('');
  lines.push(
    '`--prompt` is not a competitor so much as a complement. It changes what whisper writes in the first place, and the two compose: `npm run bench:audio` reports Lexicon layered on top of the prompted transcripts as well.',
  );
  lines.push('');

  const report = lines.join('\n') + '\n';
  process.stdout.write(report);
  if (out) {
    writeFileSync(out, report);
    console.error(`wrote ${out}`);
  }
}

try {
  main();
} catch (err) {
  // A missing transcript cache is the expected first-run state, not a crash.
  // Print the reason and the fix, not a stack trace.
  console.error(`bench:compare: ${(err as Error).message}`);
  process.exit(1);
}
