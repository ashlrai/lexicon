/**
 * Registers import-trace-hook.mjs. The trace file is LEXICON_IMPORT_TRACE.
 * Pass this module to node as `--import`.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('./import-trace-hook.mjs', import.meta.url), {
  parentURL: import.meta.url,
  data: { file: process.env.LEXICON_IMPORT_TRACE },
});
