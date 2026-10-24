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
import * as z from 'zod';
import { TERM_CATEGORIES, TERM_SCOPES, TERM_SOURCES } from './types.js';
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

/**
 * Code units no lexicon file can carry: U+FFFE and U+FFFF (XML 1.0 forbids
 * them even as character references, so the macos plist cannot hold one) and
 * a surrogate that is not half of a pair (no UTF-8 file can hold it; the YAML
 * written back would be unreadable). Not control or invisible characters, so
 * neither CONTROL_RE nor INVISIBLE_RE caught them. A pair (an emoji) is fine.
 */
const UNENCODABLE_RE = /[\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNENCODABLE_RE_G = new RegExp(UNENCODABLE_RE.source, 'g');

/** Why `findUnencodableChar` refuses what it finds, for error messages. */
export const UNENCODABLE_NOTE = 'U+FFFE, U+FFFF and unpaired surrogates fit no file format';

/**
 * The first U+FFFE, U+FFFF or unpaired surrogate in `s`, as `U+XXXX`, or
 * undefined when there is none. The schema refuses every free-text field
 * that holds one.
 */
export function findUnencodableChar(s: string): string | undefined {
  const m = UNENCODABLE_RE.exec(s);
  return m ? `U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : undefined;
}

function unencodableMessage(found: string): string {
  return `must not contain ${found} (${UNENCODABLE_NOTE})`;
}

/** `s` with each unencodable code unit written as `\uXXXX`, cut to 40 characters, for naming a term in an error. */
function showTermName(s: string): string {
  const shown = s.replace(UNENCODABLE_RE_G, (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  return shown.length > 40 ? `${shown.slice(0, 39)}\u2026` : shown;
}

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
  return sanitizeForDisplayMax(s, DISPLAY_MAX_CHARS);
}

/**
 * `sanitizeForDisplay` with its own cap of `max` code points, for text whose
 * tail matters (an error naming a long file path). A separate function, not
 * an optional parameter, so `.map(sanitizeForDisplay)` cannot read the array
 * index as the cap.
 */
export function sanitizeForDisplayMax(s: string, max: number): string {
  const clean = stripControlChars(s.replace(ANSI_RE, '')).replace(OTHER_RE, '');
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}\u2026`;
}

/**
 * Replace `<` and `>` with the single angle quotation marks U+2039 and U+203A,
 * which read the same to a person but cannot open or close a tag. For text
 * that is handed to a model as context (the hook's additionalContext, the MCP
 * `lexicon://me` resource and `voice-context` prompt): a trusted project
 * lexicon or an installed pack could otherwise put `</system-reminder>` or a
 * fake `<system>` block into what the model reads as its own framing. Never
 * applied to exporter output a user pastes into a file. Line structure is not
 * touched; see `neutralizeForModel` for single-line fields.
 */
export function neutralizeMarkup(s: string): string {
  return s.replace(/[<>]/g, (c) => (c === '<' ? '\u2039' : '\u203A'));
}

/**
 * `stripControlChars` then `neutralizeMarkup`: one line of lexicon- or
 * path-derived text that is safe to embed in model context. No cap; callers
 * that need one apply it.
 */
export function neutralizeForModel(s: string): string {
  return neutralizeMarkup(stripControlChars(s));
}

/** Longest path `pathForModel` returns (ellipsis included). */
export const MODEL_PATH_MAX_CHARS = 120;

/**
 * A file path as it may appear in model context: display-sanitized
 * (`sanitizeForDisplayMax`, no cap), `neutralizeMarkup`, then shortened to its
 * last three components (two directories and the file name) behind `\u2026/`
 * when it has more, and cut to its last `max` characters behind `\u2026` when
 * still longer. The directory a repository is cloned into is named by whoever
 * published it, so without a cap a path could carry kilobytes of instructions
 * into the hook's skipped-project note. The full path is for the human: the
 * CLI prints it on stderr and `lexicon trust` shows it.
 */
export function pathForModel(p: string, max: number = MODEL_PATH_MAX_CHARS): string {
  const clean = neutralizeMarkup(sanitizeForDisplayMax(p, Number.POSITIVE_INFINITY));
  const parts = clean.split(/[\\/]/).filter((part) => part !== '');
  let out = clean;
  if (parts.length > 3) {
    const sep = clean.lastIndexOf('\\') > clean.lastIndexOf('/') ? '\\' : '/';
    out = `\u2026${sep}${parts.slice(-3).join(sep)}`;
  }
  const chars = Array.from(out);
  if (chars.length <= max) return out;
  return `\u2026${chars.slice(chars.length - Math.max(0, max - 1)).join('')}`;
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

function NonEmptyWord() {
  return z
    .string()
    .transform((s) => stripInvisible(s).trim())
    .pipe(
      z
        .string()
        .min(1, 'must not be empty')
        .max(LIMITS.word, `must be at most ${LIMITS.word} characters`)
        .refine((s) => !hasControlChars(s), 'must not contain control characters or newlines'),
    );
}

/**
 * A list of strings: invisible chars stripped, trimmed, empties removed, then
 * each entry validated as a word and the list capped.
 */
function WordList(maxItems: number, what: string) {
  return CleanWordList(z.array(z.string()).default([]), maxItems, what);
}

/**
 * An optional word list (`never`, `protectedWords`, `packs`): absent stays
 * absent. It used to share WordList's `.default([])`, so every term read from
 * a file came back with `never: []` while a term `addTerm` had just written
 * had no `never` key, and list/learn/add --json and the MCP results showed
 * the two shapes side by side.
 */
function OptionalWordList(maxItems: number, what: string, checkUnencodable = false) {
  return CleanWordList(z.array(z.string()), maxItems, what, checkUnencodable).optional();
}

/**
 * `checkUnencodable` refuses U+FFFE, U+FFFF and unpaired surrogates per
 * entry; a term's lists leave it off because `buildTerm` checks them with
 * the term's name in the message.
 */
function CleanWordList<T extends z.ZodType<string[] | undefined, unknown>>(list: T, maxItems: number, what: string, checkUnencodable = false) {
  const word = z
    .string()
    .max(LIMITS.word, `must be at most ${LIMITS.word} characters`)
    .refine((s) => !hasControlChars(s), 'must not contain control characters or newlines');
  return list
    .transform((list) => (list ?? []).map((s) => stripInvisible(s).trim()).filter((s) => s.length > 0))
    .pipe(
      z
        .array(
          checkUnencodable
            ? word.superRefine((s, ctx) => {
                const found = findUnencodableChar(s);
                if (found) ctx.addIssue({ code: 'custom', message: unencodableMessage(found) });
              })
            : word,
        )
        .max(maxItems, `at most ${maxItems} ${what}`),
    );
}

/** The free-text fields of a term `buildTerm` checks for unencodable characters. */
const TERM_TEXT_FIELDS = ['canonical', 'aliases', 'never', 'phonetic', 'notes', 'createdAt'] as const;

/**
 * Refuse U+FFFE, U+FFFF and unpaired surrogates in any of a term's free-text
 * fields, at that field's path, naming the term. A term-level check rather
 * than a field-level one so the message can say which term: a path such as
 * `terms[812].aliases[3]` alone left a hand editor counting entries.
 */
function refuseUnencodable(term: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const name = typeof term.canonical === 'string' ? showTermName(term.canonical) : '';
  for (const field of TERM_TEXT_FIELDS) {
    const value = term[field];
    const entries: Array<[string, (string | number)[]]> = Array.isArray(value)
      ? value.map((v, i) => [String(v), [field, i]])
      : typeof value === 'string'
        ? [[value, [field]]]
        : [];
    for (const [text, at] of entries) {
      const found = findUnencodableChar(text);
      if (found) ctx.addIssue({ code: 'custom', path: at, message: `${unencodableMessage(found)} in term "${name}"` });
    }
  }
}

/**
 * The schemas are built on first use rather than at import. Constructing them
 * is the costliest thing this module does (10 to 20 ms in a cold process), and
 * the prompt hook, which reads its lexicon from parse-cache.json, usually never
 * validates anything. The exported constants below still exist for every other
 * caller; they are marked pure so a bundle that never reads them (the hook)
 * drops them and keeps only the lazy path through `parseLexicon`.
 */
interface Schemas {
  category: ReturnType<typeof buildCategory>;
  scope: ReturnType<typeof buildScope>;
  source: ReturnType<typeof buildSource>;
  term: ReturnType<typeof buildTerm>;
  settings: ReturnType<typeof buildSettings>;
  lexicon: ReturnType<typeof buildLexicon>;
}

const buildCategory = () => z.enum(TERM_CATEGORIES);
const buildScope = () => z.enum(TERM_SCOPES);
const buildSource = () => z.enum(TERM_SOURCES);

/**
 * Drop every key of `raw` that is not in `keep` and holds null, so a key left
 * empty in hand-edited YAML (`terms:`, `aliases:`, `never:`, `settings:`
 * with nothing after them, which YAML reads as null) parses as if it were
 * left out: `aliases` and `terms` come back `[]`, the optional ones stay
 * absent, as round 72's shapes have them. Without this one emptied line
 * failed the whole file ("expected array, received null") and with it every
 * command, tool and prompt. `keep` names the required keys, whose null is
 * still an error (a term with `canonical:` empty is not a term). A null
 * entry inside a list is still an error too.
 */
function nullKeysAsAbsent(keep: readonly string[]): (raw: unknown) => unknown {
  return (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    let out: Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(raw)) {
      if (value !== null || keep.includes(key)) continue;
      out ??= { ...(raw as Record<string, unknown>) };
      delete out[key];
    }
    return out ?? raw;
  };
}

function buildTerm(category: ReturnType<typeof buildCategory>, scope: ReturnType<typeof buildScope>, source: ReturnType<typeof buildSource>) {
  return z.preprocess(nullKeysAsAbsent(['canonical']), z.object({
    canonical: NonEmptyWord(),
    aliases: WordList(LIMITS.aliases, 'aliases per term'),
    phonetic: SafeString(LIMITS.text).optional(),
    category: category.optional(),
    caseSensitive: z.boolean().optional(),
    scope: scope.optional(),
    source: source.optional(),
    notes: SafeString(LIMITS.text).optional(),
    // Not shown to models, but it round-trips through the file: same sanitising as the other strings.
    createdAt: SafeString(64).optional(),
    // Still accepted on the way in, and still written back out, because project
    // lexicons committed before hits moved to the per-user sidecar carry it and
    // rewriting somebody's tracked file to drop a field is not this parser's
    // call. Only `writeLexiconFile` decides what a project file may gain: see
    // `pinProjectHits` in store.ts.
    hits: z.number().int().nonnegative().optional(),
    never: OptionalWordList(LIMITS.aliases, 'never words per term'),
  }).superRefine(refuseUnencodable));
}

function buildSettings() {
  return z.preprocess(nullKeysAsAbsent([]), z.object({
    minConfidence: z.number().min(0).max(1).optional(),
    phonetic: z.boolean().optional(),
    fuzzy: z.boolean().optional(),
    protectedWords: OptionalWordList(LIMITS.protectedWords, 'protected words', true),
    skipCode: z.boolean().optional(),
    packs: OptionalWordList(LIMITS.aliases, 'packs', true),
  }));
}

function buildLexicon(term: ReturnType<typeof buildTerm>, settings: ReturnType<typeof buildSettings>) {
  return z.preprocess(
    nullKeysAsAbsent([]),
    z.object({
      version: z.literal(1).default(1),
      terms: z.array(term).max(LIMITS.terms, `at most ${LIMITS.terms} terms`).default([]),
      settings: settings.optional(),
    }),
  );
}

let built: Schemas | undefined;

function schemas(): Schemas {
  if (built) return built;
  const category = buildCategory();
  const scope = buildScope();
  const source = buildSource();
  const term = buildTerm(category, scope, source);
  const settings = buildSettings();
  built = { category, scope, source, term, settings, lexicon: buildLexicon(term, settings) };
  return built;
}

export const TermCategorySchema = /* @__PURE__ */ (() => schemas().category)();

export const TermScopeSchema = /* @__PURE__ */ (() => schemas().scope)();

export const TermSourceSchema = /* @__PURE__ */ (() => schemas().source)();

export const TermSchema = /* @__PURE__ */ (() => schemas().term)();

export const LexiconSettingsSchema = /* @__PURE__ */ (() => schemas().settings)();

export const LexiconSchema = /* @__PURE__ */ (() => schemas().lexicon)();

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
 * Problems `parseLexicon` lists before it counts the rest. A file with
 * thousands of bad entries made a message of hundreds of kilobytes, which
 * every CLI command printed and every MCP tool, resource and prompt returned
 * to the agent.
 */
export const MAX_LISTED_ISSUES = 20;

/**
 * Parse an unknown value (typically YAML/JSON output) into a Lexicon.
 * Throws an Error whose message lists the problems with their field paths
 * (the first MAX_LISTED_ISSUES, then a count of the rest), e.g.
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
  const result = schemas().lexicon.safeParse(raw);
  if (!result.success) {
    const { issues } = result.error;
    const lines = issues.slice(0, MAX_LISTED_ISSUES).map((issue) => `  - ${formatPath(issue.path)}: ${issue.message}`);
    const rest = issues.length - MAX_LISTED_ISSUES;
    if (rest > 0) lines.push(`  - ... and ${rest} more problem${rest === 1 ? '' : 's'} like these`);
    throw new Error(`Invalid lexicon:\n${lines.join('\n')}`);
  }
  const lexicon: Lexicon = result.data;
  return lexicon;
}

export function emptyLexicon(): Lexicon {
  return { version: 1, terms: [] };
}
