/**
 * Windows path rules, exercised with path.win32 on this host. A real Windows
 * process is not required for these cases.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPathFor } from '../src/cli/cmd-install.js';
import { joinGitPath } from '../src/util/repo-path.js';
import { findOnPathSync, findRunnableSync } from '../src/util/which.js';

describe('joinGitPath with path.win32', () => {
  it('joins a forward-slash git path onto a drive root', () => {
    expect(joinGitPath('C:\\repo', 'src/cli/index.ts', 'win32')).toBe(path.win32.join('C:\\repo', 'src', 'cli', 'index.ts'));
    expect(joinGitPath('C:\\repo', 'src/cli/index.ts', 'win32')).toBe('C:\\repo\\src\\cli\\index.ts');
  });

  it('accepts a backslash git path and drops empty parts', () => {
    expect(joinGitPath('C:\\repo', 'src\\\\voice\\models.ts', 'win32')).toBe('C:\\repo\\src\\voice\\models.ts');
    expect(joinGitPath('/repo', 'src/voice/models.ts', 'linux')).toBe('/repo/src/voice/models.ts');
  });

  it('does not treat a POSIX join as a Windows drive path', () => {
    expect(path.win32.isAbsolute('C:\\Users\\me')).toBe(true);
    expect(path.posix.isAbsolute('C:\\Users\\me')).toBe(false);
    expect(path.win32.isAbsolute('/Users/me')).toBe(true);
  });
});

describe('Windows config paths use APPDATA and path.win32', () => {
  const home = 'C:\\Users\\me';
  const base = { home, cwd: 'C:\\repo', platform: 'win32' as const, project: false };

  it('writes Claude Desktop and VS Code under APPDATA', () => {
    const appData = 'C:\\Users\\me\\AppData\\Roaming';
    const ctx = { ...base, env: { APPDATA: appData } };
    expect(configPathFor('claude-desktop', ctx)).toBe(path.win32.join(appData, 'Claude', 'claude_desktop_config.json'));
    expect(configPathFor('vscode', ctx)).toBe(path.win32.join(appData, 'Code', 'User', 'mcp.json'));
  });

  it('falls back to AppData\\Roaming when APPDATA is blank', () => {
    const ctx = { ...base, env: { APPDATA: ' ' } };
    expect(configPathFor('claude-desktop', ctx)).toBe(
      path.win32.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    );
  });
});

describe('npm bin entries are node programs', () => {
  it('points lexicon and lexicon-mcp at JavaScript with a node shebang', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string> };
    const sourceFor: Record<string, string> = {
      './dist/cli/index.js': '../src/cli/index.ts',
      './dist/mcp/server.js': '../src/mcp/server.ts',
    };
    expect(Object.keys(pkg.bin).sort()).toEqual(['lexicon', 'lexicon-mcp']);
    for (const rel of Object.values(pkg.bin)) {
      expect(rel.endsWith('.sh')).toBe(false);
      const source = sourceFor[rel];
      expect(source, rel).toBeDefined();
      const text = readFileSync(new URL(source, import.meta.url), 'utf8');
      expect(text.startsWith('#!/usr/bin/env node')).toBe(true);
    }
  });
});

describe('Windows executable lookup', () => {
  it('builds candidates with path.win32 and prefers git.exe over git.cmd', () => {
    const dir = 'C:\\Program Files\\Git\\cmd';
    const env = { PATH: dir, PATHEXT: '.CMD;.EXE' };
    const present = new Set([
      path.win32.join(dir, 'git.CMD'),
      path.win32.join(dir, 'git.EXE'),
      path.win32.join(dir, 'git.cmd'),
      path.win32.join(dir, 'git.exe'),
    ]);
    const exists = (candidate: string) => present.has(candidate);
    expect(findOnPathSync('git', { platform: 'win32', env, exists })).toBe(path.win32.join(dir, 'git.CMD'));
    expect(findRunnableSync('git', { platform: 'win32', env, exists })).toBe(path.win32.join(dir, 'git.EXE'));
  });
});
