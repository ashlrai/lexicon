/**
 * Finding this package's own root and version at runtime.
 *
 * Everything that reports a version (`lexicon --version`, the doctor, the MCP
 * server's initialize, the local API's /health) needs the same answer, and the
 * answer depends on where the caller is running from: `dist/cli/index.js` and
 * `src/mcp/server.ts` sit two levels below package.json, while the
 * self-contained `plugin/*.mjs` bundles sit one level below it. Walking up
 * until a package.json *named* `@ashlr/lexicon` turns up covers all of them --
 * and the name check keeps an unrelated package.json further up (a user's own
 * project, when this package is vendored) from being picked instead.
 *
 * Callers pass their own `import.meta.url`, because that is what determines
 * where the walk starts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './json.js';

export const PACKAGE_NAME = '@ashlr/lexicon';

/** Reported when package.json cannot be found or read. */
export const UNKNOWN_VERSION = '0.0.0';

/** The directory holding this package's package.json at or above `from` (a file URL or a path). */
export function findPackageRoot(from: string): string | undefined {
  let dir = from.startsWith('file:') ? path.dirname(fileURLToPath(from)) : path.resolve(from);
  for (;;) {
    if (readPackageJson(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** This package's version as seen from `moduleUrl`, or `UNKNOWN_VERSION`. */
export function packageVersion(moduleUrl: string): string {
  const root = findPackageRoot(moduleUrl);
  const pkg = root ? readPackageJson(path.join(root, 'package.json')) : undefined;
  return pkg?.version ?? UNKNOWN_VERSION;
}

/** The parsed package.json at `file`, but only when it is this package's. */
function readPackageJson(file: string): { version: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (isRecord(parsed) && parsed.name === PACKAGE_NAME && typeof parsed.version === 'string') {
      return { version: parsed.version };
    }
  } catch {
    // not here, or unreadable; the caller keeps walking
  }
  return undefined;
}
