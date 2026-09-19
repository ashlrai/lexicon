#!/usr/bin/env node
/**
 * Claude Code `UserPromptSubmit` hook.
 *
 * Reads the hook payload from stdin, normalizes the prompt against the lexicon
 * resolved from the payload's `cwd`, and - only when something changed - prints
 * additionalContext telling the agent which corrections to apply. The prompt is
 * never blocked or rewritten; the agent receives the original prompt plus a note.
 *
 * The hook must never fail the user's prompt: every error path prints nothing
 * and exits 0.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSummary, loadLexicon, normalize } from '../core/index.js';
import type { LoadedLexicon, NormalizeResult } from '../core/index.js';

export interface HookOptions {
  /** Overrides the payload's `cwd` when resolving the project lexicon. */
  cwd?: string;
}

/** Subset of the Claude Code UserPromptSubmit payload this hook reads. */
interface UserPromptSubmitInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  prompt?: string;
}

interface UserPromptSubmitOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
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
 * contents are untrusted and must never reach model context. Control
 * characters in the path are dropped so it cannot break the single-line shape.
 */
export function formatSkippedProjectNote(loaded: Pick<LoadedLexicon, 'projectTrust' | 'skippedProject'>): string {
  if (!loaded.skippedProject) return '';
  // eslint-disable-next-line no-control-regex
  const safePath = loaded.skippedProject.path.replace(/[\u0000-\u001F\u007F]/g, '');
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

function parseInput(raw: string): UserPromptSubmitInput {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object') return {};
  return parsed as UserPromptSubmitInput;
}

/**
 * Returns the JSON string to print for the given raw stdin payload, or '' when
 * the prompt needs no corrections (printing nothing lets the prompt through untouched).
 */
export async function runUserPromptSubmitHook(input: string, opts: HookOptions = {}): Promise<string> {
  const payload = parseInput(input);
  const prompt = payload.prompt;
  if (typeof prompt !== 'string' || prompt.trim() === '') return '';

  const cwd = opts.cwd ?? payload.cwd ?? process.cwd();
  // Default loadLexicon merges the project file only when trusted; an
  // untrusted one shows up as skippedProject and is mentioned by path only.
  const loaded = await loadLexicon({ cwd });
  const skippedNote = formatSkippedProjectNote(loaded);

  const result = loaded.merged.terms.length > 0 ? normalize(prompt, loaded.merged) : undefined;
  const changed = result?.changed === true;
  if (!changed && !skippedNote) return '';

  const parts: string[] = [];
  if (result && changed) parts.push(formatAdditionalContext(result));
  if (skippedNote) parts.push(skippedNote);

  const output: UserPromptSubmitOutput = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parts.join('\n'),
    },
  };
  return JSON.stringify(output);
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
    const out = await runUserPromptSubmitHook(raw);
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
