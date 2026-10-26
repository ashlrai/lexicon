#!/usr/bin/env node
/**
 * `lexicon` CLI. A lone --version / -V / -v is answered here, before commander
 * or the lexicon core load. Everything else is ./run.ts.
 */
import { packageVersion } from '../util/package.js';

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V' || args[0] === '-v')) {
  process.stdout.write(`${packageVersion(import.meta.url)}\n`);
  process.exit(0);
}

await import('./run.js');
