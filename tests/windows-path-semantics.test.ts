/**
 * Windows path rules, exercised with path.win32 on this host. A real Windows
 * process is not required for these cases.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
