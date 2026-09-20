/**
 * Where the built CLI (`dist/cli/index.js`) lives, for anything that writes a
 * path to it into a file that outlives the current process: the launchd plist
 * and systemd unit behind `lexicon serve --install`, and the client configs
 * behind `lexicon install`. Resolving relative to `import.meta.url` is wrong
 * inside the plugin bundle (`plugin/mcp-server.mjs` inlines this module, so
 * "next to me" is `plugin/index.js`, which does not exist); the lookup here
 * walks up to the `@ashlr/lexicon` package.json instead, which works from
 * src/, dist/ and plugin/ alike. No imports from the rest of the CLI, so the
 * doctor and the installers can share it without a cycle.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from '../util/json.js';
import { findOnPathSync } from '../util/which.js';

export const PACKAGE_NAME = '@ashlr/lexicon';

/** Environment variable that overrides every other CLI location. */
export const CLI_ENV_VAR = 'LEXICON_CLI';

/**
 * The directory holding the `@ashlr/lexicon` package.json at or above
 * `from` (a file URL or a path), or undefined when none is found. The name
 * check keeps an unrelated package.json further up (a user's own project
 * when the package is vendored) from being picked.
 */
export function findPackageRoot(from: string): string | undefined {
  let dir = from.startsWith('file:') ? path.dirname(fileURLToPath(from)) : path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, 'package.json');
    try {
      const parsed: unknown = JSON.parse(readFileSync(candidate, 'utf8'));
      if (isRecord(parsed) && parsed.name === PACKAGE_NAME) return dir;
    } catch {
      // not here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface CliEntryOptions {
  /** An explicit path wins over everything else (a caller that already knows). */
  cliPath?: string;
  /** Environment to read `LEXICON_CLI` and `PATH` from. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Module to start the package.json walk from. Default: this module. */
  moduleUrl?: string;
}

/**
 * The absolute path of the CLI entry point, in order of preference:
 *
 *   1. `opts.cliPath`;
 *   2. `$LEXICON_CLI`;
 *   3. `<package root>/dist/cli/index.js` when that file exists, the root
 *      being found by walking up from `moduleUrl` (works from dist/ and from
 *      the plugin/ bundles);
 *   4. a `lexicon` binary on PATH, resolved through its symlinks (an npm
 *      global install links `bin/lexicon` to `dist/cli/index.js`), accepted
 *      only when it is a Node script;
 *
 * else a readable Error. Existence is checked only for 3 and 4: an explicit
 * path is returned as given so the caller can report it precisely.
 */
export function resolveCliEntry(opts: CliEntryOptions = {}): string {
  if (opts.cliPath !== undefined && opts.cliPath !== '') return path.resolve(opts.cliPath);
  const env = opts.env ?? process.env;
  const override = env[CLI_ENV_VAR];
  if (override !== undefined && override.trim() !== '') return path.resolve(override.trim());

  const root = findPackageRoot(opts.moduleUrl ?? import.meta.url);
  const built = root ? path.join(root, 'dist', 'cli', 'index.js') : undefined;
  if (built && existsSync(built)) return built;

  const onPath = findOnPathSync('lexicon', { env });
  if (onPath) {
    let real = onPath;
    try {
      real = realpathSync(onPath);
    } catch {
      // keep the PATH entry
    }
    if (/\.(?:[cm]?js)$/i.test(real)) return real;
    throw new Error(
      `found lexicon on PATH at ${onPath} but it is not a Node script (${real}); ` +
        `set ${CLI_ENV_VAR} to the built CLI (dist/cli/index.js)`,
    );
  }

  throw new Error(
    `could not locate the lexicon CLI: ${built ?? 'no @ashlr/lexicon package.json above ' + (opts.moduleUrl ?? import.meta.url)}` +
      `${built ? ' does not exist' : ''} and no lexicon binary is on PATH; run npm run build, or set ${CLI_ENV_VAR}=/path/to/dist/cli/index.js`,
  );
}
