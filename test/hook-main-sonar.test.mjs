import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import { build } from 'esbuild';
import { hookBundleFixes } from '../scripts/hook-bundle-fixes.mjs';

const home = await mkdtemp(resolve(tmpdir(), 'lexicon-sonar-'));
after(() => rm(home, { recursive: true, force: true }));
const result = await build({
  stdin: { contents: `
    export { defineLazy, allowsEval } from './node_modules/zod/v4/core/util.js';
    export { Doc } from './node_modules/zod/v4/core/doc.js';
    export { isRecursiveSchema } from './node_modules/zod/v4/core/memoizer.js';`, resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'node', write: false, plugins: [hookBundleFixes],
});
const fixture = resolve(home, 'zod.mjs');
await writeFile(fixture, result.outputFiles[0].text);
const { defineLazy, allowsEval, Doc, isRecursiveSchema } = await import(fixture);

test('lazy getter handles reentrancy, caches values and permits assignment', () => {
  const object = {};
  let calls = 0;
  defineLazy(object, 'value', () => {
    calls++;
    assert.equal(object.value, undefined);
    return 42;
  });
  assert.equal(object.value, 42);
  assert.equal(object.value, 42);
  assert.equal(calls, 1);
  object.value = 7;
  assert.equal(object.value, 7);
});

test('undefined lazy results are retried; thrown getters remain cycle guarded', () => {
  const object = {};
  let calls = 0;
  defineLazy(object, 'value', () => ++calls === 1 ? undefined : 0);
  assert.equal(object.value, undefined);
  assert.equal(object.value, 0);
  assert.equal(calls, 2);
  defineLazy(object, 'broken', () => { throw new Error('broken'); });
  assert.throws(() => object.broken, /broken/);
  assert.equal(object.broken, undefined);
});

test('code generation is disabled explicitly', () => {
  assert.equal(allowsEval.value, false);
  assert.throws(() => new Doc().compile(), /Code generation is disabled/);
});

test('unknown schema kinds still scan children without invoking accessors', () => {
  const leaf = { _zod: { def: { type: 'string' } } };
  const custom = { _zod: { def: { type: 'extension', child: leaf,
    get ignored() { throw new Error('must not read accessors'); } } } };
  assert.equal(isRecursiveSchema(custom), false);
  // Use a fresh schema because recursion results are cached per schema.
  const recursive = { _zod: { def: { type: 'extension' } } };
  recursive._zod.def.children = [recursive];
  assert.equal(isRecursiveSchema(recursive), true);
});

test('shipped hook validates and corrects with string code generation forbidden', async () => {
  const lexicon = resolve(home, 'lexicon.yaml');
  for (const [contents, expected] of [
    ['version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n', /Ashlr\.AI/],
    ['version: 1\nterms: invalid\n', /file does not parse/],
  ]) {
    await writeFile(lexicon, contents);
    const run = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', 'plugin/hook-main.mjs'], {
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'Ask Ashler', cwd: home }),
      encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, LEXICON_PATH: lexicon },
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0);
    assert.match(run.stdout + run.stderr, expected);
    assert.doesNotMatch(run.stderr, /Code generation|EvalError/);
  }
});

test('reported constructs stay absent from the generated hook', async () => {
  const bundle = await readFile('plugin/hook-main.mjs', 'utf8');
  assert.doesNotMatch(bundle, /value === EVALUATING|const F = Function|new Function\s*\(|^\s*kind;$/m);
});
