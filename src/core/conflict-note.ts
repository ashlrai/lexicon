/**
 * The sentences that report a learn/add conflict (`LearnConflict`): the
 * `note` of a JSON answer and the remove command it names. Pure (no IO, no
 * node: imports) so the browser extension reuses the exact wording
 * (extension/src/core.ts); learn.ts re-exports everything here.
 */
import { commandLine, hostPlatform } from './shell.js';
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
 * applied to each spelling first (a terminal sanitizer); each word is then
 * quoted for the shell on `platform` (`commandLine`: POSIX, or PowerShell on
 * win32), so the command runs as printed even with a space, `$` or quote in a
 * spelling. A JSON string literal did not: `"$HOME Co"` expands in a shell.
 */
export function conflictRemoveCommand(c: LearnConflict, show: (s: string) => string = (s) => s, platform: string = hostPlatform()): string {
  return commandLine(['lexicon', 'remove', show(c.canonical), '--alias', show(c.spelling), `--${c.scope}`], platform);
}

/** The `lexicon remove <canonical> --<scope>` command that removes a conflicting term from one file, quoted like `conflictRemoveCommand`. */
export function conflictRemoveTermCommand(c: Pick<LearnConflict, 'canonical' | 'scope'>, platform: string = hostPlatform()): string {
  return commandLine(['lexicon', 'remove', c.canonical, `--${c.scope}`], platform);
}

/**
 * The `note` that goes with `conflict`/`conflicts` in a JSON answer (CLI
 * `learn --json` and `add --json`, MCP `add_term`, serve `POST /learn`): one
 * sentence per conflict, naming how to drop an alias from the other term if
 * the user agrees, as the `lexicon remove` command (`'cli'`, the default) or
 * the `remove_term` call (`'mcp'`); for a spelling that is another term's
 * canonical, how to remove that term. Unsanitized, like every JSON field.
 */
export function conflictNote(conflicts: readonly LearnConflict[], audience: ConflictNoteAudience = 'cli', platform: string = hostPlatform()): string {
  return conflicts
    .map((c) =>
      c.as === 'alias'
        ? `${JSON.stringify(c.spelling)} is also an alias of ${JSON.stringify(c.canonical)} (${c.scope}), so it may still be corrected to that; ` +
          (audience === 'mcp'
            ? `if the user agrees, call remove_term with canonical ${JSON.stringify(c.canonical)}, alias ${JSON.stringify(c.spelling)}, scope "${c.scope}".`
            : `if the user agrees, drop it with: ${conflictRemoveCommand(c, undefined, platform)}`)
        : `${JSON.stringify(c.spelling)} is its own term (${c.scope}), so it may still be kept as written; ` +
          (audience === 'mcp'
            ? `if the user never means it as its own term, call remove_term with canonical ${JSON.stringify(c.canonical)}, scope "${c.scope}".`
            : `if the user never means it as its own term, drop it with: ${conflictRemoveTermCommand(c, platform)}`),
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

/** What `learnUnchangedNote` knows beyond `heard` and the term's canonical. */
export interface LearnUnchangedContext {
  /** The spelling the correction asked for; with it a reversed correction is told apart (see `reversedCorrectionNote`). */
  meant?: string;
  /** The file that holds the term, named in the edit step of a reversed correction. Default `'global'`. */
  scope?: TermScope;
  /** `'cli'` (default) names `lexicon edit`, `'mcp'` the remove_term and add_term calls. */
  audience?: ConflictNoteAudience;
  /** The shell a `'cli'` command is quoted for. Default `hostPlatform()`. */
  platform?: string;
}

/** Trimmed, whitespace collapsed, as learnCorrection reads a side. */
function said(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Equal ignoring case and Unicode composition, as learnCorrection compares spellings. */
function sameSpelling(a: string, b: string): boolean {
  return said(a).toLowerCase().normalize('NFC') === said(b).toLowerCase().normalize('NFC');
}

/**
 * The sentence `lexicon learn` and serve `POST /learn` give for a correction
 * that wrote nothing (neither `created` nor `aliasAdded`): the "Nothing was
 * added:" lead of `unchangedTermNote` with the reason MCP learn_correction
 * gives, `heard` already an alias of the term or already its canonical in
 * another case. When `ctx.meant` is an alias of that term and `heard` its
 * canonical, the correction asks for the reverse of what the lexicon does:
 * `reversedCorrectionNote`. `heard` is trimmed and its whitespace collapsed,
 * as learnCorrection does. Unsanitized.
 */
export function learnUnchangedNote(heard: string, canonical: string, ctx: LearnUnchangedContext = {}): string {
  const h = said(heard);
  if (ctx.meant !== undefined && sameSpelling(h, canonical) && !sameSpelling(ctx.meant, canonical)) {
    return reversedCorrectionNote(h, ctx.meant, canonical, ctx.scope ?? 'global', ctx.audience ?? 'cli', ctx.platform);
  }
  return sameSpelling(h, canonical)
    ? `Nothing was added: ${JSON.stringify(canonical)} is already the canonical spelling; ${JSON.stringify(h)} is corrected to it.`
    : `Nothing was added: ${JSON.stringify(h)} was already an alias of ${JSON.stringify(canonical)}.`;
}

/**
 * The sentence for "it's Ashlr not ashlr.ai" when "Ashlr" is an alias of the
 * term "Ashlr.AI" (`LearnResult.reversed`): the lexicon already corrects
 * `meant` to `heard`, the other way round, and nothing was written. It said
 * `"Ashlr.AI" is already the canonical spelling`, as if the correction were
 * in place. Names how to make `meant` the canonical if that is what the user
 * wants: `lexicon edit` (`--project` for a project term) and rename the term
 * (`'cli'`), or remove_term then add_term (`'mcp'`). Unsanitized.
 */
export function reversedCorrectionNote(
  heard: string,
  meant: string,
  canonical: string,
  scope: TermScope,
  audience: ConflictNoteAudience = 'cli',
  platform: string = hostPlatform(),
): string {
  const [h, m, c] = [said(heard), said(meant), canonical].map((x) => JSON.stringify(x));
  const lead = `Nothing was added: ${m} is an alias of ${c}, so it is already corrected to ${c}, the other way round from this correction (${h} to ${m}).`;
  return audience === 'mcp'
    ? `${lead} If the user wants ${m} written instead, ask them, then make it the canonical: call remove_term with canonical ${c}, scope "${scope}", and add_term with canonical ${m}, scope "${scope}", and aliases ${c} plus the term's other aliases.`
    : `${lead} If you want ${m} written instead, make it the canonical: run ${commandLine(['lexicon', 'edit', ...(scope === 'project' ? ['--project'] : [])], platform)} and rename the term ${c} to ${m}, keeping ${c} as an alias.`;
}
