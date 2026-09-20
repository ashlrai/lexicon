/**
 * Entry point for the browser demo bundle.
 *
 * This file is NOT imported by Next directly. `scripts/build-demo-bundle.mjs`
 * runs esbuild over it and writes `lib/generated/lexicon-core.js`, which the
 * live-demo component lazy-imports. Everything re-exported here comes from the
 * real `src/core` that the CLI, the MCP server and the macOS app all use, so
 * the demo on this page and the matcher on your machine are the same code.
 *
 * Two rules for this file:
 *
 *   1. Only browser-safe modules. `store`, `harvest` and `trust` reach for
 *      `node:fs`; the build fails if a `node:` builtin survives bundling.
 *   2. No `schema.js`. It pulls in zod, which is 445 KB of the 486 KB bundle
 *      and buys nothing at runtime: the demo lexicon is a fixed file, so the
 *      build script validates it once with the real `parseLexicon` on the
 *      server and ships plain JSON. Terms a visitor adds in the browser are
 *      shape-checked by `lib/demo.ts` instead.
 */
export { DEFAULT_MIN_CONFIDENCE } from '../../src/core/matcher.js';
export { normalize } from '../../src/core/normalize.js';
export { suggestAliases } from '../../src/core/suggest.js';

/*
 * Excluded from tsconfig.json: this file is an esbuild entry point, not app
 * source. Its `../../src/core/*` imports only resolve inside the Lexicon
 * repository, and Next's type check runs on an upload of `web/` alone, where
 * they do not exist. esbuild type-checks nothing, so correctness here is
 * enforced by the build script instead: bundling fails if an export is
 * renamed, a `node:` builtin would fail the guard, and the headline demo
 * sentence is asserted against the real matcher before anything ships.
 */
