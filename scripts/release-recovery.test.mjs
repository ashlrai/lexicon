import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assetNames } from './release-contract.mjs';
import { validateRecoveryEnvironment, recoveryInputs, validateRecoveryEvidence, validatePolicyEvidence, validateArtifactBytes, validateLatestStable, extractArtifact } from './release-recovery.mjs';

const source = 'a'.repeat(40), policy = 'b'.repeat(40), repo = 'ashlrai/lexicon';
const releasePath = '.github/workflows/release.yml', ciPath = '.github/workflows/ci.yml';
const input = { version: '1.2.3', runId: 11, attempt: 2, ciRunId: 12, ubuntuId: 13, macosId: 14, policySha: policy };
const env = { GITHUB_REPOSITORY: repo, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', GITHUB_WORKFLOW_REF: `${repo}/${releasePath}@refs/heads/main`, GITHUB_SHA: policy, VERSION: '1.2.3', RECOVERY_RUN_ID: '11', RECOVERY_ATTEMPT: '2', RECOVERY_CI_RUN_ID: '12', RECOVERY_UBUNTU_ARTIFACT_ID: '13', RECOVERY_MACOS_ARTIFACT_ID: '14' };
const complete = (name, conclusion = 'success') => ({ name, status: 'completed', conclusion });
const list = (key, rows) => ({ total_count: rows.length, [key]: rows });
function fixture() {
  const producer = name => ({ ...complete(name), run_id: 11, run_attempt: 2, started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T01:00:00Z' });
  const steps = ['Revalidate source identity', 'Validate complete qualified artifact closure', 'Refuse token-based npm auth', 'Require publish credentials and prove publication absence', 'Publish original qualified npm archive'].map(n => complete(n));
  steps.push(complete('Accept exact npm version and archive integrity', 'failure'), ...['Create draft and upload complete assets without overwrite', 'Verify exact draft asset inventory and hosted bytes', 'Recheck registry acceptance and publish verified draft'].map(n => complete(n, 'skipped')));
  const jobs = [producer('Full suite green on release sha'), producer('ubuntu'), producer('macos'), { ...producer('publish'), conclusion: 'failure', steps }, { ...producer('GitHub-only release recovery'), conclusion: 'skipped' }];
  const repository = { id: 42, full_name: repo };
  const run = { ...complete('run', 'failure'), id: 11, run_attempt: 2, event: 'push', head_sha: source, head_branch: 'v1.2.3', workflow_id: 7, path: releasePath, repository, head_repository: { ...repository } };
  const ciRun = { ...complete('ci'), id: 12, run_attempt: 3, event: 'workflow_dispatch', head_sha: source, head_branch: 'v1.2.3', workflow_id: 8, path: ciPath, repository, head_repository: { ...repository } };
  const ciJobs = ['plan', 'Typecheck, build, Tier-1 security', 'Secret-shape scan', 'Secret scan (diff)', 'ubuntu-latest node 20', 'ubuntu-latest node 22', 'ubuntu-latest node 24', 'macos-latest node 22', 'windows-latest node 22'].map(name => ({ ...complete(name), run_id: 12, run_attempt: 3 }));
  const artifacts = ['ubuntu', 'macos'].map((part, i) => ({ name: `lexicon-release-${part}`, id: 13 + i, expired: false, digest: `sha256:${'c'.repeat(64)}`, size_in_bytes: 100, created_at: '2026-01-01T00:30:00Z', workflow_run: { id: 11, head_sha: source, head_repository_id: 42 } }));
  return { tag: { ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: source } }, peeled: null, sourceSha: source, run, ciRun, releaseWorkflow: { id: 7, path: releasePath }, ciWorkflow: { id: 8, path: ciPath }, ancestry: { status: 'ahead', merge_base_commit: { sha: source } }, jobs: list('jobs', jobs), ciJobs: list('jobs', ciJobs), artifacts: list('artifacts', artifacts) };
}

test('recovery environment and exact input admission', () => {
  assert.equal(validateRecoveryEnvironment(env), policy); assert.deepEqual(recoveryInputs(env), input);
  for (const [key, value] of Object.entries({ GITHUB_REPOSITORY: 'other/repo', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.2.3', GITHUB_REF_PROTECTED: 'false', GITHUB_WORKFLOW_REF: 'wrong', GITHUB_SHA: 'bad', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'present', ACTIONS_ID_TOKEN_REQUEST_URL: 'present', RECOVERY_ATTEMPT: '0', RECOVERY_RUN_ID: '1.5', VERSION: 'v1.2.3' })) {
    assert.throws(() => recoveryInputs({ ...env, [key]: value }), key);
  }
});

test('original source, run, jobs and artifact evidence are bound', () => {
  assert.equal(validateRecoveryEvidence(input, fixture()).sourceSha, source);
  const annotated = fixture(); annotated.tag.object = { type: 'tag', sha: 'd'.repeat(40) }; annotated.peeled = { object: { type: 'commit', sha: source } }; assert.doesNotThrow(() => validateRecoveryEvidence(input, annotated));
  const mutations = {
    tag: e => { e.tag.ref = 'refs/tags/v1.2.4'; }, source: e => { e.tag.object.sha = policy; }, ancestry: e => { e.ancestry.merge_base_commit.sha = policy; }, divergent: e => { e.ancestry.status = 'diverged'; },
    repository: e => { e.run.repository.id = 0; }, fork: e => { e.run.head_repository.id = 43; }, workflow: e => { e.releaseWorkflow.path = ciPath; }, run: e => { e.run.id++; }, attempt: e => { e.run.run_attempt++; }, jobAttempt: e => { e.jobs.jobs[1].run_attempt++; }, skippedProducer: e => { e.jobs.jobs[1].conclusion = 'skipped'; }, publish: e => { e.jobs.jobs[3].steps[5].conclusion = 'success'; }, ci: e => { e.ciRun.head_sha = policy; }, ciFork: e => { e.ciRun.head_repository.id = 43; }, ciAttempt: e => { e.ciJobs.jobs[0].run_attempt++; }, ciSkipped: e => { e.ciJobs.jobs[1].conclusion = 'skipped'; }, count: e => { e.ciJobs.total_count++; }, digest: e => { e.artifacts.artifacts[0].digest = 'sha256:bad'; }, artifactId: e => { e.artifacts.artifacts[0].id++; }, artifactSource: e => { e.artifacts.artifacts[0].workflow_run.head_sha = policy; }, artifactProducer: e => { e.artifacts.artifacts[0].created_at = '2026-01-02T00:00:00Z'; }, expired: e => { e.artifacts.artifacts[0].expired = true; }, size: e => { e.artifacts.artifacts[0].size_in_bytes = 64 * 1024 * 1024 + 1; },
  };
  for (const [name, mutate] of Object.entries(mutations)) { const e = fixture(); mutate(e); assert.throws(() => validateRecoveryEvidence(input, e), name); }
  assert.throws(() => validateRecoveryEvidence({ ...input, macosId: input.ubuntuId }, fixture()));
});

test('a failed release run is admitted for a tag push or a workflow_dispatch on the tagged commit', () => {
  const dispatched = fixture();
  dispatched.run.event = 'workflow_dispatch';
  dispatched.run.head_branch = 'main';
  assert.equal(validateRecoveryEvidence(input, dispatched).sourceSha, source);
  const onTag = fixture();
  onTag.run.event = 'workflow_dispatch';
  onTag.run.head_branch = 'v1.2.3';
  assert.doesNotThrow(() => validateRecoveryEvidence(input, onTag));
  const ciOnMain = fixture();
  ciOnMain.ciRun.head_branch = 'main';
  assert.equal(validateRecoveryEvidence(input, ciOnMain).sourceSha, source);
  const rejected = {
    schedule: e => { e.run.event = 'schedule'; },
    feature: e => { e.run.event = 'workflow_dispatch'; e.run.head_branch = 'feature'; },
    otherSha: e => { e.run.event = 'workflow_dispatch'; e.run.head_branch = 'main'; e.run.head_sha = policy; },
    pushOnMain: e => { e.run.head_branch = 'main'; },
    ciFeature: e => { e.ciRun.head_branch = 'feature'; },
    ciPush: e => { e.ciRun.event = 'push'; e.ciRun.head_branch = 'main'; },
  };
  for (const [name, mutate] of Object.entries(rejected)) { const e = fixture(); mutate(e); assert.throws(() => validateRecoveryEvidence(input, e), name); }
});

test('current protected policy closure tolerates unrelated main advances only', () => {
  const paths = [releasePath, ciPath, 'scripts/release-recovery.mjs', 'scripts/release-contract.mjs'];
  const hashes = Object.fromEntries(paths.map((p, i) => [p, String(i).repeat(64)]));
  const evidence = () => ({ branch: { protected: true, commit: { sha: 'f'.repeat(40) } }, ancestry: { status: 'ahead', merge_base_commit: { sha: policy } }, releaseWorkflow: { state: 'active' }, ciWorkflow: { state: 'active' }, files: { ...hashes } });
  assert.doesNotThrow(() => validatePolicyEvidence(policy, evidence(), hashes));
  const identical = evidence(); identical.ancestry.status = 'identical'; identical.branch.commit.sha = policy; assert.doesNotThrow(() => validatePolicyEvidence(policy, identical, hashes));
  for (const mutate of [e => { e.files[releasePath] = 'e'.repeat(64); }, e => { delete e.files[ciPath]; }, e => { e.branch.protected = false; }, e => { e.releaseWorkflow.state = 'disabled_manually'; }, e => { e.ciWorkflow.state = 'disabled_manually'; }, e => { e.ancestry.status = 'behind'; }, e => { e.ancestry.merge_base_commit.sha = source; }]) { const e = evidence(); mutate(e); assert.throws(() => validatePolicyEvidence(policy, e, hashes)); }
  const missing = { ...hashes }; delete missing[ciPath]; assert.throws(() => validatePolicyEvidence(policy, evidence(), missing));
});

test('GitHub-only recovery cannot downgrade a newer public stable release', () => {
  const latest = version => ({ tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' });
  assert.doesNotThrow(() => validateLatestStable('0.5.8', null));
  assert.doesNotThrow(() => validateLatestStable('0.5.8', latest('0.5.4')));
  assert.doesNotThrow(() => validateLatestStable('0.5.8', latest('0.5.8')));
  assert.throws(() => validateLatestStable('0.5.8', latest('0.5.10')));
  assert.throws(() => validateLatestStable('0.5.8', latest('1.0.0')));
  assert.throws(() => validateLatestStable('9007199254740992.99.99', latest('9007199254740993.0.0')));
  for (const bad of [{ ...latest('0.5.4'), draft: true }, { ...latest('0.5.4'), prerelease: true }, { ...latest('0.5.4'), published_at: null }, latest('0.5.4-beta')]) assert.throws(() => validateLatestStable('0.5.8', bad));
});

test('actual artifact bytes must match both live digest and original ZIP size', () => {
  const bytes = Buffer.from('synthetic original qualified ZIP bytes');
  const artifact = { size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
  assert.doesNotThrow(() => validateArtifactBytes(bytes, artifact));
  const replacement = Buffer.from(bytes); replacement[0] ^= 1;
  assert.throws(() => validateArtifactBytes(replacement, artifact));
  assert.throws(() => validateArtifactBytes(bytes, { ...artifact, size: bytes.length + 1 }));
});

test('ZIP extraction accepts only bounded flat regular producer inventory', () => {
  const root = mkdtempSync(join(tmpdir(), 'lexicon-recovery-'));
  try {
    const names = [...assetNames('1.2.3', 'macos'), 'SHA256SUMS'];
    const python = String.raw`import sys,zipfile,stat,json,struct
p,kind,names=sys.argv[1],sys.argv[2],json.loads(sys.argv[3])
with zipfile.ZipFile(p,'w') as z:
 for name in names:
  info=zipfile.ZipInfo(name+'XXXX' if kind=='nul' and name==names[0] else name)
  if kind=='symlink' and name==names[0]: info.create_system=3; info.external_attr=(stat.S_IFLNK|0o777)<<16
  z.writestr(info,b'x')
 if kind=='duplicate': z.writestr(names[0],b'x')
 if kind=='traversal': z.writestr('../escape',b'x')
 if kind=='bounds':
  for i in range(7): z.writestr('extra'+str(i),b'x')
if kind=='oversize':
 data=bytearray(open(p,'rb').read());offset=data.index(b'PK\x01\x02');struct.pack_into('<I',data,offset+24,256*1024*1024+1);open(p,'wb').write(data)
if kind=='nul':
 data=open(p,'rb').read().replace((names[0]+'XXXX').encode(),(names[0]+'\x00XXX').encode());open(p,'wb').write(data)
`;
    for (const kind of ['valid', 'traversal', 'symlink', 'duplicate', 'bounds', 'nul', 'oversize']) {
      const zip = join(root, `${kind}.zip`), dest = join(root, kind);
      execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', python, zip, kind, JSON.stringify(names)], { stdio: 'pipe' });
      if (kind === 'valid') { extractArtifact(zip, dest, '1.2.3', 'macos'); assert.equal(readFileSync(join(dest, names[0]), 'utf8'), 'x'); }
      else { assert.throws(() => extractArtifact(zip, dest, '1.2.3', 'macos'), kind); assert.equal(existsSync(dest), false, `${kind}: refuse before creating extraction output`); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workflow isolates recovery and rechecks before every GitHub mutation', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const recovery = workflow.slice(workflow.indexOf('  github-recovery:'));
  const gate = workflow.slice(workflow.indexOf('  full-suite-evidence:'), workflow.indexOf('  ubuntu:'));
  for (const guard of ["github.event_name == 'workflow_dispatch'", 'inputs.recover_github_only', "github.repository == 'ashlrai/lexicon'", "github.ref == 'refs/heads/main'", 'github.ref_protected', "github.workflow_ref == 'ashlrai/lexicon/.github/workflows/release.yml@refs/heads/main'"]) assert.ok(recovery.includes(guard), guard);
  assert.match(gate, /if: github\.event_name != 'workflow_dispatch' \|\| !inputs\.recover_github_only/);
  for (const [start, end] of [['ubuntu', 'macos'], ['macos', 'publish'], ['publish', 'github-recovery']]) {
    const job = workflow.slice(workflow.indexOf(`  ${start}:`), workflow.indexOf(`  ${end}:`));
    assert.match(job, /needs: \[[^\]]*full-suite-evidence/);
  }
  assert.match(recovery, /permissions:\n      contents: write\n      actions: read\n      id-token: none/);
  assert.match(recovery, /timeout-minutes: 25/);
  assert.match(workflow, /description: "Original failed release run ID \(tag push or workflow_dispatch for this tag and commit\)"/);
  assert.doesNotMatch(workflow, /Original failed tag-push release run ID/);
  assert.match(workflow, /description: "Successful full manual CI run on the tagged commit"/);
  assert.doesNotMatch(recovery, /\bnpm\s+(?:publish|install|ci)\b|secrets\.|ACTIONS_ID_TOKEN_REQUEST/);
  assert.match(recovery, /cmp scripts\/release-contract\.mjs candidate\/scripts\/release-contract\.mjs/);
  const registry = recovery.indexOf('mjs registry release'), recheck = recovery.indexOf('mjs recheck\n'), create = recovery.indexOf('gh release create');
  assert.ok(registry >= 0 && recheck > registry && create > recheck);
  const final = recovery.indexOf('mjs recheck-final'), edit = recovery.indexOf('gh release edit');
  assert.ok(final > create && edit > final);
  const uses = [...recovery.matchAll(/^\s+(?:-\s+)?uses: (\S+)/gm)].map(m => m[1]);
  assert.equal(uses.length, 3); for (const action of uses) assert.match(action, /^[^@]+@[a-f0-9]{40}$/);
});
