/**
 * Public API of the lexicon core. Everything the MCP server, CLI, hooks and daemon
 * use is re-exported from here. Keep this the only cross-module import path.
 */
export * from './types.js';
export * from './schema.js';
export * from './store.js';
export * from './edit-check.js';
export * from './trust.js';
export * from './matcher.js';
// The score an exact match with an invented word break gets; normalize_transcript's minConfidence description names it.
export { INVENTED_BOUNDARY_CONFIDENCE } from './matcher/tuning.js';
// The ranges `skipCode` leaves alone; the prompt hook reads no correction out of them.
export { codeSpanRanges, collectRanges } from './matcher/tokenize.js';
export * from './normalize.js';
export { compareText } from './collate.js';
export * from './harvest.js';
export * from './import-sources.js';
export * from './import-preview.js';
export * from './exporters/index.js';
export * from './importers/index.js';
export * from './suggest.js';
export * from './learn.js';
export * from './pending.js';
export * from './stats.js';
export * from './notes.js';
export * from './suggestTerms.js';
export * from './packs.js';
export * from './registry.js';
export * from './demo.js';
export * from './shell.js';
// Discovery contract is dependency-light and shared with HTTP API consumers.
export { ServerInfoSchema, SERVER_FEATURES } from '../serve/info.js';
export type { ServerInfoResponse } from '../serve/info.js';
