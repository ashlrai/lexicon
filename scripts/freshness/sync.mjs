#!/usr/bin/env node
/**
 * Regenerate every `fresh:` block in the docs from the source of truth
 * (package.json `version` + the released CHANGELOG.md sections). See lib.mjs
 * for the marker syntax and the block registry.
 *
 * Usage:
 *   node scripts/freshness/sync.mjs [--root DIR] [--quiet] [--list]
 *
 *   --root DIR   sync a tree other than this repository (fixtures, tests)
 *   --quiet      print only the one-line summary
 *   --list       print the known block names and exit
 *
 * Exit 1 when a marker is malformed (unclosed, nameless, unknown name, an
 * inline marker holding a multi-line block): nothing is written in that case.
 */
import { writeFileSync } from 'node:fs';
import { blockNames, parseArgs, planFreshness } from './lib.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2), ['--quiet', '--list']);
} catch (err) {
  console.error(`fresh:sync: ${err.message}`);
  process.exit(2);
}

if (opts.help) {
  console.log('usage: node scripts/freshness/sync.mjs [--root DIR] [--quiet] [--list]');
  process.exit(0);
}
if (opts.flags.has('--list')) {
  for (const name of blockNames()) console.log(name);
  process.exit(0);
}

const quiet = opts.flags.has('--quiet');
const { files, problems } = planFreshness(opts.root);

for (const p of problems) console.error(`${p.file}:${p.line}  ${p.message}`);
if (problems.length > 0) {
  console.error(`\nfresh:sync: ${problems.length} marker problem(s); nothing written`);
  process.exit(1);
}

let writtenFiles = 0;
let syncedBlocks = 0;
let totalBlocks = 0;
for (const f of files) {
  totalBlocks += f.blocks.length;
  const stale = f.blocks.filter((b) => b.stale);
  if (stale.length === 0) continue;
  writeFileSync(f.path, f.text);
  writtenFiles += 1;
  syncedBlocks += stale.length;
  if (!quiet) {
    for (const b of stale) console.log(`${f.file}:${b.line}  regenerated '${b.name}'`);
  }
}

const tail = `${totalBlocks} block(s) checked across ${files.length} file(s)`;
console.log(syncedBlocks === 0 ? `fresh:sync: already in sync (${tail})` : `fresh:sync: wrote ${syncedBlocks} block(s) in ${writtenFiles} file(s) (${tail})`);
