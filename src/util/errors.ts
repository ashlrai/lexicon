/**
 * Error inspection helpers shared by every layer (core, CLI, MCP, serve).
 * Dependency-free on purpose: `src/util/` is the bottom of the import graph,
 * so anything may import from it and nothing here may import back.
 */

/** The human-readable text of a thrown value, whether or not it is an Error. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `err` is a Node "no such file or directory" system error. */
export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
