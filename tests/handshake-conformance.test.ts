/**
 * Handshake conformance kit: validates `lexicon --ashlr-handshake --json`
 * against the Ashlr handshake v1 contract vendored from ashlr-stack
 * (tests/contract/, pinned by sha256, no network fetch), and runs the argv
 * mapped to every gated capability lexicon advertises.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Contract, checkGatedRun, checkHandshake, gatedFor } from './contract/handshake-conformance.js';

const PINNED_SHA256 = 'e4fa6e79ae7523fb11c44fc16843f0edf385f6c8e4c164409a62d05a76e0ac95';
const contractPath = path.join('tests', 'contract', 'ashlr-handshake.v1.json');
const raw = readFileSync(contractPath);
const contract = JSON.parse(raw.toString('utf8')) as Contract;

function run(args: string[], home: string) {
  // Only PATH and HOME: no tokens or other variables reach the probe.
  return spawnSync(process.execPath, ['--import', 'tsx', path.join('src', 'cli', 'index.ts'), ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home },
  });
}

describe('handshake contract v1 conformance', () => {
  it('the vendored contract matches its pin', () => {
    const sha = createHash('sha256').update(raw).digest('hex');
    expect(sha).toBe(PINNED_SHA256);
    expect(readFileSync(`${contractPath}.sha256`, 'utf8').split(/\s+/)[0]).toBe(sha);
  });

  it('`lexicon --ashlr-handshake --json` conforms and every gated capability runs its contract argv', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-conformance-'));
    const r = run(['--ashlr-handshake', '--json'], home);
    expect(r.status).toBe(0);
    const h = JSON.parse(r.stdout.trim());
    expect(checkHandshake(h, contract)).toEqual([]);
    const gated = gatedFor(h, contract);
    expect(gated.map(([cap]) => cap)).toContain('doctor-fix');
    for (const [cap, g] of gated) {
      const out = run(g.argv, home);
      expect(checkGatedRun(cap, g, out.status, out.stdout)).toEqual([]);
      if (g.read_only) expect(readdirSync(home)).toEqual([]);
    }
  }, 30_000);
});
