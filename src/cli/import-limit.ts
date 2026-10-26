/**
 * Largest input `lexicon import` will read. Every importer is linear, but the
 * input is arbitrary and is parsed in memory; a real dictionary export is a
 * few hundred KB at most. Split out of cmd-import.ts so the MCP tool schema
 * can name the cap without loading the importer.
 */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
