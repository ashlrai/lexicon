/**
 * Module resolve hook: append each resolved URL to the file named by
 * initialize({ file }). Used by cli-startup.test.ts. It records what a
 * process linked, not how long that took.
 */
import { appendFileSync } from 'node:fs';

let file;

export function initialize(data) {
  file = data.file;
}

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (file && resolved.url) appendFileSync(file, `${resolved.url}\n`);
  return resolved;
}
