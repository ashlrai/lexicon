import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('package scripts reference existing script files', () => {
  const { scripts } = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const paths = Object.values(scripts).flatMap((command) =>
    [...command.matchAll(/\bscripts\/[\w./-]+\.(?:mjs|ts)\b/g)].map((match) => match[0]),
  );

  assert.ok(paths.length >= 5, `expected at least 5 script paths, found ${paths.length}`);
  for (const path of paths) {
    assert.ok(existsSync(resolve(root, path)), `missing package script path: ${path}`);
  }
});
