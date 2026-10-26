/*
 * Regenerate web/lib/generated/facts.json from the repo's source of truth.
 *
 * The heavy lifting lives in ../../scripts/site-facts.mjs so the Next site
 * and the static site share one derivation; this wrapper only exists so
 * web/package.json scripts can say `node scripts/gen-facts.mjs` like the
 * other generators (scan-media, build-demo-bundle, gen-faq-doc). Run with
 * --check to verify the artifact is fresh without rewriting it.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSiteFacts, factsDocument, factsJsonPath, writeFactsJson } from '../../scripts/site-facts.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const facts = deriveSiteFacts(root);
const out = factsJsonPath(root);
const generated = JSON.stringify(factsDocument(facts), null, 2) + '\n';

if (process.argv.includes('--check')) {
  if (!existsSync(out)) {
    console.error('web/lib/generated/facts.json is missing; run: node scripts/gen-facts.mjs');
    process.exit(1);
  }
  if (readFileSync(out, 'utf8') !== generated) {
    console.error('web/lib/generated/facts.json is out of date; run: node scripts/gen-facts.mjs');
    process.exit(1);
  }
  console.log('web/lib/generated/facts.json is up to date');
  process.exit(0);
}

writeFactsJson(facts, root);
console.log(
  `wrote ${path.relative(root, out)}  v${facts.version}, ${facts.mcpTools.length} tools, ` +
    `${facts.exportFormats.length} export formats, ${facts.packs.terms} pack terms`,
);
