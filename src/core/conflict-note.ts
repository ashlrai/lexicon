/**
 * The sentences that report a learn/add conflict (`LearnConflict`): the
 * `note` of a JSON answer and the remove command it names. Pure (no IO, no
 * node: imports) so the browser extension reuses the exact wording
 * (extension/src/core.ts); learn.ts re-exports everything here.
 */
import type { TermScope } from './types.js';

/** The term `LearnResult.conflict` names, and the spelling of `heard` it holds. */
export interface LearnConflict {
  canonical: string;
  scope: TermScope;
  /** 'alias': drop `spelling` from that term to let the correction win; 'canonical': `heard` is that term's own name. */
  as: 'alias' | 'canonical';
  /** `heard` as that term spells it. */
  spelling: string;
}

/** Who reads a `conflictNote`: `'cli'` names the `lexicon remove` command, `'mcp'` the `remove_term` call. */
export type ConflictNoteAudience = 'cli' | 'mcp';

/**
 * The `lexicon remove --alias` command that drops a conflicting alias from the
 * other term, limited to the file that holds it (`--<scope>`). `show` is
 * applied to each spelling first (a terminal sanitizer); JSON string literals
 * keep a `"` in a spelling from blurring where an argument ends.
 */
export function conflictRemoveCommand(c: LearnConflict, show: (s: string) => string = (s) => s): string {
  return `lexicon remove ${JSON.stringify(show(c.canonical))} --alias ${JSON.stringify(show(c.spelling))} --${c.scope}`;
}

/**
 * The `note` that goes with `conflict`/`conflicts` in a JSON answer (CLI
 * `learn --json` and `add --json`, MCP `add_term`, serve `POST /learn`): one
 * sentence per conflict, naming how to drop an alias from the other term if
 * the user agrees, as the `lexicon remove` command (`'cli'`, the default) or
 * the `remove_term` call (`'mcp'`); for a spelling that is another term's
 * canonical, how to remove that term. Unsanitized, like every JSON field.
 */
export function conflictNote(conflicts: readonly LearnConflict[], audience: ConflictNoteAudience = 'cli'): string {
  return conflicts
    .map((c) =>
      c.as === 'alias'
        ? `${JSON.stringify(c.spelling)} is also an alias of ${JSON.stringify(c.canonical)} (${c.scope}), so it may still be corrected to that; ` +
          (audience === 'mcp'
            ? `if the user agrees, call remove_term with canonical ${JSON.stringify(c.canonical)}, alias ${JSON.stringify(c.spelling)}, scope "${c.scope}".`
            : `if the user agrees, drop it with: ${conflictRemoveCommand(c)}`)
        : `${JSON.stringify(c.spelling)} is its own term (${c.scope}), so it may still be kept as written; ` +
          (audience === 'mcp'
            ? `if the user never means it as its own term, call remove_term with canonical ${JSON.stringify(c.canonical)}, scope "${c.scope}".`
            : `if the user never means it as its own term, drop it with: lexicon remove ${JSON.stringify(c.canonical)} --${c.scope}`),
    )
    .join(' ');
}

/**
 * The sentence `lexicon add` and MCP `add_term` give when the term already had
 * every alias, never-word and field the add gave it (`addTerm`'s
 * `unchanged`), so the answer is not read as a merge. Unsanitized.
 */
export function unchangedTermNote(canonical: string): string {
  return `Nothing was added: ${JSON.stringify(canonical)} already has every alias and field given.`;
}

/**
 * The sentence `lexicon learn` and serve `POST /learn` give for a correction
 * that wrote nothing (neither `created` nor `aliasAdded`): the "Nothing was
 * added:" lead of `unchangedTermNote` with the reason MCP learn_correction
 * gives, `heard` already an alias of the term or already its canonical in
 * another case. `heard` is trimmed and its whitespace collapsed, as
 * learnCorrection does. Unsanitized.
 */
export function learnUnchangedNote(heard: string, canonical: string): string {
  const said = heard.trim().replace(/\s+/g, ' ');
  return said.toLowerCase() === canonical.toLowerCase()
    ? `Nothing was added: ${JSON.stringify(canonical)} is already the canonical spelling; ${JSON.stringify(said)} is corrected to it.`
    : `Nothing was added: ${JSON.stringify(said)} was already an alias of ${JSON.stringify(canonical)}.`;
}
