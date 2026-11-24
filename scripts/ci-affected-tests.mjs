/**
 * Affected tests for the Linux job on pull_request and merge_group.
 *
 * Uses vitest's own --changed list against BASE_SHA (the PR base or the
 * merge group's base). Stops at the first failure and writes that test's
 * file:line into the GitHub step summary. The full Linux, Windows and
 * macOS matrix stays on the daily schedule.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function parseFileList(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const stripped = trimmed.replace(/^\[[^\]]+\]\s+/, '');
    if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(stripped)) files.push(stripped.replaceAll('\\', '/'));
  }
  return files;
}

export function firstFailure(report, workspace = root) {
  for (const file of report?.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      if (test.status !== 'failed') continue;
      const raw = (test.failureMessages ?? []).join('\n');
      let filePath = typeof file.name === 'string' ? file.name : '';
      let line = test.location?.line ?? null;
      if (!line) {
        const found = raw.match(/([^\s"'()]+\.(?:ts|tsx|mts|cts|js|mjs|cjs)):(\d+)(?::\d+)?/);
        if (found) {
          filePath = found[1];
          line = Number(found[2]);
        }
      }
      let rel = filePath;
      if (rel && isAbsolute(rel)) rel = relative(workspace, rel);
      rel = rel.replaceAll('\\', '/');
      const title = test.fullName || test.title || 'failed test';
      const message = (raw.split('\n').map((part) => part.trim()).find(Boolean)) || title;
      return { file: rel, line, title, message };
    }
  }
  return null;
}

export function summaryForFailure(failure) {
  const loc = failure.line ? `${failure.file}:${failure.line}` : failure.file;
  return `### First failing test\n\n\`${loc}\`\n\n${failure.title}\n\n${failure.message}\n`;
}

function commandFor(message) {
  return message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function writeSummary(text) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  appendFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

function vitestBin() {
  return join(root, 'node_modules', 'vitest', 'vitest.mjs');
}

function runVitest(args) {
  return spawnSync(process.execPath, [vitestBin(), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function haveCommit(sha) {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status === 0;
}

function fetchCommit(sha) {
  return spawnSync('git', ['fetch', '--no-tags', 'origin', sha], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).status === 0 && haveCommit(sha);
}

function diagnosticText(stderr, stdout) {
  const text = `${stderr || ''}\n${stdout || ''}`.replace(/\u001b\[[0-9;]*m/g, '');
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => {
    if (!line) return false;
    if (/^[⎯─-]{3,}/.test(line)) return false;
    if (line === 'Collect Error') return false;
    return true;
  });
  return lines.slice(0, 8).join('\n') || 'vitest failed';
}

function finishFailure(failure) {
  writeSummary(summaryForFailure(failure));
  const loc = failure.line ? ` file=${failure.file},line=${failure.line}` : (failure.file ? ` file=${failure.file}` : '');
  const text = commandFor(`${failure.title}: ${failure.message}`);
  console.log(`::error${loc}::${text}`);
  process.exit(1);
}

function main() {
  const base = process.env.BASE_SHA || '';
  if (!base) {
    writeSummary('Affected tests did not run: BASE_SHA was empty.\n');
    console.log('::error::Affected tests did not run: BASE_SHA was empty.');
    process.exit(1);
  }
  if (!haveCommit(base) && !fetchCommit(base)) {
    writeSummary(`Affected tests did not run: base ${base} is not in this checkout.\n`);
    console.log(`::error::Affected tests did not run: base ${base} is not in this checkout.`);
    process.exit(1);
  }

  const listed = runVitest(['list', '--changed', base, '--filesOnly']);
  if (listed.status !== 0) {
    const detail = diagnosticText(listed.stderr, listed.stdout);
    writeSummary(`Could not list affected tests.\n\n${detail}\n`);
    console.log(`::error::${commandFor(detail)}`);
    process.exit(1);
  }

  const files = parseFileList(listed.stdout || '');
  if (files.length === 0) {
    writeSummary('No affected test files.\n');
    console.log('No affected test files.');
    return;
  }

  const reportPath = join(mkdtempSync(join(tmpdir(), 'lexicon-affected-')), 'report.json');
  const run = runVitest(['run', '--bail=1', '--reporter=json', `--outputFile=${reportPath}`, ...files]);
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    report = null;
  }
  if (run.status === 0 && report?.success !== false) {
    writeSummary(`Affected tests passed (${files.length} file${files.length === 1 ? '' : 's'}).\n`);
    console.log(`Affected tests passed (${files.length} file${files.length === 1 ? '' : 's'}).`);
    return;
  }
  const failure = report ? firstFailure(report) : null;
  if (failure) finishFailure(failure);
  const detail = diagnosticText(run.stderr, run.stdout);
  finishFailure({ file: '', line: null, title: 'vitest failed', message: detail });
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
