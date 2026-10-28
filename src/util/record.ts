/**
 * Object-shape predicates. Dependency-free on purpose: `src/util/` is the
 * bottom of the import graph, so anything may import from it and nothing
 * here may import back.
 */

/** A plain object (not null, not an array): the shape every config merge expects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
