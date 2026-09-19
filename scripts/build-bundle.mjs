#!/usr/bin/env node
/**
 * Builds the self-contained Claude Code plugin entry points:
 *
 *   plugin/mcp-server.mjs  <- src/mcp/server.ts
 *   plugin/hook.mjs        <- src/hooks/user-prompt-submit.ts
 *
 * Every dependency (zod, yaml, the MCP SDK, double-metaphone, ...) is inlined,
 * so a bare `git clone` of the plugin (which is what `claude plugin install`
 * produces: no `npm install`, no dist/) runs with nothing but Node >= 20.
 *
 * The output is committed. CI rebuilds it and fails when it differs from the
 * checked-in files (`npm run check:bundle`), so run `npm run build:bundle`
 * after touching anything the two entry points import.
 *
 * Left unminified on purpose: the committed files should stay inspectable.
 */
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// esbuild's ESM output has no `require`, but bundled CommonJS packages (yaml
// does `require('process')` at module scope) still call it; give them Node's.
const banner = [
  'import { createRequire as __lexiconCreateRequire } from "node:module";',
  'const require = __lexiconCreateRequire(import.meta.url);',
].join('\n');

const entryPoints = {
  'mcp-server': resolve(root, 'src/mcp/server.ts'),
  hook: resolve(root, 'src/hooks/user-prompt-submit.ts'),
};

await build({
  absWorkingDir: root,
  entryPoints,
  outdir: resolve(root, 'plugin'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // The entry files' own `#!/usr/bin/env node` line is preserved above the banner.
  banner: { js: banner },
  legalComments: 'none',
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
});

for (const name of Object.keys(entryPoints)) {
  const file = resolve(root, 'plugin', `${name}.mjs`);
  const kb = (statSync(file).size / 1024).toFixed(0);
  process.stdout.write(`plugin/${name}.mjs  ${kb} KB\n`);
}
