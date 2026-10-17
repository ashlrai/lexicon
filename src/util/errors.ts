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

/**
 * An error caused by what the caller asked for (an empty canonical, heard and
 * meant the same, a term the schema rejects), as opposed to the state of the
 * machine (a broken lexicon file, a lock that never freed, a permission
 * error). The local API answers the first with 400 and everything else with
 * 500; the CLI and MCP server only ever show the message, which is unchanged.
 */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** True for an `InputError`. Duck-typed by name, like `isProjectTrustError`, so it holds across a mocked core. */
export function isInputError(err: unknown): boolean {
  return err instanceof Error && err.name === 'InputError';
}
