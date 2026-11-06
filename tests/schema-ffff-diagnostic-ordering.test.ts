import { describe, expect, it } from 'vitest';
import { LexiconSchema, UNENCODABLE_NOTE, findUnencodableChar, parseLexicon } from '../src/core/schema.js';

const reason = `must not contain U+FFFF (${UNENCODABLE_NOTE})`;

// Where the U+FFFF diagnostic stands against the other checks on the same
// input. A field or list entry that fails a *content* check (control
// characters, the word limit) is still named as carrying U+FFFF: both issues
// land on the same path, the content failure first. A *type* failure is
// different: a non-string entry anywhere in a list keeps that list's strings
// from reaching the unencodable check, and a wrong-typed field keeps the
// term-level check from running at all, so U+FFFF is only identified on the
// next pass, once the shape is repaired. A failure in another term, another
// list or another top-level key never defers it.
const issues = (raw: unknown) => {
  const result = LexiconSchema.safeParse(raw);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected U+FFFF to be rejected');
  return result.error.issues.map(({ path, message }) => ({ path, message }));
};

describe('U+FFFF diagnostic against other validation failures', () => {
  it.each([
    [
      'a term scalar field',
      { terms: [{ canonical: 'X', notes: 'a\nb￿' }] },
      ['terms', 0, 'notes'],
      `${reason} in term "X"`,
    ],
    [
      'a term list entry',
      { terms: [{ canonical: 'X', aliases: ['ok', 'a\nb￿'] }] },
      ['terms', 0, 'aliases', 1],
      `${reason} in term "X"`,
    ],
    [
      'a settings list entry',
      { terms: [], settings: { packs: ['a\nb￿'] } },
      ['settings', 'packs', 0],
      reason,
    ],
  ])('is still identified in %s that also fails the control-character check', (_where, raw, path, unencodable) => {
    expect(issues(raw)).toEqual([
      { path, message: 'must not contain control characters or newlines' },
      { path, message: unencodable },
    ]);
    expect(findUnencodableChar('a\nb￿')).toBe('U+FFFF');
  });

  // Each free-text field has its own cap (canonical/aliases/never and the
  // settings lists take LIMITS.word = 80, phonetic/notes LIMITS.text = 200,
  // createdAt 64), so every row carries the length its field refuses.
  it.each([
    [
      'a term scalar field',
      { terms: [{ canonical: 'X', phonetic: `${'a'.repeat(210)}￿` }] },
      ['terms', 0, 'phonetic'],
      'must be at most 200 characters',
      `${reason} in term "X"`,
    ],
    [
      'a term list entry',
      { terms: [{ canonical: 'X', never: [`${'a'.repeat(90)}￿`] }] },
      ['terms', 0, 'never', 0],
      'must be at most 80 characters',
      `${reason} in term "X"`,
    ],
    [
      'a settings list entry',
      { terms: [], settings: { protectedWords: [`${'a'.repeat(90)}￿`] } },
      ['settings', 'protectedWords', 0],
      'must be at most 80 characters',
      reason,
    ],
  ])('is still identified in %s that also fails the word-length check', (_where, raw, path, tooLong, unencodable) => {
    expect(issues(raw)).toEqual([
      { path, message: tooLong },
      { path, message: unencodable },
    ]);
  });

  // Each row: a list carrying U+FFFF and one non-string entry, the type
  // error reported while the shape is wrong, the repaired list, and the
  // path where U+FFFF is identified on the next pass.
  const LISTS: ReadonlyArray<readonly [string, unknown, (string | number)[], string, unknown, string, string?]> = [
    ['aliases', { terms: [{ canonical: 'X', aliases: ['a￿', 42] }] }, ['terms', 0, 'aliases', 1], 'number', { terms: [{ canonical: 'X', aliases: ['ok', 'a￿'] }] }, 'terms[0].aliases[1]', ` in term "X"`],
    ['never', { terms: [{ canonical: 'X', never: [42, 'n￿'] }] }, ['terms', 0, 'never', 0], 'number', { terms: [{ canonical: 'X', never: ['ok', 'n￿'] }] }, 'terms[0].never[1]', ` in term "X"`],
    ['protectedWords', { terms: [], settings: { protectedWords: ['w￿', null] } }, ['settings', 'protectedWords', 1], 'null', { terms: [], settings: { protectedWords: ['w￿', 'ok'] } }, 'settings.protectedWords[0]'],
    ['packs', { terms: [], settings: { packs: [42, 'p￿'] } }, ['settings', 'packs', 0], 'number', { terms: [], settings: { packs: ['ok', 'p￿'] } }, 'settings.packs[1]'],
  ];

  it.each(LISTS)('waits for a non-string entry in %s, then is identified at its own index on the next pass', (_field, raw, typePath, received, fixed, printed, inTerm = '') => {
    // While the list holds a non-string entry, the type error is all a hand
    // editor sees: the unencodable check runs on the cleaned list, which a
    // failed element keeps from being built.
    expect(issues(raw)).toEqual([
      { path: typePath, message: `Invalid input: expected string, received ${received}` },
    ]);

    expect(() => parseLexicon(fixed)).toThrow(`${printed}: ${reason}${inTerm}`);
  });

  it('waits for a wrong-typed field anywhere in the same term, not only in the same list', () => {
    // The term-level check runs on the parsed term, so a wrong-typed field
    // defers every unencodable report for that term, including fields whose
    // own shape was fine.
    expect(issues({ terms: [{ canonical: 'X', hits: 'x', aliases: ['a￿'], notes: 'n￿' }] })).toEqual([
      { path: ['terms', 0, 'hits'], message: 'Invalid input: expected number, received string' },
    ]);
    expect(() => parseLexicon({ terms: [{ canonical: 'X', hits: 1, aliases: ['a￿'], notes: 'n￿' }] })).toThrow(
      `terms[0].aliases[0]: ${reason} in term "X"`,
    );
  });

  it('is not deferred by a failure in another term, another list or a top-level key', () => {
    expect(
      issues({
        version: 'x',
        terms: [
          { canonical: 'A', aliases: [42] },
          { canonical: 'B', notes: 'n￿' },
        ],
        settings: { protectedWords: [null], packs: ['p￿'] },
      }),
    ).toEqual([
      { path: ['version'], message: 'Invalid input: expected 1' },
      { path: ['terms', 0, 'aliases', 0], message: 'Invalid input: expected string, received number' },
      { path: ['terms', 1, 'notes'], message: `${reason} in term "B"` },
      { path: ['settings', 'protectedWords', 0], message: 'Invalid input: expected string, received null' },
      { path: ['settings', 'packs', 0], message: reason },
    ]);
  });
});
