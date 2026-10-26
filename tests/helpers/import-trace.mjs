/**
 * Registers the import trace. The trace file is LEXICON_IMPORT_TRACE.
 * Pass this module to node as `--import`.
 *
 * `module.register()` is DEP0205-deprecated on Node 26 and its warning lands
 * on the child's stderr, where a startup test reads it as CLI output.
 * `registerHooks` runs the hook in-thread on Node >= 22.15/23.5; older
 * runtimes keep the worker file, which also owns the resolve hook.
 */
import { appendFileSync } from 'node:fs';
import * as mod from 'node:module';

const file = process.env.LEXICON_IMPORT_TRACE;

if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier);
      if (file && resolved.url) appendFileSync(file, `${resolved.url}\n`);
      return resolved;
    },
  });
} else {
  mod.register(new URL('./import-trace-hook.mjs', import.meta.url), {
    parentURL: import.meta.url,
    data: { file },
  });
}
