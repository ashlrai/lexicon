/**
 * `lexicon --ashlr-handshake`: the Ashlr companion handshake v1, the same
 * shape and checks as locus, ashlr-stack, ashlr-plugin and ashlr-md.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHandshake, wantsHandshake } from '../src/cli/handshake.js';
import { packageVersion } from '../src/util/package.js';

const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('ashlr handshake v1', () => {
  it('identifies the contract and the CLI', () => {
    const h = buildHandshake('9.9.9', { globalLexicon: true });
    expect(h.kind).toBe('ashlr.handshake');
    expect(h.schema_version).toBe(1);
    expect(h).toMatchObject({ name: 'lexicon', command: 'lexicon', version: '9.9.9' });
    expect(h.health).toEqual({ status: 'ok', checks: [{ id: 'global-lexicon', status: 'ok' }] });
  });

  it('no lexicon file yet is informational, not unhealthy', () => {
    const h = buildHandshake('1', { globalLexicon: false });
    expect(h.health.status).toBe('ok');
    expect(h.health.checks[0].status).toBe('absent');
  });

  it('ids are kebab-case and edits are home or project relative', () => {
    const h = buildHandshake('1', { globalLexicon: true });
    for (const id of [...h.capabilities, ...h.health.checks.map((c) => c.id)]) expect(id).toMatch(kebab);
    expect(h.edits.every((p) => !p.startsWith('/'))).toBe(true);
  });

  it('only the exact flag asks, with or without --json', () => {
    expect(wantsHandshake(['--ashlr-handshake', '--json'])).toBe(true);
    expect(wantsHandshake(['--json'])).toBe(false);
    expect(wantsHandshake(['--ashlr-handshake-x'])).toBe(false);
  });

  it('`lexicon --ashlr-handshake --json` prints one JSON line and creates nothing', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-handshake-'));
    const lexiconPath = path.join(home, 'none', 'lexicon.yaml');
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join('src', 'cli', 'index.ts'), '--ashlr-handshake', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, LEXICON_PATH: lexiconPath },
    });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const h = JSON.parse(lines[0]);
    expect(h.kind).toBe('ashlr.handshake');
    expect(h.version).toBe(packageVersion(import.meta.url));
    expect(h.health.checks[0].status).toBe('absent');
  });
});
