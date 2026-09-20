/**
 * zod v4 schemas mirroring types.ts, plus a tolerant parser with readable errors.
 *
 * Parsing is deliberately lenient about *shape* (unknown keys are stripped,
 * `version` defaults to 1, aliases are trimmed and empties dropped) but strict
 * about *values* (canonical must be non-empty, minConfidence in 0..1, ...).
 * Lexicon files are hand-edited YAML; being forgiving about extra keys keeps a
 * stray field from bricking the whole hook.
 *
 * Hardening: lexicon content ends up in model context (hook additionalContext,
 * lexicon://me) and is untrusted input even when the file is trusted, because
 * of typos, merges and copy-paste. So every free-text field is length-capped
 * and must not contain control characters, and invisible characters that are
 * used to hide instructions (zero-width, bidi overrides, BOM) are stripped
 * rather than rejected. See SECURITY.md.
 */
import { z } from 'zod';
import type { Lexicon } from './types.js';

// ---------------------------------------------------------------------------
// Limits (exported so tests and docs can reference the same numbers)
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Max characters in a canonical or alias. */
  word: 80,
  /** Max characters in notes / phonetic. */
  text: 200,
  /** Max aliases (and `never` words) per term. */
  aliases: 64,
  /** Max terms per file. */
  terms: 5000,
  /** Max protectedWords in settings. */
  protectedWords: 1000,
} as const;

/**
 * Invisible characters that are stripped: zero-width space/non-joiner/joiner
 * and directional marks (U+200B-U+200F), bidi embedding/override controls
 * (U+202A-U+202E), bidi isolates (U+2066-U+2069) and the BOM / zero-width
 * no-break space (U+FEFF).
 */
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * C0 controls (including tab, newline, carriage return), DEL, C1 controls
 * (including U+0085 NEL), and the Unicode LINE SEPARATOR (U+2028) and
 * PARAGRAPH SEPARATOR (U+2029): terminals, markdown renderers and models all
 * treat the last two as line breaks, so they could smuggle a second "line" of
 * instructions into a field that is rendered as one table cell.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE_G = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

/**
 * Whole ANSI escape sequences, so a display string does not keep the visible
 * tail (`[31m`, `]0;title`) of a sequence whose ESC byte was dropped:
 * CSI (`ESC [ params final`), OSC (`ESC ] ... BEL|ST`) and any other
 * two-byte `ESC x` sequence. An unterminated OSC loses just its ESC (via
 * CONTROL_RE_G afterwards) so it cannot swallow the rest of the line.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/**
 * Everything Unicode files under "Other" (`\p{C}`): controls (Cc), format
 * characters (Cf: soft hyphen, zero-width joiners, tag characters, ...),
 * surrogates (Cs), private-use (Co) and unassigned (Cn) code points. None of
 * them has a visible glyph a user could check.
 */
const OTHER_RE = /\p{C}/gu;

/** Longest string `sanitizeForDisplay` returns (ellipsis included). */
export const DISPLAY_MAX_CHARS = 200;

export function stripInvisible(s: string): string {
  return s.replace(INVISIBLE_RE, '');
}

export function hasControlChars(s: string): boolean {
  return CONTROL_RE.test(s);
}

/**
 * Remove every control character (C0 including CR/LF/tab, DEL, C1 including
 * NEL, U+2028/U+2029) and every invisible character `stripInvisible` knows.
 * The shape-preserving sanitizer: nothing is truncated, so a single-line
 * message stays single-line and keeps every printable character.
 */
export function stripControlChars(s: string): string {
  return stripInvisible(s.replace(CONTROL_RE_G, ''));
}

/**
 * Make a string safe to print on a terminal: strips whole ANSI escape
 * sequences (CSI/OSC/two-byte), then `stripControlChars`, then every remaining
 * `\p{C}` code point (format, private-use, surrogate, unassigned), and caps
 * the result at `DISPLAY_MAX_CHARS` code points with a trailing ellipsis.
 * Use it on any path or lexicon-derived text that ends up in CLI output: a
 * hostile `.lexicon.yaml` or directory name must not be able to recolour the
 * terminal, set its title or hide text behind a cursor move.
 */
export function sanitizeForDisplay(s: string): string {
  const clean = stripControlChars(s.replace(ANSI_RE, '')).replace(OTHER_RE, '');
  const chars = Array.from(clean);
  if (chars.length <= DISPLAY_MAX_CHARS) return clean;
  return `${chars.slice(0, DISPLAY_MAX_CHARS - 1).join('')}\u2026`;
}

/** A trimmed string with invisible characters removed, no control characters, at most `max` chars. */
function SafeString(max: number) {
  return z
    .string()
    .transform((s) => stripInvisible(s).trim())
    .pipe(
      z
        .string()
        .max(max, `must be at most ${max} characters`)
        .refine((s) => !hasControlChars(s), 'must not contain control characters or newlines'),
    );
}

const NonEmptyWord = z
  .string()
  .transform((s) => stripInvisible(s).trim())
  .pipe(
    z
      .string()
      .min(1, 'must not be empty')
      .max(LIMITS.word, `must be at most ${LIMITS.word} characters`)
      .refine((s) => !hasControlChars(s), 'must not contain control characters or newlines'),
  );

/**
 * A list of strings: invisible chars stripped, trimmed, empties removed, then
 * each entry validated as a word and the list capped.
 */
function WordList(maxItems: number, what: string) {
  return z
    .array(z.string())
    .default([])
    .transform((list) => list.map((s) => stripInvisible(s).trim()).filter((s) => s.length > 0))
    .pipe(
      z
        .array(
          z
            .string()
            .max(LIMITS.word, `must be at most ${LIMITS.word} characters`)
            .refine((s) => !hasControlChars(s), 'must not contain control characters or newlines'),
        )
        .max(maxItems, `at most ${maxItems} ${what}`),
    );
}

export const TermCategorySchema = z.enum([
  'brand',
  'person',
  'product',
  'acronym',
  'identifier',
  'place',
  'other',
]);

export const TermScopeSchema = z.enum(['global', 'project']);

export const TermSourceSchema = z.enum([
  'user',
  'harvest:repo',
  'harvest:git',
  'harvest:package',
  'import',
  'learned',
  'pack',
]);

export const TermSchema = z.object({
  canonical: NonEmptyWord,
  aliases: WordList(LIMITS.aliases, 'aliases per term'),
  phonetic: SafeString(LIMITS.text).optional(),
  category: TermCategorySchema.optional(),
  caseSensitive: z.boolean().optional(),
  scope: TermScopeSchema.optional(),
  source: TermSourceSchema.optional(),
  notes: SafeString(LIMITS.text).optional(),
  // Not shown to models, but it round-trips through the file: same sanitising as the other strings.
  createdAt: SafeString(64).optional(),
  hits: z.number().int().nonnegative().optional(),
  never: WordList(LIMITS.aliases, 'never words per term').optional(),
});

export const LexiconSettingsSchema = z.object({
  minConfidence: z.number().min(0).max(1).optional(),
  phonetic: z.boolean().optional(),
  fuzzy: z.boolean().optional(),
  protectedWords: WordList(LIMITS.protectedWords, 'protected words').optional(),
  skipCode: z.boolean().optional(),
  packs: WordList(LIMITS.aliases, 'packs').optional(),
});

export const LexiconSchema = z.object({
  version: z.literal(1).default(1),
  terms: z.array(TermSchema).max(LIMITS.terms, `at most ${LIMITS.terms} terms`).default([]),
  settings: LexiconSettingsSchema.optional(),
});

/** Render a zod path like `terms[2].aliases[0]`. */
function formatPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/**
 * Parse an unknown value (typically YAML/JSON output) into a Lexicon.
 * Throws an Error whose message lists every problem with its field path, e.g.
 *
 *   Invalid lexicon:
 *     - terms[0].canonical: must not be empty
 *     - settings.minConfidence: Too big: expected number to be <=1
 */
export function parseLexicon(raw: unknown): Lexicon {
  if (raw === null || raw === undefined) {
    // An empty YAML file parses to null; treat it as an empty lexicon.
    return emptyLexicon();
  }
  if (typeof raw !== 'object') {
    throw new Error(`Invalid lexicon: expected an object, received ${typeof raw}`);
  }
  const result = LexiconSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${formatPath(issue.path)}: ${issue.message}`,
    );
    throw new Error(`Invalid lexicon:\n${lines.join('\n')}`);
  }
  const lexicon: Lexicon = result.data;
  return lexicon;
}

export function emptyLexicon(): Lexicon {
  return { version: 1, terms: [] };
}
