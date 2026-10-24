/**
 * One text order for every machine. `localeCompare` without a locale follows
 * the user's (`LANG`, `LC_ALL`), so under `sv_SE.UTF-8` `Äpple` sorted after
 * `Zeta`: the same lexicon listed its stats, suggestions and harvest in
 * another order, and a harvest capped at 5000 files scanned other files.
 * Pure; no IO.
 */
let collator: Intl.Collator | undefined;

/**
 * A fixed `en` collation, then code units for the strings it calls equal
 * (`Café` precomposed and with a combining accent), so the result never
 * depends on the user's locale and is a total order.
 */
export function compareText(a: string, b: string): number {
  collator ??= new Intl.Collator('en');
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}
