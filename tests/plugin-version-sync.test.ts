import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readVersion(rel: string): unknown {
  const json = JSON.parse(readFileSync(resolve(root, rel), 'utf8')) as { version?: unknown };
  return json.version;
}

it('keeps the .claude-plugin/plugin.json version equal to the package.json version', () => {
  const pkgVersion = readVersion('package.json');
  // Guard against undefined === undefined when both files lose their version.
  expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);

  const pluginVersion = readVersion('.claude-plugin/plugin.json');
  expect(pluginVersion, `plugin.json version must be ${String(pkgVersion)} (from package.json)`).toBe(pkgVersion);
});
