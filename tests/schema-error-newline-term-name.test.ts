import { describe, expect, it } from 'vitest';
import { LexiconSchema, parseLexicon } from '../src/core/schema.js';

// A term whose canonical holds a newline is itself refused, and the other
// errors that name the term must show the newline as `\n`, not break the line.
describe('error naming a term whose canonical contains a newline', () => {
  const FFFE = '\uFFFE';

  function messageFor(canonical: string): string {
    try {
      parseLexicon({ terms: [{ canonical, aliases: [`a${FFFE}`] }] });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return error.message;
    }
    throw new Error('Expected parseLexicon to throw');
  }

  it('escapes the newline in the term name and keeps one line per issue', () => {
    const message = messageFor('Foo\nBar');
    expect(message).toContain('in term "Foo\\nBar"');
    expect(message).toContain('terms[0].canonical: must not contain control characters or newlines');
    // header + canonical issue + alias issue, nothing split by the name
    expect(message.split('\n')).toHaveLength(3);
    for (const line of message.split('\n').slice(1)) expect(line).toMatch(/^ {2}- terms\[0\]\./);
  });

  it('escapes carriage return, tab, ESC and U+2028 as well', () => {
    const message = messageFor('a\r\t\u001B\u2028b');
    expect(message).toContain('in term "a\\r\\t\\u001B\\u2028b"');
    expect(message.split('\n')).toHaveLength(3);
    expect(message).not.toMatch(/[\r\t\u001B\u2028]/);
  });

  it('still identifies and truncates a long name with a newline', () => {
    const message = messageFor(`${'x'.repeat(30)}\n${'y'.repeat(30)}`);
    expect(message).toContain(`in term "${'x'.repeat(30)}\\n${'y'.repeat(7)}\u2026"`);
    expect(message.split('\n')).toHaveLength(3);
  });

  it('keeps the issue message single-line through safeParse', () => {
    const result = LexiconSchema.safeParse({ terms: [{ canonical: 'Foo\nBar', aliases: [`a${FFFE}`] }] });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected rejection');
    for (const { message } of result.error.issues) expect(message).not.toContain('\n');
  });
});
