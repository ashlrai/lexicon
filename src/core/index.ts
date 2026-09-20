/**
 * Public API of the lexicon core. Everything the MCP server, CLI, hooks and daemon
 * use is re-exported from here. Keep this the only cross-module import path.
 */
export * from './types.js';
export * from './schema.js';
export * from './store.js';
export * from './trust.js';
export * from './matcher.js';
export * from './normalize.js';
export * from './harvest.js';
export * from './exporters/index.js';
export * from './importers/index.js';
export * from './suggest.js';
export * from './learn.js';
export * from './stats.js';
export * from './suggestTerms.js';
export * from './packs.js';
export * from './demo.js';
