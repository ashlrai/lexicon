/**
 * Keep credentials out of text that came back from an upstream (an error body,
 * a status reply) or that names a configured URL, before it reaches an error,
 * the CLI's output or the extension popup.
 */

/** Shortest run of a secret that counts as a leak. */
const WINDOW = 8;

/**
 * Replace every run of 8 or more characters of `text` that also occurs inside
 * one of `secrets` with "[redacted]". Values shorter than 8 are ignored.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>): string {
  const windows = new Set<string>();
  for (const s of secrets) {
    if (typeof s !== 'string' || s.length < WINDOW) continue;
    for (let i = 0; i + WINDOW <= s.length; i++) windows.add(s.slice(i, i + WINDOW));
  }
  if (windows.size === 0 || text.length < WINDOW) return text;
  const covered = new Uint8Array(text.length);
  let any = false;
  for (let i = 0; i + WINDOW <= text.length; i++) {
    if (windows.has(text.slice(i, i + WINDOW))) {
      covered.fill(1, i, i + WINDOW);
      any = true;
    }
  }
  if (!any) return text;
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (covered[i]) {
      while (i < text.length && covered[i]) i++;
      out += '[redacted]';
    } else {
      out += text[i++];
    }
  }
  return out;
}

/**
 * A URL for a message: scheme, host, port and path only. A user name,
 * password, query or fragment (where a token often rides) is dropped, and an
 * unparseable URL is not echoed at all.
 */
export function safeUrlLabel(url: string): string {
  try {
    const u = new URL(url);
    const extra = u.search || u.hash ? ' (query omitted)' : '';
    return `${u.protocol}//${u.host}${u.pathname}${extra}`;
  } catch {
    return '(unparseable URL)';
  }
}
