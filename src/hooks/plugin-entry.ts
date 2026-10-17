#!/usr/bin/env node
/**
 * The plugin's hook entry point (bundled to plugin/hook.mjs): turns on Node's
 * on-disk compile cache, then loads and runs the real hook (plugin/hook-main.mjs,
 * the bundle of user-prompt-submit.ts).
 *
 * Every prompt starts a fresh `node`, and compiling the half-megabyte hook
 * bundle was a fixed 20 to 30 ms of each one. `module.enableCompileCache`
 * (Node >= 22.1) keeps V8's compiled code for it on disk, but only for modules
 * loaded after the call, which is why this stub exists and imports the bundle
 * dynamically. On older Node the call is absent and the hook runs uncached.
 *
 * The cache lives beside the global lexicon (`<dir>/node-compile-cache`, the
 * directory parse-cache.json, index-cache.json and hits.json already use), so
 * it belongs to the user and follows LEXICON_PATH / XDG_CONFIG_HOME. It is
 * never Node's default under the shared temp directory, where another local
 * user could plant entries. NODE_DISABLE_COMPILE_CACHE=1 turns it off (Node's
 * own switch). Any failure here is ignored: the hook must run regardless.
 */
import nodeModule from 'node:module';
import path from 'node:path';
import { globalLexiconPath } from '../util/xdg.js';

/** Directory name of the compile cache, beside the global lexicon. */
export const COMPILE_CACHE_DIR_NAME = 'node-compile-cache';

function enableCompileCache(): void {
  try {
    const enable = (nodeModule as { enableCompileCache?: (dir?: string) => unknown }).enableCompileCache;
    if (typeof enable !== 'function') return;
    enable(path.join(path.dirname(path.resolve(globalLexiconPath())), COMPILE_CACHE_DIR_NAME));
  } catch {
    // no cache: slower, never broken
  }
}

enableCompileCache();
// A computed specifier, so esbuild leaves the import alone instead of inlining
// the hook into this file (which would defeat the point).
const target = new URL('./hook-main.mjs', import.meta.url).href;
const hook = (await import(target)) as { main: () => Promise<void> };
await hook.main();
