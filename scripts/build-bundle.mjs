#!/usr/bin/env node
/**
 * Builds the self-contained Claude Code plugin entry points:
 *
 *   plugin/mcp-server.mjs  <- src/mcp/server.ts
 *   plugin/hook-main.mjs   <- src/hooks/user-prompt-submit.ts
 *   plugin/hook.mjs        <- src/hooks/plugin-entry.ts (enables Node's
 *                             compile cache, then imports hook-main.mjs)
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
import { hookBundleFixes } from './hook-bundle-fixes.mjs';
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

/**
 * Every module under src/ is free of import-time side effects (no module is
 * imported for its effects; entry points are never imported by another
 * module), so tell esbuild it may drop any module whose exports go unused.
 * Without this it keeps whole modules for a top-level `new Set(...)` or a
 * regex, which pulled harvest, import-sources and their `node:child_process`
 * import into the prompt hook, where every millisecond of startup counts.
 * Scoped to our own files: dependencies keep their own package.json answer.
 */
const srcDir = resolve(root, 'src');
const sideEffectFreeSrc = {
  name: 'side-effect-free-src',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\// }, async (args) => {
      if (args.pluginData?.sideEffectFreeSrc || !args.importer.startsWith(srcDir)) return undefined;
      const resolved = await b.resolve(args.path, {
        kind: args.kind,
        importer: args.importer,
        resolveDir: args.resolveDir,
        pluginData: { sideEffectFreeSrc: true },
      });
      if (resolved.errors.length > 0 || !resolved.path.startsWith(srcDir)) return resolved;
      return { ...resolved, sideEffects: false };
    });
  },
};

/**
 * Load `node:` builtins with the banner's `require` instead of an ESM import.
 * An ESM import of a builtin builds a facade that reads every export once,
 * and for `node:fs` that read alone pulls in the whole streams stack (the
 * lazy `ReadStream` getter): about 10 ms of the prompt hook's startup, for
 * APIs it never touches. `require` hands back the same module object without
 * the facade. Dynamic imports stay lazy (esbuild keeps them behind a promise).
 */
const builtinsViaRequire = {
  name: 'builtins-via-require',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) =>
      args.namespace === 'builtin-cjs' ? { path: args.path, external: true } : { path: args.path, namespace: 'builtin-cjs' },
    );
    b.onLoad({ filter: /.*/, namespace: 'builtin-cjs' }, (args) => ({
      contents: `module.exports = require(${JSON.stringify(args.path)});`,
      loader: 'js',
    }));
  },
};

const entryPoints = {
  'mcp-server': resolve(root, 'src/mcp/server.ts'),
  'hook-main': resolve(root, 'src/hooks/user-prompt-submit.ts'),
  hook: resolve(root, 'src/hooks/plugin-entry.ts'),
};

const options = {
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
  plugins: [sideEffectFreeSrc, builtinsViaRequire],
};

const { 'hook-main': hookMain, ...otherEntries } = entryPoints;
await build({ ...options, entryPoints: otherEntries });
await build({ ...options, entryPoints: { 'hook-main': hookMain },
  plugins: [...options.plugins, hookBundleFixes] });

for (const name of Object.keys(entryPoints)) {
  const file = resolve(root, 'plugin', `${name}.mjs`);
  const kb = (statSync(file).size / 1024).toFixed(0);
  process.stdout.write(`plugin/${name}.mjs  ${kb} KB\n`);
}
