/**
 * The live demonstration: "here is what STT would have written, here is what
 * your agent sees instead". Used in two places, both of them a stranger's
 * first thirty seconds:
 *
 *   - the last step of `lexicon setup`, which takes the terms it just seeded
 *     and shows one of them being corrected, so the wizard ends in a visible
 *     win rather than a list of file paths;
 *   - `lexicon normalize "..."` run with no lexicon at all (`npx @ashlr/lexicon
 *     normalize "ping ashler"`), which falls back to DEMO_LEXICON so the
 *     cheapest possible demo of the product actually demonstrates something.
 *
 * Kept in core (not the CLI) and free of filesystem access so the same code
 * runs from src/, dist/ and the single-file plugin bundle. DEMO_LEXICON is a
 * literal rather than a read of examples/lexicon.example.yaml because that
 * directory is not in the published tarball.
 */
import { normalize } from './normalize.js';
import type { Lexicon, NormalizeResult, Term } from './types.js';

/**
 * A miniature of examples/lexicon.example.yaml: enough terms to show a
 * correction, every alias a transcription a real STT engine produces. Used
 * only when the user has no terms of their own yet, and always announced as
 * an example -- it is never written to a file and never merged into a real
 * lexicon.
 */
export const DEMO_LEXICON: Lexicon = {
  version: 1,
  terms: [
    {
      canonical: 'Ashlr.AI',
      aliases: ['Ashler', 'Ashlar', 'Ashler AI', 'Ashley our AI'],
      phonetic: 'ASH-ler',
      category: 'brand',
      notes: 'Example term. Never write "Ashlar" (that is a masonry term).',
    },
    {
      canonical: 'Kubernetes',
      aliases: ["Cooper Nettie's", 'cube or netties'],
      phonetic: 'koo-ber-NET-eez',
      category: 'product',
    },
    {
      canonical: 'PostgreSQL',
      aliases: ['postgres sequel', 'post gress', 'post gres'],
      phonetic: 'POST-gress',
      category: 'product',
    },
    {
      canonical: 'Pydantic',
      aliases: ['pie dentic', 'pie dantic'],
      phonetic: 'pie-DAN-tick',
      category: 'product',
    },
    {
      canonical: 'SaaS',
      aliases: ['sass'],
      category: 'acronym',
      never: ['sauce'],
    },
  ],
};

/** True when the lexicon has nothing the matcher could ever fire on. */
export function isEmptyLexicon(lexicon: Pick<Lexicon, 'terms'>): boolean {
  return lexicon.terms.length === 0;
}

export interface Demonstration {
  /** The sentence as speech-to-text would have written it (the "before"). */
  heard: string;
  /** The same sentence after the lexicon ran (the "after"). */
  corrected: string;
  /** The replacements that fired, for a one-line-per-change summary. */
  result: NormalizeResult;
  /** Canonicals the demonstration shows off, in the order they appear. */
  terms: string[];
  /** True when DEMO_LEXICON stood in because the user's own lexicon was empty. */
  usedExample: boolean;
}

/** Letters and digits only, lowercased: "Ashlr.AI" and "Ashlr AI" both become "ashlrai". */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The alias that makes the best demonstration of a term.
 *
 * `suggestAliases` generates both kinds: spacing and punctuation variants
 * ("Ashlr AI", "Ashlr" for "Ashlr.AI") and genuine mishearings ("Ashler",
 * "Ashlar"). Only the second kind is convincing -- watching "Ashlr" become
 * "Ashlr.AI" looks like autocorrect, watching "Ashler" become "Ashlr.AI"
 * looks like the product. So aliases whose letters are a substring of the
 * canonical's (or vice versa) are used only when nothing better exists, and
 * within each group the shortest wins, to keep the sentence readable.
 */
function demoAliasOf(term: Term): string | undefined {
  const canonical = squash(term.canonical);
  const usable = term.aliases
    .map((a) => a.trim())
    .filter((a) => a !== '' && squash(a) !== canonical && squash(a) !== '')
    .sort((a, b) => a.length - b.length);
  const distinct = usable.filter((a) => !canonical.includes(squash(a)) && !squash(a).includes(canonical));
  return distinct[0] ?? usable[0];
}

function isPerson(term: Term): boolean {
  return term.category === 'person';
}

/**
 * A sentence in the shape of something dictated at an agent, with `heard`
 * spellings spliced in where the canonical names belong. Two slots at most:
 * more than that reads as a word list rather than a sentence.
 */
function sentenceFor(person: string | undefined, thing: string | undefined): string | undefined {
  if (person && thing) return `can you ask ${person} where the ${thing} migration landed`;
  if (person) return `can you ask ${person} to take a look at this before standup`;
  if (thing) return `can you check whether the ${thing} migration landed yet`;
  return undefined;
}

/**
 * Builds a demonstration from `lexicon`: picks up to two terms that have a
 * mishearing recorded, writes a dictated-sounding sentence using those
 * mishearings, and runs the real normalizer over it.
 *
 * Returns undefined when the lexicon cannot actually demonstrate anything --
 * no terms, no aliases, or (the case worth guarding) a sentence the matcher
 * declines to correct. Callers fall back to DEMO_LEXICON rather than printing
 * a demonstration in which nothing happens: a first run that ends in "no
 * changes" is worse than no demonstration at all.
 *
 * `prefer` names canonicals to try first (the terms `lexicon setup` just
 * seeded), so the user sees their own company name corrected rather than a
 * term from a starter pack.
 */
export function buildDemonstration(
  lexicon: Lexicon,
  opts: { prefer?: readonly string[]; usedExample?: boolean } = {},
): Demonstration | undefined {
  const preferred = new Set((opts.prefer ?? []).map((c) => c.trim().toLowerCase()));
  const rank = (t: Term): number => (preferred.has(t.canonical.trim().toLowerCase()) ? 0 : 1);
  const candidates = lexicon.terms
    .filter((t) => demoAliasOf(t) !== undefined)
    .map((t, i) => ({ term: t, i }))
    .sort((a, b) => rank(a.term) - rank(b.term) || a.i - b.i)
    .map((e) => e.term);
  if (candidates.length === 0) return undefined;

  const person = candidates.find(isPerson);
  const thing = candidates.find((t) => t !== person);
  const personAlias = person ? demoAliasOf(person) : undefined;
  const thingAlias = thing ? demoAliasOf(thing) : undefined;
  const heard = sentenceFor(personAlias, thingAlias);
  if (heard === undefined) return undefined;

  // The real thing: the same normalize() the hook and the MCP tool call, over
  // the user's own lexicon and settings. Nothing here is staged.
  const result = normalize(heard, lexicon);
  if (!result.changed) return undefined;
  return {
    heard,
    corrected: result.output,
    result,
    terms: result.replacements.map((r) => r.replacement),
    usedExample: opts.usedExample ?? false,
  };
}

/**
 * `buildDemonstration` over the user's lexicon, falling back to DEMO_LEXICON
 * when their own cannot show anything yet. Always returns a demonstration:
 * the fallback lexicon is built to guarantee one.
 */
export function demonstrate(lexicon: Lexicon, prefer: readonly string[] = []): Demonstration {
  const own = buildDemonstration(lexicon, { prefer });
  if (own) return own;
  return (
    buildDemonstration(DEMO_LEXICON, { usedExample: true }) ?? {
      heard: 'ping Ashler about it',
      corrected: 'ping Ashlr.AI about it',
      result: { input: 'ping Ashler about it', output: 'ping Ashlr.AI about it', replacements: [], changed: true },
      terms: ['Ashlr.AI'],
      usedExample: true,
    }
  );
}
