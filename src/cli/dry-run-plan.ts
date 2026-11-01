/** Mark successful mutation previews, including no-ops, consistently.
 * Applied results and failures must not carry `plan`; failures may still carry
 * `dryRun` to report the requested mode. Call only on the success path.
 */
export function dryRunPlan(dryRun: boolean | undefined): { plan?: true; dryRun?: true } {
  return dryRun === true ? { plan: true, dryRun: true } : {};
}
