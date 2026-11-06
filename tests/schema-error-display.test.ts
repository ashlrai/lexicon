import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  LexiconSchema,
  TermSchema,
  UNENCODABLE_NOTE,
  findUnencodableChar,
  parseLexicon,
} from '../src/core/schema.js';

/**
 * Error-display contract for unpaired surrogates: the thrown error and every
 * structured issue message show the escaped code unit (as the ASCII text
 * \uD83D), never the raw unit. A raw unpaired surrogate cannot be encoded in
 * UTF-8, so a terminal, a rewritten lexicon file or a log pipeline would turn
 * it into U+FFFD or mojibake and the user could no longer tell which code
 * unit was rejected. A valid surrogate pair (an emoji) stays raw on purpose:
 * it encodes and displays cleanly.
 */

const REASON = UNENCODABLE_NOTE;

function thrownMessage(raw: unknown): string {
  try {
    parseLexicon(raw);
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected invalid input to be rejected');
}

/** Every surface a user or agent can read the failure on: the thrown parseLexicon error and each safeParse issue message. */
function displayedErrors(raw: unknown): string[] {
  const result = LexiconSchema.safeParse(raw);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected invalid input to be rejected');
  return [thrownMessage(raw), ...result.error.issues.map((issue) => issue.message)];
}

/**
 * The displayed text itself is encodable: no unpaired surrogate, U+FFFE or
 * U+FFFF remains in it, so it survives a UTF-8 round-trip unchanged. Paired
 * surrogates (emoji) are encodable and allowed.
 */
function expectDisplaySafe(message: string): void {
  expect(findUnencodableChar(message)).toBeUndefined();
  expect(Buffer.from(message, 'utf8').toString('utf8')).toBe(message);
}

describe('unpaired surrogate display in validation errors', () => {
  it.each([
    ['a high surrogate', 'D83D'],
    ['the last high surrogate', 'DBFF'],
    ['a low surrogate', 'DC00'],
    ['the last low surrogate', 'DFFF'],
  ])('shows the escaped code unit, never the raw unit, for %s in the term name', (_description, hex) => {
    const unit = String.fromCharCode(parseInt(hex, 16));
    const canonical = `Rocket ${unit}ship`;

    const messages = displayedErrors({ terms: [{ canonical }] });
    for (const message of messages) {
      expect(message).toContain(`\\u${hex}ship`);
      expect(message).not.toContain(unit);
      expectDisplaySafe(message);
    }
    expect(thrownMessage({ terms: [{ canonical }] })).toBe(
      `Invalid lexicon:\n  - terms[0].canonical: must not contain U+${hex} (${REASON}) in term "Rocket \\u${hex}ship"`,
    );
  });

  it.each(['D83D', 'DC00'])('escapes the name on a standalone term too (U+%s)', (hex) => {
    const unit = String.fromCharCode(parseInt(hex, 16));
    const result = TermSchema.safeParse({ canonical: `A${unit}B` });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected the unpaired surrogate to be rejected');
    expect(result.error.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: ['canonical'], message: `must not contain U+${hex} (${REASON}) in term "A\\u${hex}B"` },
    ]);
    for (const issue of result.error.issues) {
      expect(issue.message).not.toContain(unit);
      expectDisplaySafe(issue.message);
    }
  });

  it('escapes the name wherever the failing field is, when the canonical itself carries the surrogate', () => {
    const messages = displayedErrors({ terms: [{ canonical: 'Rocket \uD83Dship', notes: 'ok\uDC00' }] });

    // Thrown error plus one issue per field; both issue lines label the term
    // with the escaped name, and neither carries a raw unit.
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).toContain('in term "Rocket \\uD83Dship"');
      expect(message).not.toContain('\uD83D');
      expect(message).not.toContain('\uDC00');
      expectDisplaySafe(message);
    }
  });

  it('escapes every unpaired surrogate in the name while a valid pair stays raw', () => {
    // 🚀 is the pair D83D DE80; the unpaired units here (D800, DFFF) share no
    // code unit with it, so their raw absence is asserted directly.
    const canonical = 'Rocket \uD800 🚀 \uDFFFship';

    for (const message of displayedErrors({ terms: [{ canonical }] })) {
      expect(message).toContain('in term "Rocket \\uD800 🚀 \\uDFFFship"');
      expect(message).toContain('🚀');
      expect(message).not.toContain('\uD800');
      expect(message).not.toContain('\uDFFF');
      expectDisplaySafe(message);
    }
  });

  it('displays the escaped unit for a surrogate spelled as a YAML escape, the way a file carries it', () => {
    // No UTF-8 file can hold a raw lone surrogate; a double-quoted YAML scalar
    // spells one as \uD83D and the parser hands the decoded unit to the schema.
    const raw = parseYaml('terms:\n  - canonical: "Rocket \\uD83Dship"\n');

    for (const message of displayedErrors(raw)) {
      expect(message).toContain('in term "Rocket \\uD83Dship"');
      expect(message).not.toContain('\uD83D');
      expectDisplaySafe(message);
    }
    expect(thrownMessage(raw)).toBe(
      `Invalid lexicon:\n  - terms[0].canonical: must not contain U+D83D (${REASON}) in term "Rocket \\uD83Dship"`,
    );
  });
});
