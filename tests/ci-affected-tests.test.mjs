import assert from 'node:assert/strict';
import test from 'node:test';
import { firstFailure, parseFileList, summaryForFailure } from '../scripts/ci-affected-tests.mjs';

test('parseFileList keeps vitest paths and drops the project prefix', () => {
  const files = parseFileList('[unit] tests/matcher.test.ts\n[perf] tests/matcher-perf.test.ts\n\nnot a file\n');
  assert.deepEqual(files, ['tests/matcher.test.ts', 'tests/matcher-perf.test.ts']);
});

test('firstFailure reads location and falls back to the stack line', () => {
  const withLocation = firstFailure({
    testResults: [{
      name: '/repo/tests/matcher.test.ts',
      assertionResults: [{
        status: 'failed',
        fullName: 'matcher > hears Ashler',
        title: 'hears Ashler',
        location: { line: 42, column: 3 },
        failureMessages: ['expected Ashlr.AI'],
      }],
    }],
  }, '/repo');
  assert.equal(withLocation.file, 'tests/matcher.test.ts');
  assert.equal(withLocation.line, 42);
  assert.match(summaryForFailure(withLocation), /`tests\/matcher\.test\.ts:42`/);

  const fromStack = firstFailure({
    testResults: [{
      name: '/repo/tests/install.test.ts',
      assertionResults: [{
        status: 'passed',
        title: 'ok',
        failureMessages: [],
      }, {
        status: 'failed',
        title: 'installs',
        failureMessages: ['Error: no\n    at run (tests/install.test.ts:18:5)'],
      }],
    }],
  }, '/repo');
  assert.equal(fromStack.file, 'tests/install.test.ts');
  assert.equal(fromStack.line, 18);
  assert.equal(fromStack.title, 'installs');
});
