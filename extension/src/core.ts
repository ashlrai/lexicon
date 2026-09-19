/**
 * Entry for extension/dist/core.js: the browser-safe slice of src/core that
 * the background worker and options page import at runtime (ESM). Built by
 * scripts/build-extension.mjs; the build fails if a node: builtin slips in.
 */
export { normalize, diffSummary } from '../../src/core/normalize.js';
export { parseLexicon, emptyLexicon, LIMITS } from '../../src/core/schema.js';
export { suggestAliases } from '../../src/core/suggest.js';
export { DEFAULT_MIN_CONFIDENCE } from '../../src/core/matcher.js';
export { isMap, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml';
export type { Lexicon, NormalizeResult, Replacement, Term } from '../../src/core/types.js';
