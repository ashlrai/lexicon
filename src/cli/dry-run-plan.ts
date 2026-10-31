/** Setup-compatible marker for a successful mutation preview.
 * Keep existing result fields alongside this marker for CLI consumers.
 */
export function dryRunPlan(dryRun: boolean | undefined): { plan?: true } {
  return dryRun === true ? { plan: true } : {};
}
