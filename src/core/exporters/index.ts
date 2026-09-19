/**
 * Export the lexicon to the formats other tools understand (Wispr Flow,
 * Superwhisper, Whisper prompt, macOS text replacement, CLAUDE.md, ...).
 */
import type { ExportFormat, ExportOptions, Lexicon, Term } from '../types.js';
import { exportAssemblyai } from './assemblyai.js';
import { exportAzure } from './azure.js';
import { exportClaudeMd } from './claudeMd.js';
import { exportCsv } from './csv.js';
import { exportDeepgram } from './deepgram.js';
import { exportEspanso } from './espanso.js';
import { exportGoogle } from './google.js';
import { exportJson } from './json.js';
import { exportMacos } from './macos.js';
import { exportMarkdown } from './markdown.js';
import { exportOpenai } from './openai.js';
import { sortByImportance } from './shared.js';
import { exportSuperwhisper } from './superwhisper.js';
import { exportText } from './text.js';
import { exportWhisperPrompt } from './whisperPrompt.js';
import { exportWispr } from './wispr.js';

export {
  exportAssemblyai,
  exportAzure,
  exportClaudeMd,
  exportCsv,
  exportDeepgram,
  exportEspanso,
  exportGoogle,
  exportJson,
  exportMacos,
  exportMarkdown,
  exportOpenai,
  exportSuperwhisper,
  exportText,
  exportWhisperPrompt,
  exportWispr,
};

export const EXPORT_FORMATS: readonly ExportFormat[] = [
  'wispr',
  'superwhisper',
  'whisper-prompt',
  'macos',
  'claude-md',
  'csv',
  'json',
  'deepgram',
  'espanso',
  'assemblyai',
  'azure',
  'google',
  'openai',
  'text',
  'markdown',
];

export const EXPORT_FORMAT_INFO: Record<ExportFormat, { description: string; ext: string }> = {
  'wispr': { description: 'Wispr Flow dictionary CSV', ext: 'csv' },
  'superwhisper': { description: 'Superwhisper replacements JSON', ext: 'json' },
  'whisper-prompt': { description: 'Whisper initial_prompt line', ext: 'txt' },
  'macos': { description: 'macOS Text Replacement plist', ext: 'plist' },
  'claude-md': { description: 'Markdown snippet for CLAUDE.md / system prompt', ext: 'md' },
  'csv': { description: 'Generic canonical,alias CSV', ext: 'csv' },
  'json': { description: 'Raw lexicon JSON', ext: 'json' },
  'deepgram': { description: 'Deepgram keywords with boost', ext: 'json' },
  'espanso': { description: 'espanso match YAML', ext: 'yml' },
  'assemblyai': { description: 'AssemblyAI word_boost JSON', ext: 'json' },
  'azure': { description: 'Azure Speech phraseList JSON', ext: 'json' },
  'google': { description: 'Google Speech-to-Text adaptation phraseSets JSON', ext: 'json' },
  'openai': { description: 'OpenAI transcription `prompt` field (one line, <= 100 terms)', ext: 'txt' },
  'text': { description: 'Plain text, one "Canonical: alias1, alias2" per line (round-trips with `lexicon import`)', ext: 'txt' },
  'markdown': { description: 'Markdown bullet list for READMEs and wikis', ext: 'md' },
};

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

const EXPORTERS: Record<ExportFormat, (lexicon: Lexicon, opts: ExportOptions) => string> = {
  'wispr': exportWispr,
  'superwhisper': exportSuperwhisper,
  'whisper-prompt': exportWhisperPrompt,
  'macos': exportMacos,
  'claude-md': exportClaudeMd,
  'csv': exportCsv,
  'json': exportJson,
  'deepgram': exportDeepgram,
  'espanso': exportEspanso,
  'assemblyai': exportAssemblyai,
  'azure': exportAzure,
  'google': exportGoogle,
  'openai': exportOpenai,
  'text': exportText,
  'markdown': exportMarkdown,
};

export function exportLexicon(lexicon: Lexicon, format: ExportFormat, opts: ExportOptions = {}): string {
  const exporter = EXPORTERS[format];
  if (!exporter) {
    throw new Error(`Unknown export format "${format}". Known: ${EXPORT_FORMATS.join(', ')}`);
  }
  return exporter(applyOptions(lexicon, opts), opts);
}

/**
 * Apply the category filter and term cap before dispatching. The cap keeps the
 * most important terms (hits desc, proper nouns first) but preserves the
 * lexicon's original term order afterwards so per-format sorting is unaffected.
 */
function applyOptions(lexicon: Lexicon, opts: ExportOptions): Lexicon {
  let terms: Term[] = lexicon.terms;
  if (opts.categories && opts.categories.length > 0) {
    const allowed = new Set(opts.categories);
    terms = terms.filter((t) => t.category !== undefined && allowed.has(t.category));
  }
  if (opts.limit !== undefined && terms.length > opts.limit) {
    const keep = new Set(sortByImportance(terms).slice(0, Math.max(0, opts.limit)));
    terms = terms.filter((t) => keep.has(t));
  }
  if (terms === lexicon.terms) return lexicon;
  return { ...lexicon, terms };
}
