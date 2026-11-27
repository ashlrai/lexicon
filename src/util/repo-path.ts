/**
 * Turn a path git printed (`src/foo.ts`, always with `/`) into a path for
 * `platform`. Git on Windows still uses `/`. A backslash is accepted too.
 */
import path from 'node:path';

export function joinGitPath(root: string, gitRel: string, platform: NodeJS.Platform = process.platform): string {
  const parts = gitRel.split(/[/\\]/).filter((part) => part !== '' && part !== '.');
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(root, ...parts);
}
