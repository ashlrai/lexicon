#!/usr/bin/env node
/**
 * Builds the static demo site (https://ashlrai.github.io/lexicon/):
 *
 *   site/dist/app.js      <- site/app.ts (esbuild, browser, esm, minified)
 *   site/dist/index.html  <- site/index.html (copied)
 *   site/dist/styles.css  <- site/styles.css (copied)
 *
 * The app imports only the browser-safe core modules (schema, matcher,
 * normalize, suggest, exporters) and the `yaml` package; store/harvest/trust
 * use node:fs and must stay out. The build fails if any `node:` builtin
 * survives into the bundle, so a stray import cannot ship a broken page.
 *
 * `examples/lexicon.example.yaml` is inlined as text so the demo's default
 * lexicon can never drift from the documented example.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'site/dist');
mkdirSync(outdir, { recursive: true });

await build({
  absWorkingDir: root,
  entryPoints: { app: resolve(root, 'site/app.ts') },
  outdir,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  loader: { '.yaml': 'text' },
  legalComments: 'none',
  logLevel: 'warning',
});

const bundlePath = resolve(outdir, 'app.js');
const bundle = readFileSync(bundlePath, 'utf8');
const nodeBuiltins = bundle.match(/["']node:[a-z_/]+["']/g);
if (nodeBuiltins) {
  const list = [...new Set(nodeBuiltins)].join(', ');
  throw new Error(`site bundle imports Node builtins (${list}); only import browser-safe core modules from site/app.ts`);
}

for (const name of ['index.html', 'styles.css']) {
  copyFileSync(resolve(root, 'site', name), resolve(outdir, name));
}
// Tell GitHub Pages not to run Jekyll over the output.
copyFileSync(resolve(root, 'site', '.nojekyll'), resolve(outdir, '.nojekyll'));

for (const name of ['app.js', 'index.html', 'styles.css']) {
  const kb = (statSync(resolve(outdir, name)).size / 1024).toFixed(1);
  process.stdout.write(`site/dist/${name}  ${kb} KB\n`);
}
