#!/usr/bin/env node
/**
 * `lexicon` CLI. A lone --version / -V / -v is answered here, before commander
 * or the lexicon core load. Read commands try the resident daemon first;
 * fallback and all other commands use ./run.ts.
 */
import { packageVersion } from '../util/package.js';

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === '--version' || args[0] === '-V' || args[0] === '-v')) {
  process.stdout.write(`${packageVersion(import.meta.url)}\n`);
  process.exit(0);
}

const { isFastRead, tryFastRead } = await import('../daemon/fast-client.js');
const result = isFastRead(args) ? await tryFastRead(args) : undefined;
if (result) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
} else {
  await import('./run.js');
}
