import { describe, expect, it } from 'vitest';
import { parseLexicon } from '../src/core/schema.js';

function errorMessage(canonical: string, notes = 'bad\uDC00'): string {
  try {
    parseLexicon({ terms: [{ canonical, notes }] });
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error('Expected invalid input to be rejected');
}

describe('schema error preview reference', () => {
  it('cleans the canonical and escapes each unencodable unit without escaping ordinary punctuation', () => {
    const message = errorMessage('  \u200bAcme"\\\uFFFE\uD800🚀\uDC00  ');
    expect(message).toContain('in term "Acme"\\\\uFFFE\\uD800🚀\\uDC00"');
    expect(message).toContain('canonical: must not contain U+FFFE');
    expect(message).toContain('notes: must not contain U+DC00');
  });

  it.each([
    [34, 'A'.repeat(34) + '\\uFFFF'],
    [35, 'A'.repeat(35) + '\\uFF…'],
  ])('uses the escaped UTF-16 length at the %i-character boundary', (count, label) => {
    expect(errorMessage('A'.repeat(count) + '\uFFFF')).toContain(`in term "${label}"`);
    expect(label.length).toBe(40);
  });

  it('can cut a valid surrogate pair at the preview boundary', () => {
    const message = errorMessage('A'.repeat(38) + '🚀B');
    expect(message).toContain(`in term "${'A'.repeat(38)}\uD83D…"`);
  });

  it('does not add a term label to settings errors', () => {
    expect(() => parseLexicon({ settings: { packs: ['bad\uFFFF'] } }))
      .toThrow('settings.packs[0]: must not contain U+FFFF (U+FFFE, U+FFFF and unpaired surrogates fit no file format)');
    try {
      parseLexicon({ settings: { packs: ['bad\uFFFF'] } });
    } catch (error) {
      expect((error as Error).message).not.toContain('in term');
    }
  });
});
