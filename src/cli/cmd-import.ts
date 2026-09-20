/**
 * `lexicon import <file> [format]`: bring an existing dictionary (Wispr Flow,
 * Superwhisper, macOS Text Replacement, espanso, plain text, CSV, or a lexicon
 * file) into the global or project lexicon in one command. The handler lives in
 * runImport so it is unit-testable; registerImportCommands only wires commander.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import {
  IMPORT_FORMATS,
  IMPORT_FORMAT_INFO,
  addTerm,
  findTerm,
  importLexicon,
  isImportFormat,
  readLexiconFile,
  resolvePaths,
} from '../core/index.js';
import type { ImportFormat, ImportResult, Term, TermCategory, TermScope, TermSource } from '../core/index.js';
import { renderTable, safe } from './io.js';
import type { CommonOptions, IO } from './io.js';
import { readStdin } from './commands.js';

export interface ImportCliOptions extends CommonOptions {
  /** Import format; `auto` (default) sniffs the content. */
  format?: string;
  /** Write to the project lexicon instead of the global one. */
  project?: boolean;
  /** Print what would be added without writing. */
  dryRun?: boolean;
  /** `source` stamped on every imported term. Default 'import'. */
  source?: string;
  /** Category applied to imported terms that do not carry one. */
  category?: string;
  /** Print the result as JSON. */
  json?: boolean;
}

export interface ImportedTermReport {
  canonical: string;
  aliases: string[];
  /** true when the term did not exist in the target lexicon before. */
  created: boolean;
}

export interface ImportReport {
  format: ImportResult['format'];
  scope: TermScope;
  path?: string;
  dryRun: boolean;
  terms: ImportedTermReport[];
  skipped: ImportResult['skipped'];
  counts: { total: number; created: number; merged: number; skipped: number };
}

const SOURCES: readonly TermSource[] = ['user', 'harvest:repo', 'harvest:git', 'harvest:package', 'import', 'learned'];
const CATEGORIES: readonly TermCategory[] = ['brand', 'person', 'product', 'acronym', 'identifier', 'place', 'other'];

function parseSource(value: string | undefined): TermSource | undefined {
  if (value === undefined) return undefined;
  if (!(SOURCES as readonly string[]).includes(value)) {
    throw new Error(`unknown source "${value}" (expected one of: ${SOURCES.join(', ')})`);
  }
  return value as TermSource;
}

function parseCategory(value: string | undefined): TermCategory | undefined {
  if (value === undefined) return undefined;
  const lower = value.toLowerCase();
  if (!(CATEGORIES as readonly string[]).includes(lower)) {
    throw new Error(`unknown category "${value}" (expected one of: ${CATEGORIES.join(', ')})`);
  }
  return lower as TermCategory;
}

function formatList(): string {
  return renderTable(
    IMPORT_FORMATS.map((f) => [f, IMPORT_FORMAT_INFO[f].description]),
    ['format', 'description'],
  );
}

/**
 * Largest input `lexicon import` will read. Every importer is linear, but the
 * input is arbitrary and is parsed in memory; a real dictionary export is a
 * few hundred KB at most.
 */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;

function tooLarge(what: string, bytes?: number): Error {
  const size = bytes === undefined ? 'exceeds' : `is ${bytes} bytes, over`;
  return new Error(`${what} ${size} the ${MAX_IMPORT_BYTES} byte (${MAX_IMPORT_BYTES / (1024 * 1024)} MB) import limit`);
}

/** Read the input file, or stdin when `file` is `-`. Refuses inputs over MAX_IMPORT_BYTES before reading them whole. */
async function defaultReadInput(file: string, cwd: string): Promise<string> {
  if (file === '-') {
    try {
      return await readStdin(MAX_IMPORT_BYTES);
    } catch (err) {
      if (err instanceof Error && /byte limit/.test(err.message)) throw tooLarge('stdin');
      throw err;
    }
  }
  const resolved = path.resolve(cwd, file);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) throw new Error(`expected a file, got a directory: ${resolved}`);
    if (stat.size > MAX_IMPORT_BYTES) throw tooLarge(resolved, stat.size);
    return await fs.readFile(resolved, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error(`file not found: ${resolved}`);
    if (code === 'EISDIR') throw new Error(`expected a file, got a directory: ${resolved}`);
    throw err;
  }
}

export async function runImport(
  file: string,
  opts: ImportCliOptions,
  io: IO,
  readInput: (file: string, cwd: string) => Promise<string> = defaultReadInput,
): Promise<number> {
  const format = opts.format ?? 'auto';
  if (!isImportFormat(format)) {
    io.stderr(`lexicon: unknown import format "${safe(format)}"\n`);
    io.stderr(formatList());
    return 1;
  }
  const source = parseSource(opts.source);
  const category = parseCategory(opts.category);
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const scope: TermScope = opts.project ? 'project' : 'global';
  const dryRun = opts.dryRun ?? false;

  const content = await readInput(file, cwd);
  // defaultReadInput already refuses oversized files/stdin; check again here so
  // an injected reader (tests, embedding) cannot bypass the cap before parsing.
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_IMPORT_BYTES) throw tooLarge(file === '-' ? 'stdin' : file, bytes);
  const result = importLexicon(content, format as ImportFormat, {
    ...(source ? { source } : {}),
    ...(file !== '-' ? { filename: path.basename(file) } : {}),
  });
  if (category) {
    for (const term of result.terms) term.category ??= category;
  }

  const report: ImportReport = {
    format: result.format,
    scope,
    dryRun,
    terms: [],
    skipped: result.skipped,
    counts: { total: result.terms.length, created: 0, merged: 0, skipped: result.skipped.length },
  };

  if (dryRun) {
    // Preview against the target file so "new" vs "merge" is accurate without writing.
    const paths = resolvePaths({ cwd });
    const target = scope === 'project' ? paths.project : paths.global;
    const existing = target ? (await readLexiconFile(target, scope)).lexicon : undefined;
    if (target) report.path = target;
    for (const term of result.terms) {
      const created = !existing || findTerm(existing, term.canonical) === undefined;
      report.terms.push({ canonical: term.canonical, aliases: term.aliases, created });
    }
  } else {
    for (const term of result.terms) {
      const added = await addTerm(term as Term, { scope, cwd });
      report.path ??= added.file.path;
      report.terms.push({ canonical: added.term.canonical, aliases: added.term.aliases, created: added.created });
    }
  }
  report.counts.created = report.terms.filter((t) => t.created).length;
  report.counts.merged = report.terms.length - report.counts.created;

  if (opts.json) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report, io);
  }
  return 0;
}

function printReport(report: ImportReport, io: IO): void {
  const { counts } = report;
  if (report.terms.length > 0) {
    const rows = report.terms.map((t) => [
      t.canonical,
      t.aliases.length > 0 ? t.aliases.join(', ') : '(none)',
      t.created ? 'new' : 'merged',
    ]);
    io.stdout(renderTable(rows, ['canonical', 'aliases', 'status']));
  }
  const where = report.path ? ` into ${report.scope} lexicon ${safe(report.path)}` : '';
  const summary = `imported ${counts.total} terms (${counts.created} new, ${counts.merged} merged, ${counts.skipped} skipped)`;
  if (report.dryRun) {
    io.stdout(`dry run (${report.format}): would have ${summary}${where}\n`);
  } else if (counts.total === 0) {
    io.stdout(`nothing to import (${report.format}): ${summary}\n`);
  } else {
    io.stdout(`${summary}${where} [${report.format}]\n`);
  }
  for (const s of report.skipped) {
    io.stderr(`lexicon: skipped line ${s.line}: ${safe(s.reason)}\n`);
  }
}

export function registerImportCommands(program: Command, io: IO): void {
  program
    .command('import')
    .description('import an existing dictionary (Wispr Flow, Superwhisper, macOS, espanso, text, csv, json) into the lexicon')
    .argument('<file>', 'file to import, or - for stdin')
    .argument('[format]', `one of: ${IMPORT_FORMATS.join(', ')} (default: auto)`)
    .option('--format <format>', 'same as the positional format argument')
    .option('--project', 'write to the project lexicon instead of the global one')
    .option('--dry-run', 'print what would be added without writing')
    .option('--source <source>', 'source recorded on each term (default: import)')
    .option('--category <category>', 'category applied to imported terms that lack one')
    .option('--json', 'print the result as JSON')
    .action(async (file: string, formatArg: string | undefined, opts: ImportCliOptions) => {
      const { cwd } = program.opts<{ cwd?: string }>();
      const merged: ImportCliOptions = {
        ...opts,
        ...(formatArg !== undefined ? { format: formatArg } : {}),
        ...(cwd ? { cwd } : {}),
      };
      const code = await runImport(file, merged, io);
      if (code !== 0) process.exitCode = code;
    });
}
