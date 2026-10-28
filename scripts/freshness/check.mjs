#!/usr/bin/env node
/**
 * The read-only half of `fresh:sync`: regenerate every `fresh:` block in
 * memory and report the ones whose committed content differs. Exits 1 on any
 * stale block or malformed marker, so CI (or a release step) can call
 * `npm run fresh:check` the way the `docs` job calls `check:facts`.
 *
 * Usage:
 *   node scripts/freshness/check.mjs [--root DIR] [--verbose] [--list]
 *
 *   --root DIR   check a tree other than this repository (fixtures, tests)
 *   --verbose    also print the blocks that are in sync
 *   --list       print the known block names and exit
 */
import { blockNames, parseArgs, planFreshness } from './lib.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2), ['--verbose', '--list']);
} catch (err) {
  console.error(`fresh:check: ${err.message}`);
  process.exit(2);
}

if (opts.help) {
  console.log('usage: node scripts/freshness/check.mjs [--root DIR] [--verbose] [--list]');
  process.exit(0);
}
if (opts.flags.has('--list')) {
  for (const name of blockNames()) console.log(name);
  process.exit(0);
}

const verbose = opts.flags.has('--verbose');
const { files, problems } = planFreshness(opts.root);

for (const p of problems) console.error(`${p.file}:${p.line}  ${p.message}`);

let stale = 0;
let total = 0;
for (const f of files) {
  for (const b of f.blocks) {
    total += 1;
    if (b.stale) {
      stale += 1;
      console.error(`${f.file}:${b.line}  '${b.name}' is stale; run: npm run fresh:sync`);
    } else if (verbose) {
      console.log(`ok    ${f.file}:${b.line}  '${b.name}'`);
    }
  }
}

if (problems.length > 0 || stale > 0) {
  console.error(`\nfresh:check: ${stale} stale block(s), ${problems.length} marker problem(s)`);
  process.exit(1);
}
console.log(`fresh:check: ${total} generated block(s) in sync across ${files.length} file(s)`);
