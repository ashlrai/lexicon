import { execFileSync } from 'node:child_process';

/**
 * Use content history, never the deployment clock. Git resolves the repository
 * root so this works from both `web/` and a repository-root build invocation.
 * Archives without .git intentionally omit lastmod rather than inventing one.
 */
export function gitLastModified(paths: readonly string[], cwd = process.cwd()): string | undefined {
  if (paths.length === 0) return undefined;
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
    const timestamp = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', ...paths.map((path) => `:(literal)${path}`)],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    ).trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return undefined;
    return Number.isNaN(Date.parse(timestamp)) ? undefined : timestamp;
  } catch {
    return undefined;
  }
}
