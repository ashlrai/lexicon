/**
 * Per-OS gate. A skipped leg passes only when the path gate skipped it, or
 * when a check job is absent on the daily schedule because the full matrix
 * already ran. A failure or a cancellation fails the gate.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function evaluateOsGate({ classify, flag, event, jobs, optionalWhenMeasuring }) {
  const bad = [];
  if (classify !== 'success') bad.push(`classify=${classify}`);
  const pathSkip = classify === 'success' && flag === 'false';
  const measuring = event === 'schedule' || event === 'workflow_dispatch';
  for (const [name, result] of Object.entries(jobs)) {
    if (result === 'success') continue;
    if (result === 'skipped' && pathSkip) continue;
    if (result === 'skipped' && measuring && optionalWhenMeasuring.includes(name)) continue;
    bad.push(`${name}=${result}`);
  }
  return bad;
}

function main() {
  const jobs = JSON.parse(process.env.JOBS || '{}');
  const optional = (process.env.OPTIONAL_WHEN_MEASURING || '').split(',').filter(Boolean);
  const bad = evaluateOsGate({
    classify: process.env.CLASSIFY || '',
    flag: process.env.FLAG || '',
    event: process.env.EVENT || '',
    jobs,
    optionalWhenMeasuring: optional,
  });
  if (bad.length > 0) {
    console.log(`::error::${bad.join(', ')}`);
    process.exit(1);
  }
  console.log(`OS gate passed (${process.env.EVENT})`);
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
