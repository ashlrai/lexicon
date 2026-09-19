#!/usr/bin/env node
/**
 * Claude Code hook entry point. One file serves two events, dispatched on the
 * payload's `hook_event_name`:
 *
 * - `SessionStart`: prints the claude-md export of the merged lexicon as
 *   additionalContext (capped, see SESSION_CONTEXT_MAX_CHARS) so the model
 *   knows the user's spellings once per session even if it never reads
 *   `lexicon://me`. When the lexicon is empty it instead prints, at most once
 *   per 24 hours (state in `<config dir>/onboard-note.json`), a one-line note
 *   asking the model to offer setup; otherwise nothing.
 * - `UserPromptSubmit`: normalizes the prompt against the lexicon resolved
 *   from the payload's `cwd` and - only when something changed - prints
 *   additionalContext telling the agent which corrections to apply. When the
 *   prompt reads like a spelling correction ("it's X not Y") it adds one line
 *   asking the agent to call `learn_correction`; the hook never adds terms
 *   itself, and it does not normalize the words being corrected (see
 *   dropCorrectionSpans). The prompt is never blocked or rewritten. Usage
 *   counters (`hits`) are bumped best-effort in the background so
 *   `lexicon stats` also counts hook-only sessions.
 *
 * The hook must never fail the user's prompt: every error path prints nothing
 * and exits 0.
 */
import { promises as fs, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSummary, exportLexicon, loadLexicon, normalize, parseCorrection, recordHits, stripControlChars } from '../core/index.js';
import type { Correction, LoadedLexicon, NormalizeResult, Replacement } from '../core/index.js';

export interface HookOptions {
  /** Overrides the payload's `cwd` when resolving the project lexicon. */
  cwd?: string;
}

/** Hook events this entry point handles. Anything else is treated as UserPromptSubmit. */
export type HookEventName = 'UserPromptSubmit' | 'SessionStart';

/** Subset of the Claude Code hook payload this file reads. */
interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** UserPromptSubmit only. */
  prompt?: string;
  /** SessionStart only: startup | resume | clear | compact. */
  source?: string;
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: HookEventName;
    additionalContext: string;
  };
}

/** Upper bound for the SessionStart context; longer tables are truncated with a pointer to lexicon://me. */
export const SESSION_CONTEXT_MAX_CHARS = 4000;

/** State file (next to the global lexicon) recording when the empty-lexicon onboarding note was last emitted. */
export const ONBOARD_NOTE_FILE = 'onboard-note.json';

/** Minimum gap between two onboarding notes. */
export const ONBOARD_NOTE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What SessionStart injects when the merged lexicon has no terms (once per ONBOARD_NOTE_INTERVAL_MS). */
export const ONBOARD_NOTE =
  "The user's voice lexicon is empty. If they dictate, offer to set it up: ask for their company/product spelling and run the lexicon setup_lexicon tool (or the onboard prompt).";

/** `<dirname(globalPath)>/onboard-note.json`. */
export function onboardNotePath(globalPath: string): string {
  return join(dirname(globalPath), ONBOARD_NOTE_FILE);
}

interface OnboardNoteState {
  lastNotedAt: string;
}

/**
 * True when the onboarding note should be emitted now: no state file, an
 * unreadable one, or a `lastNotedAt` older than the interval. On true the
 * timestamp is written first (best effort, mkdir -p), so a burst of sessions
 * still produces one note. Never throws.
 */
export async function shouldEmitOnboardNote(globalPath: string, now: number = Date.now()): Promise<boolean> {
  const file = onboardNotePath(globalPath);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const last = typeof parsed === 'object' && parsed !== null ? (parsed as Partial<OnboardNoteState>).lastNotedAt : undefined;
    const lastMs = typeof last === 'string' ? Date.parse(last) : Number.NaN;
    if (Number.isFinite(lastMs) && now - lastMs < ONBOARD_NOTE_INTERVAL_MS) return false;
  } catch {
    // missing or unreadable: treat as never noted
  }
  const state: OnboardNoteState = { lastNotedAt: new Date(now).toISOString() };
  try {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(state)}\n`, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lexicon hook] onboard-note: ${message}\n`);
  }
  return true;
}

/** Builds the note handed to the agent for a changed prompt. */
export function formatAdditionalContext(result: NormalizeResult): string {
  return (
    'Voice lexicon corrections for this prompt (the user dictated; apply these):\n' +
    `${diffSummary(result)}\n` +
    'Corrected prompt:\n' +
    result.output
  );
}

/**
 * One line telling the model (and, through it, the user) that a project
 * lexicon exists but was not applied. Only the path is included; the file's
 * contents are untrusted and must never reach model context. Control and
 * invisible characters in the path are dropped (shared `stripControlChars`)
 * so it cannot break the single-line shape or smuggle an escape sequence.
 */
export function formatSkippedProjectNote(loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>): string {
  if (!loaded.skippedProject) return '';
  const safePath = stripControlChars(loaded.skippedProject.path);
  if (loaded.projectTrust === 'changed') {
    return (
      `Note: this repo's .lexicon.yaml at ${safePath} changed since the user trusted it, so it was not applied; ` +
      'the user can review it and run `lexicon trust` again to enable it.'
    );
  }
  return (
    `Note: this repo has an untrusted .lexicon.yaml at ${safePath} that was not applied; ` +
    'the user can review it and run `lexicon trust` to enable it.'
  );
}

/**
 * One line asking the agent to record a correction the user just made. The
 * hook only flags it; the agent calls `learn_correction` (and can still judge
 * that the sentence was not a correction after all). The fields are named
 * because the note is read before the tool schema is loaded, and the agent is
 * told to trim `heard` since a bare-word capture can still carry a short
 * unpunctuated tail ("versel please fix it").
 */
export function formatCorrectionNote(correction: Correction): string {
  const heard = stripControlChars(correction.heard).trim();
  const meant = stripControlChars(correction.meant).trim();
  return (
    `The user is correcting a spelling: "${heard}" should be "${meant}". ` +
    `Call the lexicon learn_correction tool with heard: "${heard}", meant: "${meant}". ` +
    `If "${heard}" contains words that are not part of the misspelled name, pass only the name. ` +
    'Then continue with the rest of the message.'
  );
}

/** Every [start, end) span at which `needle` occurs in `haystack`, case-insensitively. */
function spansOf(haystack: string, needle: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  if (!needle) return spans;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return spans;
    spans.push([at, at + needle.length]);
    from = at + needle.length;
  }
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * A correction sentence is metadata about the lexicon, not dictation to be
 * corrected: on "it's Ashlr.AI not Ashlur" the phonetic pass would otherwise
 * rewrite "Ashlur" to "Ashlr.AI" (making the corrected prompt read "it's
 * Ashlr.AI not Ashlr.AI") and bump hits for the very term the user is saying
 * was misread. Drops every replacement whose span overlaps an occurrence of
 * `heard` or `meant` in the prompt, or whose original text equals one of them,
 * and rebuilds the output from what is left. Other garbles in the same prompt
 * ("... not Ashlur. Also ping mason white") are still corrected.
 */
export function dropCorrectionSpans(result: NormalizeResult, correction: Correction): NormalizeResult {
  const input = result.input;
  const lower = input.toLowerCase();
  const sides = [collapse(correction.heard), collapse(correction.meant)].filter((s) => s !== '');
  if (sides.length === 0 || result.replacements.length === 0) return result;
  const protectedSpans = sides.flatMap((side) => spansOf(lower, side));

  const overlapsSide = (r: Replacement): boolean =>
    sides.includes(collapse(input.slice(r.start, r.end))) ||
    protectedSpans.some(([s, e]) => r.start < e && r.end > s);
  const kept = result.replacements.filter((r) => !overlapsSide(r));
  if (kept.length === result.replacements.length) return result;

  // Replacement offsets index the original input and never overlap, so a
  // single left-to-right pass rebuilds the output.
  let output = '';
  let pos = 0;
  for (const r of [...kept].sort((a, b) => a.start - b.start)) {
    output += input.slice(pos, r.start) + r.replacement;
    pos = r.end;
  }
  output += input.slice(pos);
  return { input, output, replacements: kept, changed: output !== input };
}

/**
 * Keeps a claude-md export under `max` characters by dropping table rows from
 * the end and adding a "... N more terms" line. Header and footer survive so
 * the model still gets the instructions around the table.
 */
export function truncateSessionContext(text: string, max = SESSION_CONTEXT_MAX_CHARS): string {
  if (text.length <= max) return text;
  const lines = text.split('\n');
  const sep = lines.findIndex((l) => /^\|\s*-+\s*\|/.test(l));
  if (sep === -1) return text.slice(0, Math.max(0, max - 3)) + '...';

  const header = lines.slice(0, sep + 1);
  let end = sep + 1;
  while (end < lines.length && lines[end].startsWith('|')) end += 1;
  const rows = lines.slice(sep + 1, end);
  const footer = lines.slice(end);

  const moreLine = (n: number): string => `... ${n} more term${n === 1 ? '' : 's'}; read the lexicon://me resource for the full list.`;
  const fixed = header.join('\n').length + footer.join('\n').length + moreLine(rows.length).length + 3; // 3 joining newlines
  let used = fixed;
  const kept: string[] = [];
  for (const row of rows) {
    if (used + row.length + 1 > max) break;
    used += row.length + 1;
    kept.push(row);
  }
  const dropped = rows.length - kept.length;
  const out = [...header, ...kept, moreLine(dropped), ...footer].join('\n');
  // Header + footer alone can exceed a tiny cap; the cap is the contract, so hard-cut then.
  return out.length <= max ? out : out.slice(0, Math.max(0, max - 3)) + '...';
}


/**
 * Bump `hits` for every canonical the prompt matched, without waiting for the
 * write: the hook's output must never be delayed or failed by bookkeeping.
 * recordHits is best-effort by contract; the catch only covers a mocked or
 * future implementation that rejects.
 */
function recordHitsInBackground(result: NormalizeResult, cwd: string): void {
  const canonicals = [...new Set(result.replacements.map((r) => r.canonical))];
  if (canonicals.length === 0) return;
  void recordHits(canonicals, { cwd }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lexicon hook] recordHits: ${message}\n`);
  });
}

function parseInput(raw: string): HookInput {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed as HookInput;
}

function emit(hookEventName: HookEventName, parts: readonly string[]): string {
  const output: HookOutput = {
    hookSpecificOutput: { hookEventName, additionalContext: parts.join('\n') },
  };
  return JSON.stringify(output);
}

async function userPromptSubmit(payload: HookInput, opts: HookOptions): Promise<string> {
  const prompt = payload.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') return '';

  const cwd = opts.cwd ?? payload.cwd ?? process.cwd();
  // Default loadLexicon merges the project file only when trusted; an
  // untrusted one shows up as skippedProject and is mentioned by path only.
  const loaded = await loadLexicon({ cwd });
  const skippedNote = formatSkippedProjectNote(loaded);

  const parsed = parseCorrection(prompt);
  const correction = parsed && parsed.heard.trim() !== '' && parsed.meant.trim() !== '' ? parsed : undefined;
  const correctionNote = correction ? formatCorrectionNote(correction) : '';

  let result = loaded.merged.terms.length > 0 ? normalize(prompt, loaded.merged) : undefined;
  // The words the user is correcting are not dictation: leave them alone and do not count them as hits.
  if (result && correction) result = dropCorrectionSpans(result, correction);
  const changed = result?.changed === true;
  if (result && changed) recordHitsInBackground(result, cwd);

  if (!changed && !skippedNote && !correctionNote) return '';

  const parts: string[] = [];
  if (result && changed) parts.push(formatAdditionalContext(result));
  if (correctionNote) parts.push(correctionNote);
  if (skippedNote) parts.push(skippedNote);
  return emit('UserPromptSubmit', parts);
}

async function sessionStart(payload: HookInput, opts: HookOptions): Promise<string> {
  const cwd = opts.cwd ?? payload.cwd ?? process.cwd();
  const loaded = await loadLexicon({ cwd });
  const skippedNote = formatSkippedProjectNote(loaded);

  if (loaded.merged.terms.length === 0) {
    // Nothing to inject; nudge the model to offer onboarding, but not every session.
    if (!(await shouldEmitOnboardNote(loaded.global.path))) return '';
    return emit('SessionStart', skippedNote ? [ONBOARD_NOTE, skippedNote] : [ONBOARD_NOTE]);
  }

  const parts: string[] = [truncateSessionContext(exportLexicon(loaded.merged, 'claude-md').trimEnd())];
  if (skippedNote) parts.push(skippedNote);
  return emit('SessionStart', parts);
}

/**
 * Returns the JSON string to print for the given raw stdin payload, or '' when
 * the prompt needs no corrections (printing nothing lets the prompt through untouched).
 * Kept for callers that only handle UserPromptSubmit; `runHook` dispatches on the event.
 */
export async function runUserPromptSubmitHook(input: string, opts: HookOptions = {}): Promise<string> {
  return userPromptSubmit(parseInput(input), opts);
}

/**
 * Returns the JSON string to print for a SessionStart payload: the lexicon
 * table, or the onboarding note when the lexicon is empty (at most once per
 * 24 h), or '' otherwise.
 */
export async function runSessionStartHook(input: string, opts: HookOptions = {}): Promise<string> {
  return sessionStart(parseInput(input), opts);
}

/** Dispatches on `hook_event_name`. Unknown or missing events are handled as UserPromptSubmit. */
export async function runHook(input: string, opts: HookOptions = {}): Promise<string> {
  const payload = parseInput(input);
  if (payload.hook_event_name === 'SessionStart') return sessionStart(payload, opts);
  return userPromptSubmit(payload, opts);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const out = await runHook(raw);
    if (out) process.stdout.write(out);
  } catch (err) {
    // Silent by design: a broken hook must not break the user's prompt.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lexicon hook] ${message}\n`);
  } finally {
    process.exitCode = 0;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
