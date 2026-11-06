/** GitHub-only recovery for an accepted npm publish whose registry check failed. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetNames, releaseVersion } from './release-contract.mjs';

const REPO = 'ashlrai/lexicon';
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const ROOT = '.release-recovery';
const integer = value => { assert.match(String(value), /^[1-9][0-9]*$/); const n = Number(value); assert.ok(Number.isSafeInteger(n)); return n; };
const same = (a, b) => assert.deepEqual(a, b, 'recovery binding changed');
const done = (job, conclusion = 'success') => { assert.equal(job.status, 'completed'); assert.equal(job.conclusion, conclusion); };
function one(rows, name) { const found = rows.filter(row => row.name === name); assert.equal(found.length, 1, `required evidence missing or duplicated: ${name}`); return found[0]; }
function list(document, key) { assert.ok(Number.isSafeInteger(document.total_count) && document.total_count <= 100); assert.equal(document[key].length, document.total_count); return document[key]; }

export function validateRecoveryEnvironment(env) {
  assert.equal(env.GITHUB_REPOSITORY, REPO);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_REF_PROTECTED, 'true', 'recovery requires current branch protection');
  assert.equal(env.GITHUB_WORKFLOW_REF, `${REPO}/.github/workflows/release.yml@refs/heads/main`);
  assert.match(env.GITHUB_SHA ?? '', SHA);
  assert.ok(!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN && !env.ACTIONS_ID_TOKEN_REQUEST_URL, 'recovery must have no OIDC authority');
  return env.GITHUB_SHA;
}
export function recoveryInputs(env) {
  return { version: releaseVersion(env.VERSION), runId: integer(env.RECOVERY_RUN_ID), attempt: integer(env.RECOVERY_ATTEMPT),
    ciRunId: integer(env.RECOVERY_CI_RUN_ID), ubuntuId: integer(env.RECOVERY_UBUNTU_ARTIFACT_ID), macosId: integer(env.RECOVERY_MACOS_ARTIFACT_ID),
    policySha: validateRecoveryEnvironment(env) };
}

/** Pure admission: no caller-supplied receipt substitutes for live GitHub evidence. */
export function validateRecoveryEvidence(input, e) {
  const version = releaseVersion(input.version), tag = `v${version}`;
  for (const key of ['runId', 'attempt', 'ciRunId', 'ubuntuId', 'macosId']) integer(input[key]);
  assert.notEqual(input.ubuntuId, input.macosId);
  assert.match(input.policySha, SHA); assert.match(e.sourceSha, SHA);
  assert.equal(e.tag.ref, `refs/tags/${tag}`);
  assert.ok(['commit', 'tag'].includes(e.tag.object.type));
  assert.match(e.tag.object.sha, SHA);
  if (e.tag.object.type === 'commit') assert.equal(e.tag.object.sha, e.sourceSha);
  else { assert.equal(e.peeled.object.type, 'commit'); assert.equal(e.peeled.object.sha, e.sourceSha); }
  assert.ok(['ahead', 'identical'].includes(e.ancestry.status));
  assert.equal(e.ancestry.merge_base_commit.sha, e.sourceSha, 'candidate must remain in trusted policy history');
  integer(e.releaseWorkflow.id); integer(e.ciWorkflow.id);
  assert.equal(e.releaseWorkflow.path, '.github/workflows/release.yml');
  assert.equal(e.ciWorkflow.path, '.github/workflows/ci.yml');
  const run = e.run; integer(run.repository.id);
  assert.equal(run.head_repository.id, run.repository.id);
  same([run.id, run.run_attempt, run.event, run.head_sha, run.head_branch, run.workflow_id, run.path],
    [input.runId, input.attempt, 'push', e.sourceSha, tag, e.releaseWorkflow.id, '.github/workflows/release.yml']);
  assert.equal(run.repository.full_name, REPO); assert.equal(run.head_repository.full_name, REPO); done(run, 'failure');
  const jobs = list(e.jobs, 'jobs');
  for (const name of ['Full suite green on release sha', 'ubuntu', 'macos']) done(one(jobs, name));
  for (const job of jobs) {
    assert.equal(job.run_id, input.runId); assert.equal(job.run_attempt, input.attempt);
    if (!['Full suite green on release sha', 'ubuntu', 'macos', 'publish'].includes(job.name)) {
      assert.equal(job.name, 'GitHub-only release recovery'); done(job, 'skipped');
    }
  }
  const publish = one(jobs, 'publish'); done(publish, 'failure');
  const steps = publish.steps;
  for (const name of ['Revalidate source identity', 'Validate complete qualified artifact closure', 'Refuse token-based npm auth',
    'Require publish credentials and prove publication absence', 'Publish original qualified npm archive']) done(one(steps, name));
  done(one(steps, 'Accept exact npm version and archive integrity'), 'failure');
  for (const name of ['Create draft and upload complete assets without overwrite', 'Verify exact draft asset inventory and hosted bytes',
    'Recheck registry acceptance and publish verified draft']) done(one(steps, name), 'skipped');
  assert.equal(steps.filter(step => step.conclusion === 'failure').length, 1);
  const ci = e.ciRun;
  same([ci.id, ci.event, ci.head_sha, ci.head_branch, ci.workflow_id, ci.path],
    [input.ciRunId, 'workflow_dispatch', e.sourceSha, tag, e.ciWorkflow.id, '.github/workflows/ci.yml']);
  assert.equal(ci.repository.full_name, REPO); assert.equal(ci.head_repository.full_name, REPO);
  same([ci.repository.id, ci.head_repository.id], [run.repository.id, run.repository.id]); integer(ci.run_attempt); done(ci);
  const ciJobs = list(e.ciJobs, 'jobs');
  for (const name of ['plan', 'Typecheck, build, Tier-1 security', 'Secret-shape scan', 'Secret scan (diff)',
    'ubuntu-latest node 20', 'ubuntu-latest node 22', 'ubuntu-latest node 24', 'macos-latest node 22', 'windows-latest node 22']) {
    const job = one(ciJobs, name); same([job.run_id, job.run_attempt], [input.ciRunId, ci.run_attempt]); done(job);
  }
  const artifacts = list(e.artifacts, 'artifacts'); assert.equal(artifacts.length, 2);
  const selected = {};
  for (const part of ['ubuntu', 'macos']) {
    const a = one(artifacts, `lexicon-release-${part}`);
    assert.equal(a.id, input[`${part}Id`]); assert.equal(a.expired, false); assert.match(a.digest, DIGEST);
    assert.ok(Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes > 0 && a.size_in_bytes <= MAX_ZIP_BYTES);
    same([a.workflow_run.id, a.workflow_run.head_sha, a.workflow_run.head_repository_id], [input.runId, e.sourceSha, run.repository.id]);
    const job = one(jobs, part), created = Date.parse(a.created_at);
    assert.ok(Number.isFinite(created) && created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at), 'artifact is outside the pinned producer attempt');
    selected[part] = { id: a.id, name: a.name, digest: a.digest, size: a.size_in_bytes };
  }
  return { schema: 'lexicon.release-recovery.v1', input, sourceSha: e.sourceSha, tagObject: e.tag.object,
    ciAttempt: ci.run_attempt, artifacts: selected };
}

async function api(path, redirect = 'error') {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, { redirect,
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN ?? ''}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  return response;
}
async function json(path) {
  const response = await api(path); assert.equal(response.status, 200, 'GitHub evidence unavailable');
  const bytes = await bounded(response, 2 * 1024 * 1024); return JSON.parse(bytes.toString('utf8'));
}
async function bounded(response, maxBytes) {
  assert.ok(Number(response.headers.get('content-length') ?? 0) <= maxBytes);
  assert.ok(response.body); const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; assert.ok(bytes <= maxBytes, 'bounded response exceeded'); chunks.push(next.value); } }
  finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  return Buffer.concat(chunks, bytes);
}
const POLICY_FILES = ['.github/workflows/release.yml', '.github/workflows/ci.yml', 'scripts/release-recovery.mjs', 'scripts/release-contract.mjs'];
/** Fresh policy admission stays outside the frozen producer/artifact tuple. */
export function validatePolicyEvidence(policySha, e, localHashes) {
  assert.match(policySha, SHA); assert.equal(e.branch.protected, true); assert.match(e.branch.commit.sha, SHA);
  assert.ok(['ahead', 'identical'].includes(e.ancestry.status));
  assert.equal(e.ancestry.merge_base_commit.sha, policySha, 'executing policy left protected main history');
  assert.equal(e.releaseWorkflow.state, 'active'); assert.equal(e.ciWorkflow.state, 'active');
  same(Object.keys(localHashes).sort(), [...POLICY_FILES].sort()); same(Object.keys(e.files).sort(), [...POLICY_FILES].sort());
  for (const path of POLICY_FILES) { assert.match(localHashes[path], /^[a-f0-9]{64}$/); same(e.files[path], localHashes[path]); }
}
async function livePolicy(policySha) {
  const branch = await json('branches/main'); assert.match(branch.commit.sha, SHA);
  const [ancestry, releaseWorkflow, ciWorkflow, ...files] = await Promise.all([
    json(`compare/${policySha}...${branch.commit.sha}`), json('actions/workflows/release.yml'), json('actions/workflows/ci.yml'),
    ...POLICY_FILES.map(path => json(`contents/${path}?ref=${branch.commit.sha}`)),
  ]);
  const remoteHashes = {}, localHashes = {};
  for (let i = 0; i < POLICY_FILES.length; i++) {
    const path = POLICY_FILES[i], file = files[i];
    same([file.type, file.path, file.encoding], ['file', path, 'base64']);
    remoteHashes[path] = createHash('sha256').update(Buffer.from(file.content, 'base64')).digest('hex');
    localHashes[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  validatePolicyEvidence(policySha, { branch, ancestry, releaseWorkflow, ciWorkflow, files: remoteHashes }, localHashes);
}
async function evidence(input) {
  const tag = await json(`git/ref/tags/v${input.version}`);
  assert.ok(tag.object && SHA.test(tag.object.sha));
  const peeled = tag.object.type === 'tag' ? await json(`git/tags/${tag.object.sha}`) : null;
  const sourceSha = peeled?.object?.sha ?? tag.object.sha; assert.match(sourceSha, SHA);
  const run = await json(`actions/runs/${input.runId}`), ciRun = await json(`actions/runs/${input.ciRunId}`);
  const [releaseWorkflow, ciWorkflow, ancestry, jobs, ciJobs, artifacts] = await Promise.all([
    json('actions/workflows/release.yml'), json('actions/workflows/ci.yml'), json(`compare/${sourceSha}...${input.policySha}`),
    json(`actions/runs/${input.runId}/attempts/${input.attempt}/jobs?per_page=100`),
    json(`actions/runs/${input.ciRunId}/attempts/${integer(ciRun.run_attempt)}/jobs?per_page=100`), json(`actions/runs/${input.runId}/artifacts?per_page=100`),
  ]);
  const proof = validateRecoveryEvidence(input, { tag, peeled, sourceSha, run, ciRun, releaseWorkflow, ciWorkflow, ancestry, jobs, ciJobs, artifacts });
  await livePolicy(input.policySha);
  return proof;
}

// Original artifact ZIPs are untrusted data. Only exact flat producer inventory
// is extracted; archive paths are never used as arbitrary output paths.
const EXTRACT = String.raw`import sys,json,zipfile,stat,os
from pathlib import Path
source,destination,expected=Path(sys.argv[1]),Path(sys.argv[2]),json.loads(sys.argv[3])
with source.open('rb') as raw:
 end=zipfile._EndRecData(raw)
 if end is None or end[zipfile._ECD_ENTRIES_TOTAL]>8 or end[zipfile._ECD_SIZE]>65536: raise ValueError('ZIP directory bound')
with zipfile.ZipFile(source) as archive:
 items=archive.infolist()
 if sorted(i.filename for i in items)!=sorted(expected): raise ValueError('ZIP inventory')
 total=0
 for item in items:
  mode=item.external_attr>>16
  if item.orig_filename!=item.filename or item.is_dir() or '/' in item.filename or '\\' in item.filename or item.flag_bits&1 or (stat.S_IFMT(mode) not in (0,stat.S_IFREG)): raise ValueError('ZIP member')
  total+=item.file_size
  if item.file_size<1 or item.file_size>256*1024*1024 or total>512*1024*1024: raise ValueError('ZIP size')
 destination.mkdir(mode=0o700)
 for item in items:
  with archive.open(item) as inp,(destination/item.filename).open('xb') as out:
   remaining=item.file_size
   while remaining:
    block=inp.read(min(1024*1024,remaining))
    if not block: raise ValueError('ZIP truncated')
    out.write(block);remaining-=len(block)
   if inp.read(1): raise ValueError('ZIP overflow')
  os.chmod(destination/item.filename,0o600)
`;
export function extractArtifact(zip, destination, version, part) {
  assert.ok(['ubuntu', 'macos'].includes(part));
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', EXTRACT, zip, destination, JSON.stringify([...assetNames(version, part), 'SHA256SUMS'])],
    { timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024,
      env: Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot', 'WINDIR'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) });
}
export function validateArtifactBytes(bytes, artifact) {
  assert.ok(bytes.length <= MAX_ZIP_BYTES); assert.equal(bytes.length, artifact.size);
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, artifact.digest);
}
async function downloadArtifact(artifact, part, version) {
  const redirect = await api(`actions/artifacts/${artifact.id}/zip`, 'manual'); assert.equal(redirect.status, 302);
  const url = new URL(redirect.headers.get('location'));
  assert.ok(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.actions.githubusercontent.com')));
  // Never forward the GitHub credential to the signed artifact URL.
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) }); assert.equal(response.status, 200);
  const bytes = await bounded(response, MAX_ZIP_BYTES); validateArtifactBytes(bytes, artifact);
  const zip = join(ROOT, `${part}.zip`); writeFileSync(zip, bytes, { flag: 'wx', mode: 0o600 });
  extractArtifact(zip, join('staged', part), version, part);
}
async function main() {
  const input = recoveryInputs(process.env), command = process.argv[2];
  assert.ok(['prepare', 'recheck', 'recheck-final'].includes(command));
  const proof = await evidence(input);
  if (command === 'prepare') {
    mkdirSync(ROOT, { mode: 0o700 }); mkdirSync('staged', { mode: 0o700 });
    for (const part of ['ubuntu', 'macos']) await downloadArtifact(proof.artifacts[part], part, input.version);
    same(proof, await evidence(input));
    writeFileSync(join(ROOT, 'proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx', mode: 0o600 });
    appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${proof.sourceSha}\n`);
  } else {
    same(JSON.parse(readFileSync(join(ROOT, 'proof.json'), 'utf8')), proof);
    if (command === 'recheck') {
      const response = await api(`releases/tags/v${input.version}`); assert.equal(response.status, 404, 'release must remain absent');
    }
    // The final admission happens after all other reads and directly before
    // the workflow's draft creation or public edit, without freezing main.
    await livePolicy(input.policySha);
  }
  console.log(JSON.stringify(proof));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Release recovery refused; credentials and response bodies are not logged.'); process.exitCode = 1; });
}
