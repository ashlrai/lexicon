import { describe, expect, it } from 'vitest';
import type { Lexicon } from '../../src/core/types.js';
import { Expander, graphemeCount, isExpanderNamedKey } from '../../src/daemon/expander.js';
import type { ExpansionAction } from '../../src/daemon/expander.js';

const lexicon: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Ashlr.AI', aliases: ['Ashler', 'ash ler'] },
    { canonical: 'Supabase', aliases: ['soup a base'] },
    { canonical: 'Zoë', aliases: ['zoey'] },
  ],
};

/** A text field driven by the expander's actions, as a key source would. */
class Field {
  value = '';
  readonly actions: ExpansionAction[] = [];
  constructor(readonly expander: Expander = new Expander(lexicon)) {}

  type(s: string, perKey = true): this {
    for (const chunk of perKey ? [...s] : [s]) {
      this.value += chunk;
      this.apply(this.expander.type(chunk));
    }
    return this;
  }

  backspace(): this {
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this.value)];
    this.value = graphemes.slice(0, -1).map((g) => g.segment).join('');
    this.apply(this.expander.key('Backspace'));
    return this;
  }

  private apply(action: ExpansionAction | undefined): void {
    if (!action) return;
    this.actions.push(action);
    const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(this.value)];
    expect(action.backspaces).toBeLessThanOrEqual(graphemes.length);
    this.value = graphemes.slice(0, graphemes.length - action.backspaces).map((g) => g.segment).join('') + action.insert;
  }
}

describe('Expander', () => {
  it('expands an alias when the space after it is typed', () => {
    const f = new Field().type('I work at Ashler');
    expect(f.actions).toHaveLength(0);
    f.type(' ');
    expect(f.value).toBe('I work at Ashlr.AI ');
    expect(f.actions[0]).toMatchObject({ kind: 'expand', backspaces: 7, insert: 'Ashlr.AI ' });
    expect(f.actions[0]!.replacements).toEqual([{ original: 'Ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI' }]);
    expect(f.expander.buffer).toBe(f.value);
  });

  it('keeps trailing punctuation and corrects when the following space arrives', () => {
    const f = new Field().type('at Ashler.');
    expect(f.actions).toHaveLength(0);
    f.type(' Next');
    expect(f.value).toBe('at Ashlr.AI. Next');
  });

  it('never fires inside a URL, an email or a domain as it is typed', () => {
    expect(new Field().type('mail foo@ashler.io and see https://ashler.com/x ').value).toBe('mail foo@ashler.io and see https://ashler.com/x ');
  });

  it('expands a multi-word alias whose first word was already settled', () => {
    const f = new Field().type('built on soup a base today');
    expect(f.value).toBe('built on Supabase today');
    expect(f.actions).toHaveLength(1);
    expect(new Field().type('ash ler ').value).toBe('Ashlr.AI ');
  });

  it('corrects a whole injected chunk in one action', () => {
    const f = new Field().type('Ashler and soup a base ', false);
    expect(f.value).toBe('Ashlr.AI and Supabase ');
    expect(f.actions).toHaveLength(1);
    expect(f.actions[0]!.backspaces).toBe('Ashler and soup a base '.length);
  });

  it('does not touch an unfinished word or a chunk with no whitespace', () => {
    expect(new Field().type('Ashler').actions).toHaveLength(0);
    expect(new Field().type('Ashler', false).actions).toHaveLength(0);
  });

  it('leaves non-alias words alone: no phonetic or fuzzy guessing by default', () => {
    expect(new Field().type('Ashlerr Ashlir ').value).toBe('Ashlerr Ashlir ');
  });

  it('undoes on Backspace right after an expansion and never re-expands that word', () => {
    const f = new Field().type('at Ashler ');
    expect(f.value).toBe('at Ashlr.AI ');
    f.backspace();
    expect(f.value).toBe('at Ashler');
    expect(f.actions[1]).toMatchObject({ kind: 'undo', insert: 'Ashler' });
    f.type(' is fine ');
    expect(f.value).toBe('at Ashler is fine ');
    // A later occurrence still expands.
    f.type('Ashler ');
    expect(f.value).toBe('at Ashler is fine Ashlr.AI ');
  });

  it('a Backspace after typing more is an ordinary edit, not an undo', () => {
    const f = new Field().type('Ashler x');
    expect(f.value).toBe('Ashlr.AI x');
    f.backspace();
    expect(f.value).toBe('Ashlr.AI ');
    expect(f.actions).toHaveLength(1);
    expect(f.expander.buffer).toBe('Ashlr.AI ');
  });

  it('re-checks a word the user backspaced into and retyped', () => {
    const f = new Field().type('Ashlex');
    f.backspace().backspace();
    f.type('er ');
    expect(f.value).toBe('Ashlr.AI ');
  });

  it('never matches starting inside its own output', () => {
    const f = new Field().type('Ashler ler ');
    expect(f.value).toBe('Ashlr.AI ler ');
  });

  it.each(['Enter', 'Tab', 'Escape', 'Left', 'Home', 'reset'] as const)('%s forgets the buffer, so nothing earlier is rewritten', (k) => {
    const f = new Field().type('soup a');
    f.expander.key(k);
    expect(f.expander.buffer).toBe('');
    f.value = '';
    f.type(' base ');
    expect(f.value).toBe(' base ');
  });

  it('counts Backspaces in graphemes', () => {
    expect(graphemeCount('Zoë 👍🏽 ')).toBe(6);
    const f = new Field().type('hi 👍🏽 zoey ', false);
    expect(f.value).toBe('hi 👍🏽 Zoë ');
    expect(f.actions[0]!.backspaces).toBe(5);
  });

  it('keeps a bounded buffer cut at whitespace, and still expands after it', () => {
    const e = new Expander(lexicon, { maxBuffer: 40 });
    const f = new Field(e).type('word '.repeat(30));
    expect(e.buffer.length).toBeLessThanOrEqual(40);
    expect(e.buffer.startsWith('word ')).toBe(true);
    f.type('Ashler ');
    expect(f.value.endsWith('word Ashlr.AI ')).toBe(true);
  });

  it.each(['', '.'])('does not expand a suffix of a discarded long token (%j)', (separator) => {
    const e = new Expander(lexicon, { maxBuffer: 32 });
    const input = `${'x'.repeat(33)}${separator}Ashler `;
    const f = new Field(e).type(input);
    expect(f.value).toBe(input);
    expect(f.actions).toHaveLength(0);
    expect(e.buffer.length).toBeLessThanOrEqual(32);
    f.type('Ashler ');
    expect(f.value).toBe(`${input}Ashlr.AI `);
  });

  it('discards the rest of a long token in an injected chunk and resumes at whitespace', () => {
    const f = new Field(new Expander(lexicon, { maxBuffer: 32 })).type('x'.repeat(33));
    f.type('Ashler Ashler ', false);
    expect(f.value).toBe(`${'x'.repeat(33)}Ashler Ashlr.AI `);
  });

  it('does not recover discarded context by backspacing into it', () => {
    const f = new Field(new Expander(lexicon, { maxBuffer: 32 })).type('x'.repeat(33));
    f.backspace().type('Ashler ');
    expect(f.value).toBe(`${'x'.repeat(32)}Ashler `);
  });

  it('does not expose a discarded token again by deleting its following space', () => {
    const f = new Field(new Expander(lexicon, { maxBuffer: 32 })).type(`${'x'.repeat(33)} `);
    f.backspace().type('Ashler ');
    expect(f.value).toBe(`${'x'.repeat(33)}Ashler `);
  });

  it('keeps undo available when the expansion itself exceeds the context buffer', () => {
    const e = new Expander({ version: 1, terms: [{ canonical: 'A'.repeat(64), aliases: ['Ashler'] }] }, { maxBuffer: 32 });
    const f = new Field(e).type('at Ashler ');
    expect(f.value).toBe(`at ${'A'.repeat(64)} `);
    expect(e.buffer.length).toBeLessThanOrEqual(32);
    f.backspace();
    expect(f.value).toBe('at Ashler');
    expect(e.buffer.length).toBeLessThanOrEqual(32);
  });

  it('undoes a long injected chunk after its beginning left the context buffer', () => {
    const input = `Ashler ${'word '.repeat(20)}`;
    const e = new Expander(lexicon, { maxBuffer: 32 });
    const f = new Field(e).type(input, false);
    expect(f.value).toBe(`Ashlr.AI ${'word '.repeat(20)}`);
    expect(e.buffer.length).toBeLessThanOrEqual(32);
    f.backspace();
    expect(f.value).toBe(input.slice(0, -1));
    expect(e.buffer.length).toBeLessThanOrEqual(32);
  });

  it('preserves a character sharing the first matched grapheme when expanding and undoing', () => {
    const f = new Field().type('keep \u0600Ashler ');
    expect(f.value).toBe('keep \u0600Ashlr.AI ');
    expect(f.expander.buffer).toBe(f.value);
    f.backspace();
    expect(f.value).toBe('keep \u0600Ashler');
    expect(f.expander.buffer).toBe(f.value);
  });

  it('undoes a canonical whose first mark joined the preceding grapheme', () => {
    const e = new Expander({ version: 1, terms: [{ canonical: '\u0301Name', aliases: ['Ashler'] }] });
    const f = new Field(e).type('keep Ashler ');
    expect(f.value).toBe('keep \u0301Name ');
    f.backspace();
    expect(f.value).toBe('keep Ashler');
    expect(e.buffer).toBe(f.value);
  });

  it.each([NaN, Infinity, -Infinity])('rejects a non-finite buffer limit (%s)', (maxBuffer) => {
    expect(() => new Expander(lexicon, { maxBuffer })).toThrow(/finite/);
  });

  it('expands a multi-word alias when its final word is a number', () => {
    const e = new Expander({ version: 1, terms: [{ canonical: 'GPT-4', aliases: ['gee pee tee 4'] }] });
    expect(new Field(e).type('gee pee tee 4 ').value).toBe('GPT-4 ');
  });

  it('uses a new lexicon from the next word, keeping the buffer', () => {
    const e = new Expander({ version: 1, terms: [] });
    const f = new Field(e).type('Ashler ');
    expect(f.value).toBe('Ashler ');
    e.setIndex(lexicon);
    expect(e.buffer).toBe('Ashler ');
    f.type('and Ashler ');
    expect(f.value).toBe('Ashler and Ashlr.AI ');
  });

  it('can opt into the fuzzier tiers', () => {
    const e = new Expander(lexicon, { normalize: { phonetic: true, fuzzy: true } });
    expect(new Field(e).type('Ashlerr ').value).toBe('Ashlr.AI ');
  });

  it('recognises the named keys', () => {
    expect(isExpanderNamedKey('Backspace')).toBe(true);
    expect(isExpanderNamedKey('a')).toBe(false);
  });
});
