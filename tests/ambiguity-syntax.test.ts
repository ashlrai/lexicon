/**
 * Tests for the syntactic rule layer: sentence splitting, passive voice,
 * dangling pronouns. These pin the contract of the POS-free port of
 * Pellucid's spaCy detectors.
 */
import { describe, expect, it } from 'vitest';
import {
  estimateNominalCount,
  findDanglingPronouns,
  findPassiveVoice,
  splitSentences,
} from '../src/ambiguity/syntax.js';

describe('splitSentences', () => {
  it('splits on terminal punctuation before a capital', () => {
    const text = 'First sentence here. Second one follows! Is this third? Yes.';
    const sents = splitSentences(text);
    expect(sents.map((s) => s.text)).toEqual([
      'First sentence here.',
      'Second one follows!',
      'Is this third?',
      'Yes.',
    ]);
  });

  it('does not split before a lowercase word (abbreviations)', () => {
    const sents = splitSentences('Use the values, i.e. the ones above, here.');
    expect(sents).toHaveLength(1);
  });

  it('splits bulleted lines', () => {
    const text = '- First requirement\n- Second requirement\n- Third requirement';
    const sents = splitSentences(text);
    expect(sents).toHaveLength(3);
    expect(sents[1].text).toBe('- Second requirement');
  });

  it('trims whitespace off the span', () => {
    const sents = splitSentences('  Hello world.   Next up.  ');
    expect(sents[0]).toMatchObject({ start: 2, end: 14 });
    expect(sents[1].text).toBe('Next up.');
  });
});

describe('findPassiveVoice', () => {
  it('flags be + past participle', () => {
    const findings = findPassiveVoice('Sensitive data must be protected at all times.');
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('passive_voice');
    expect(findings[0].confidence).toBe(0.7);
  });

  it('flags adverb-separated passive', () => {
    const findings = findPassiveVoice('The request is then silently dropped.');
    expect(findings).toHaveLength(1);
  });

  it('flags irregular participles', () => {
    expect(findPassiveVoice('The event was written to the log.')).toHaveLength(1);
    expect(findPassiveVoice('The packet was sent twice.')).toHaveLength(1);
    expect(findPassiveVoice('The rule is kept for compatibility.')).toHaveLength(1);
  });

  it('does not flag active voice', () => {
    expect(findPassiveVoice('The agent writes the event to the log.')).toHaveLength(0);
    expect(findPassiveVoice('Operators review every finding.')).toHaveLength(0);
  });

  it('emits one finding per passive sentence', () => {
    const text = 'The data is stored. The data is also reviewed. Operators check the rest.';
    expect(findPassiveVoice(text)).toHaveLength(2);
  });
});

describe('estimateNominalCount', () => {
  it('counts determiner-adjacent nouns, skips verb position', () => {
    // 'process' follows 'shall' -> verb position, not counted.
    expect(estimateNominalCount('The system shall process the data')).toBe(2);
  });

  it('counts glossary and capitalized mid-sentence names', () => {
    // 'goes' is a bare verb-shaped token: no determiner, not glossary, no
    // noun suffix - not counted.
    expect(estimateNominalCount('The token goes to Memcache nightly')).toBe(2);
  });

  it('ignores closed-class and verb-shaped words', () => {
    expect(estimateNominalCount('It is being handled carefully')).toBe(0);
  });
});

describe('findDanglingPronouns', () => {
  it('flags a leading pronoun with no prior sentence', () => {
    const findings = findDanglingPronouns('It must respond quickly.');
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('pronoun_antecedent');
  });

  it('flags a leading pronoun when the previous sentence has no nominal', () => {
    const findings = findDanglingPronouns('Everything is handled. It breaks often.');
    expect(findings).toHaveLength(1);
  });

  it('flags a leading pronoun when too many nominals precede it', () => {
    const findings = findDanglingPronouns(
      'The server, the client and the cache share state. It must stay consistent.',
    );
    expect(findings).toHaveLength(1);
  });

  it('does not flag when one nominal precedes', () => {
    const findings = findDanglingPronouns('The server restarts nightly. It logs each boot.');
    expect(findings).toHaveLength(0);
  });

  it('skips determiner uses of this/that', () => {
    const findings = findDanglingPronouns('This document lists the rules. That report stays internal.');
    expect(findings).toHaveLength(0);
  });
});
