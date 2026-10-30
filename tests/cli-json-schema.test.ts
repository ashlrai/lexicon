import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

describe('versioned CLI JSON snapshots', () => {
  for (const command of ['status', 'doctor', 'stats']) {
    it(`${command} --json emits one versioned document`, () => {
      const home = mkdtempSync(path.join(os.tmpdir(), 'lexicon-json-'));
      homes.push(home);
      execFileSync('git', ['init', '-q', home]);
      const lexicon = path.join(home, 'lexicon.yaml');
      writeFileSync(lexicon, 'version: 1\nterms:\n  - canonical: Ashlr.AI\n    aliases: [Ashler]\n');
      const env = {
        ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
        LEXICON_PATH: lexicon, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        GEMINI_CLI_HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming'), PATH: '', NO_COLOR: '1',
      };
      const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', '--cwd', home, command, ...args], { env, encoding: 'utf8' });
      const json = run(['--json']);
      const text = run([]);
      expect(json.error).toBeUndefined();
      expect(json.status).toBe(0);
      expect(json.status).toBe(text.status);
      expect(json.stderr).toBe('');
      const report = JSON.parse(json.stdout);
      expect(report.schemaVersion).toBe(1);
      // Normalize paths after parsing so Windows JSON escaping is preserved.
      const snapshot = JSON.parse(JSON.stringify(report, (_key, value: unknown) =>
        typeof value === 'string' ? value.split(home).join('<HOME>').replaceAll('\\', '/') : value));
      if (command !== 'stats') {
        expect(snapshot.checks.length).toBeGreaterThan(0);
        expect(snapshot.versions).toEqual({ lexicon: expect.any(String), node: expect.any(String), platform: expect.any(String) });
        // Health details vary with OS and installed tools; snapshot their schema.
        for (const check of snapshot.checks) {
          expect(check).toEqual({ level: expect.any(String), message: expect.any(String), status: check.level, summary: check.message });
        }
        snapshot.checks = [{ level: '<LEVEL>', message: '<MESSAGE>', status: '<LEVEL>', summary: '<MESSAGE>' }];
        snapshot.versions = { lexicon: '<VERSION>', node: '<NODE>', platform: '<PLATFORM>' };
      }
      expect(snapshot).toMatchSnapshot();
      expect(text.stdout).not.toContain('schemaVersion');
      if (command !== 'stats') {
        rmSync(lexicon);
        const failed = run(['--json']);
        expect(failed.status).toBe(1);
        expect(JSON.parse(failed.stdout)).toMatchObject({ schemaVersion: 1, schema_version: 1, ok: false });
      }
    });
  }
});
