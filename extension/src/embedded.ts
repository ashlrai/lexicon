/**
 * The embedded engine: the same core matcher the CLI uses, fed from the YAML
 * in extension storage. Compiles and caches by YAML text; the matcher index
 * is built on the first normalize after a change and reused until the next
 * one, and every call stops matching after EMBEDDED_MATCH_BUDGET_MS.
 *
 * Everything from src/core comes through ./core.js so the build can keep it
 * in one shared chunk (extension/dist/core.js) instead of inlining it here.
 */
import {
  buildIndex,
  emptyLexicon,
  isMap,
  isSeq,
  LIMITS,
  normalizeWithIndex,
  parseDocument,
  parseLexicon,
  parseYaml,
  stringifyYaml,
} from './core.js';
import type { Lexicon, MatcherIndex, NormalizeResult } from './core.js';
import { errorMessage } from './shared.js';

export type Compiled = { lexicon: Lexicon; error: null } | { lexicon: null; error: string };

export function compileYaml(text: string): Compiled {
  try {
    const raw: unknown = parseYaml(text, { prettyErrors: true });
    return { lexicon: parseLexicon(raw), error: null };
  } catch (err) {
    return { lexicon: null, error: errorMessage(err) };
  }
}

export interface EmbeddedEngine {
  /** Re-point at new YAML; returns the compile error, if any. */
  load(yaml: string): string | null;
  lexicon(): Lexicon;
  error(): string | null;
  termCount(): number;
  normalize(text: string, dryRun?: boolean): NormalizeResult;
}

/**
 * How long one embedded normalize may spend matching before it returns the
 * corrections found so far: the hook's shouldStop budget, for the background
 * worker. A content script waits on the reply before the send goes through,
 * so a 1 MB paste against a large lexicon must not hold it for seconds.
 */
export const EMBEDDED_MATCH_BUDGET_MS = 250;

export interface EmbeddedOptions {
  /** Matching budget per normalize, in ms. Default EMBEDDED_MATCH_BUDGET_MS. */
  budgetMs?: number;
  /** Clock for the budget (tests). Default performance.now. */
  now?: () => number;
}

export function createEmbedded(initialYaml: string, opts: EmbeddedOptions = {}): EmbeddedEngine {
  const budgetMs = opts.budgetMs ?? EMBEDDED_MATCH_BUDGET_MS;
  const now = opts.now ?? (() => performance.now());
  let yaml = '';
  let compiled: Compiled = { lexicon: emptyLexicon(), error: null };
  // Built from `compiled` on first use, dropped whenever the YAML changes.
  let index: MatcherIndex | null = null;
  let loaded = false;
  const load = (text: string): string | null => {
    // A broken YAML is cached too: the same text gives the same error.
    if (loaded && text === yaml) return compiled.error;
    loaded = true;
    yaml = text;
    compiled = compileYaml(text);
    index = null;
    return compiled.error;
  };
  load(initialYaml);
  return {
    load,
    lexicon: () => compiled.lexicon ?? emptyLexicon(),
    error: () => compiled.error,
    termCount: () => compiled.lexicon?.terms.length ?? 0,
    normalize: (text, dryRun) => {
      index ??= buildIndex(compiled.lexicon ?? emptyLexicon());
      const started = now();
      return normalizeWithIndex(text, index, { dryRun, shouldStop: () => now() - started >= budgetMs });
    },
  };
}

/** Serialize a lexicon fetched from the API back to YAML for the embedded editor. */
export function lexiconToYaml(lexicon: Lexicon): string {
  const header = [
    '# Synced from the local lexicon API (lexicon serve).',
    '# Edit here to use it while the server is down; "Sync" overwrites this file.',
    '',
  ].join('\n');
  return header + stringifyYaml(lexicon, { lineWidth: 0 });
}

export interface LearnOutcome {
  yaml: string;
  message: string;
}

/**
 * "It's <meant> not <heard>": add `heard` as an alias of the term whose
 * canonical is `meant` (case-insensitive), or create a `source: learned`
 * term. Edits the YAML document in place so comments survive.
 */
export function learnIntoYaml(yaml: string, heard: string, meant: string): LearnOutcome {
  const heardT = heard.trim();
  const meantT = meant.trim();
  if (!heardT || !meantT) throw new Error('Both the heard and the meant spelling are required.');
  if (heardT.length > LIMITS.word || meantT.length > LIMITS.word) {
    throw new Error(`Each spelling must be at most ${LIMITS.word} characters.`);
  }
  if (heardT.toLowerCase() === meantT.toLowerCase()) {
    throw new Error('The heard and meant spellings are the same.');
  }

  let doc = parseDocument(yaml.trim() ? yaml : 'version: 1\nterms: []\n');
  if (doc.errors.length) throw new Error(`Embedded YAML does not parse: ${doc.errors[0].message}`);
  if (!isMap(doc.contents)) doc = parseDocument('version: 1\nterms: []\n');
  if (!doc.has('version')) doc.set('version', 1);
  if (!isSeq(doc.get('terms', true))) doc.set('terms', []);
  const terms = doc.get('terms', true);
  if (!isSeq(terms)) throw new Error('Embedded YAML: terms is not a list.');

  for (const item of terms.items) {
    if (!isMap(item)) continue;
    const canonical = String(item.get('canonical') ?? '');
    if (canonical.toLowerCase() !== meantT.toLowerCase()) continue;
    if (!isSeq(item.get('aliases', true))) item.set('aliases', []);
    const aliases = item.get('aliases', true);
    if (!isSeq(aliases)) break;
    const existing = aliases.items.map((a) => String((a as { value?: unknown }).value ?? a).toLowerCase());
    if (existing.includes(heardT.toLowerCase())) {
      return { yaml: String(doc), message: `"${heardT}" is already an alias of ${canonical}.` };
    }
    if (aliases.items.length >= LIMITS.aliases) throw new Error(`${canonical} already has ${LIMITS.aliases} aliases.`);
    aliases.add(heardT);
    const out = String(doc);
    compileOrThrow(out);
    return { yaml: out, message: `Added "${heardT}" as an alias of ${canonical}.` };
  }

  if (terms.items.length >= LIMITS.terms) throw new Error(`The embedded lexicon already has ${LIMITS.terms} terms.`);
  terms.add(doc.createNode({ canonical: meantT, aliases: [heardT], source: 'learned' }));
  const out = String(doc);
  compileOrThrow(out);
  return { yaml: out, message: `Added new term ${meantT} with alias "${heardT}".` };
}

function compileOrThrow(yaml: string): void {
  const c = compileYaml(yaml);
  if (c.error) throw new Error(c.error);
}
