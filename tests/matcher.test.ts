import { describe, expect, it } from 'vitest';
import { STOPLIST, buildIndex, findReplacements, phoneticKey, similarity } from '../src/core/matcher.js';
import type { Lexicon, Replacement, Term } from '../src/core/types.js';

function lex(terms: Term[], settings?: Lexicon['settings']): Lexicon {
  return settings ? { version: 1, terms, settings } : { version: 1, terms };
}

const ASHLR: Term = { canonical: 'Ashlr.AI', aliases: ['Ashler', 'Ashlar', 'Ashler AI'] };
const K8S: Term = { canonical: 'Kubernetes', aliases: [] };
const SAAS: Term = { canonical: 'SaaS', aliases: [] };

function find(text: string, terms: Term[], opts?: Parameters<typeof findReplacements>[2], settings?: Lexicon['settings']): Replacement[] {
  return findReplacements(text, buildIndex(lex(terms, settings)), opts);
}

function apply(text: string, reps: Replacement[]): string {
  let out = text;
  for (let i = reps.length - 1; i >= 0; i--) out = out.slice(0, reps[i].start) + reps[i].replacement + out.slice(reps[i].end);
  return out;
}

describe('helpers', () => {
  it('phoneticKey is alpha-only double metaphone primary', () => {
    expect(phoneticKey("Cooper Nettie's")).toBe(phoneticKey('Kubernetes'));
    expect(phoneticKey('KPRNTS')).not.toBe('');
    expect(phoneticKey('123')).toBe('');
    expect(phoneticKey('')).toBe('');
  });

  it('similarity is normalized edit distance', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('', '')).toBe(1);
    expect(similarity('ashlor', 'ashlr')).toBeCloseTo(1 - 1 / 6, 5);
    expect(similarity('abc', 'xyz')).toBe(0);
    expect(similarity('abc', '')).toBe(0);
  });

  it('similarity counts an adjacent transposition as one edit (optimal string alignment)', () => {
    expect(similarity('levenshtien', 'levenshtein')).toBeCloseTo(1 - 1 / 11, 5);
    expect(similarity('levenshtien', 'levenshtein')).toBeGreaterThanOrEqual(0.9);
    expect(similarity('ab', 'ba')).toBe(0.5);
    // OSA, not full Damerau: "ca" -> "abc" still needs three edits
    expect(similarity('ca', 'abc')).toBe(0);
    // strings longer than the OSA cut-over fall back to plain Levenshtein and stay in 0..1
    const long = 'x'.repeat(60);
    expect(similarity(long, long)).toBe(1);
    expect(similarity(long, `${long}y`)).toBeCloseTo(1 - 1 / 61, 5);
  });

  it('STOPLIST is a sizeable lowercase set', () => {
    expect(STOPLIST.size).toBeGreaterThan(300);
    for (const w of ['the', 'and', 'for', 'was', 'sauce', 'ash', 'head', 'off', 'auth']) expect(STOPLIST.has(w)).toBe(true);
    for (const w of STOPLIST) expect(w).toBe(w.toLowerCase());
  });
});

describe('exact alias pass', () => {
  it('matches a single-word alias with confidence 1', () => {
    const reps = find('I work at Ashler now', [ASHLR]);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ start: 10, end: 16, original: 'Ashler', replacement: 'Ashlr.AI', canonical: 'Ashlr.AI', reason: 'alias', confidence: 1 });
  });

  it('matches a multi-word alias', () => {
    const reps = find('Ping the Ashler AI team', [ASHLR]);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ original: 'Ashler AI', replacement: 'Ashlr.AI', reason: 'alias' });
  });

  it('is case-insensitive by default', () => {
    expect(find('ASHLER and ashlar', [ASHLR]).map((r) => r.original)).toEqual(['ASHLER', 'ashlar']);
  });

  it('matches punctuation-stripped implicit aliases of the canonical', () => {
    expect(find('ashlr ai rocks', [ASHLR])[0]).toMatchObject({ original: 'ashlr ai', replacement: 'Ashlr.AI', reason: 'alias' });
    expect(find('AshlrAI rocks', [ASHLR])[0]).toMatchObject({ original: 'AshlrAI', reason: 'alias' });
    expect(find('Ashlr-AI rocks', [ASHLR])[0]).toMatchObject({ original: 'Ashlr-AI', reason: 'alias' });
    expect(find('open claw is great', [{ canonical: 'OpenClaw', aliases: [] }])[0]).toMatchObject({ original: 'open claw', replacement: 'OpenClaw' });
  });

  it('does not match a multi-word alias across punctuation', () => {
    const reps = find('Ashler, AI', [{ canonical: 'Ashlr.AI', aliases: ['Ashler AI'] }], { phonetic: false, fuzzy: false });
    expect(reps).toHaveLength(0);
    expect(find('Ashler, AI', [ASHLR]).map((r) => r.original)).toEqual(['Ashler']);
  });

  it('preserves possessives and trailing punctuation', () => {
    const text = "That is Ashler's plan, Ashler.";
    const reps = find(text, [ASHLR]);
    expect(reps.map((r) => r.original)).toEqual(['Ashler', 'Ashler']);
    expect(apply(text, reps)).toBe("That is Ashlr.AI's plan, Ashlr.AI.");
  });

  it('does not double-replace when the canonical is already present', () => {
    expect(find('Ashlr.AI is Ashlr.AI. Kubernetes too', [ASHLR, K8S])).toHaveLength(0);
    expect(find("Ashlr.AI's roadmap", [ASHLR])).toHaveLength(0);
  });

  it('fixes casing of the canonical itself', () => {
    expect(find('run kubernetes', [K8S])[0]).toMatchObject({ original: 'kubernetes', replacement: 'Kubernetes', reason: 'alias' });
  });

  it('folds diacritics in the exact pass (bug E)', () => {
    const bjorn: Term = { canonical: 'Bjørn Halvorsen', aliases: [] };
    expect(find('ping bjorn halvorsen', [bjorn])[0]).toMatchObject({ original: 'bjorn halvorsen', replacement: 'Bjørn Halvorsen', reason: 'alias', confidence: 1 });
    expect(find('ping bjornhalvorsen', [bjorn])[0]).toMatchObject({ reason: 'alias', confidence: 1 });
    const tadeusz: Term = { canonical: 'Tadeusz Wróblewski', aliases: [] };
    expect(find('ping tadeusz wroblewski', [tadeusz])[0]).toMatchObject({ replacement: 'Tadeusz Wróblewski', reason: 'alias', confidence: 1 });
    // the accented spelling is left alone, and an accented alias matches its ASCII form
    expect(find('ping Bjørn Halvorsen', [bjorn])).toHaveLength(0);
    expect(find('ping bjoern', [{ canonical: 'Bjørn Halvorsen', aliases: ['bjørn'] }])).toHaveLength(0);
    expect(find('ping bjorn', [{ canonical: 'Bjørn Halvorsen', aliases: ['bjørn'] }])[0]).toMatchObject({ reason: 'alias' });
    // never lists and protectedWords fold too
    expect(find('ping bjorn halvorsen', [{ ...bjorn, never: ['bjørn halvorsen'] }])).toHaveLength(0);
    expect(find('ping bjorn', [{ canonical: 'Bjørn Halvorsen', aliases: ['bjørn'] }], undefined, { protectedWords: ['bjørn'] })).toHaveLength(0);
  });

  it('respects caseSensitive terms', () => {
    const term: Term = { canonical: 'Go', aliases: ['GoLang'], caseSensitive: true };
    expect(find('write it in GoLang', [term])).toHaveLength(1);
    expect(find('write it in golang', [term])).toHaveLength(0);
    // the implicit alias "go" is a stoplist word, so plain prose never gets rewritten
    expect(find('let us go now', [term])).toHaveLength(0);
  });

  it('never rewrites a stoplist word via an implicit alias', () => {
    expect(find('go go go', [{ canonical: 'Go', aliases: [] }])).toHaveLength(0);
  });
});

describe('phonetic pass', () => {
  it("rewrites Cooper Nettie's -> Kubernetes with no aliases listed", () => {
    const reps = find("Deploy it to Cooper Nettie's tonight", [K8S]);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ original: "Cooper Nettie's", replacement: 'Kubernetes', reason: 'phonetic' });
    expect(reps[0].confidence).toBeGreaterThanOrEqual(0.82);
    expect(reps[0].confidence).toBeLessThanOrEqual(0.9);
  });

  it('reassembles split words: pie dentic, head sner', () => {
    const terms: Term[] = [{ canonical: 'Pydantic', aliases: [] }, { canonical: 'Hetzner', aliases: [] }];
    const reps = find('use pie dentic on head sner', terms);
    expect(reps.map((r) => [r.original, r.replacement, r.reason])).toEqual([
      ['pie dentic', 'Pydantic', 'phonetic'],
      ['head sner', 'Hetzner', 'phonetic'],
    ]);
  });

  it('is blocked by the stoplist: sauce is not SaaS', () => {
    expect(find('add some sauce', [SAAS])).toHaveLength(0);
    // "sass" is an ordinary English word too, so the phonetic pass must not touch it either
    expect(find('all that sass', [SAAS])).toHaveLength(0);
    // SaaS keys to "SS" (two characters), which is below the phonetic key minimum,
    // so even a non-word homophone needs an explicit alias
    expect(find('our sas business', [SAAS])).toHaveLength(0);
    expect(find('our sas business', [{ canonical: 'SaaS', aliases: ['sas'] }])[0]).toMatchObject({ original: 'sas', replacement: 'SaaS', reason: 'alias' });
  });

  it('ignores metaphone keys shorter than 3 characters (bug D)', () => {
    expect(find('lunch at noon', [{ canonical: 'Neon', aliases: [] }])).toHaveLength(0);
    expect(find('the seed round closed', [{ canonical: 'Zod', aliases: ['zawed'] }])).toHaveLength(0);
    expect(find('the vet checked the dog', [{ canonical: 'Vite', aliases: ['veet'] }])).toHaveLength(0);
    expect(find('the cube on the desk', [{ canonical: 'KPI', aliases: ['kay pee eye'] }])).toHaveLength(0);
    expect(find('the zoo and the sea', [{ canonical: 'SSO', aliases: ['ess ess oh'] }])).toHaveLength(0);
    // a long key still matches
    expect(find('deploy to coopernetties', [K8S])[0]).toMatchObject({ replacement: 'Kubernetes', reason: 'phonetic' });
  });

  it('does not derive phonetic keys from spelled-out aliases (bug D)', () => {
    const terms: Term[] = [
      { canonical: 'ARR', aliases: ['ay ar ar'] },
      { canonical: 'OKR', aliases: ['oh kay are'] },
      { canonical: 'Zod', aliases: ['zawed'] },
      { canonical: 'JWT', aliases: ['j w t', 'jay w t'] },
    ];
    const text = 'he wore a grey suit to the interview';
    expect(find(text, terms)).toHaveLength(0);
    // the spelled-out alias itself still fires as an exact hit
    expect(find('add j w t here', terms)[0]).toMatchObject({ original: 'j w t', replacement: 'JWT', reason: 'alias', confidence: 1 });
  });

  it('never phonetic-matches a window shorter than 4 letters unless the alias is that short', () => {
    // "cram" -> CRM: key KRM is 3 chars but the term has aliases and "cram" is a plain word at 0.84
    expect(find('a cram session', [{ canonical: 'CRM', aliases: ['see are em'] }])).toHaveLength(0);
    expect(find('add a gram of salt', [{ canonical: 'CRM', aliases: ['see are em'] }])).toHaveLength(0);
  });

  it('holds a lone token to 0.88 when the term has explicit aliases, regardless of case (bug D, bug G)', () => {
    const prisma: Term = { canonical: 'Prisma', aliases: ['prizma', 'prism a', 'prismo'] };
    expect(find('the prism split the light', [prisma])).toHaveLength(0);
    // the same word with no aliases listed is still a phonetic candidate at the normal bar
    const bare: Term = { canonical: 'Prisma', aliases: [] };
    expect(find('the prism split the light', [bare])[0]).toMatchObject({ original: 'prism', replacement: 'Prisma' });
    // a capital is no evidence of a garble in the phonetic pass: "Prism" at 0.86 is held to the same bar (bug G)
    expect(find('ask Prism about it', [prisma], { fuzzy: false })).toHaveLength(0);
    expect(find('Prism is a word', [prisma], { fuzzy: false })).toHaveLength(0);
    // the fuzzy pass keeps the case heuristic (see the fuzzy tests), so with both on it is a 0.83 fuzzy hit
    expect(find('ask Prism about it', [prisma])[0]).toMatchObject({ original: 'Prism', reason: 'fuzzy' });
    // and a garble that clears 0.88 still matches, capitalised or not
    expect(find('use prysma here', [prisma])[0]).toMatchObject({ original: 'prysma', replacement: 'Prisma', reason: 'phonetic' });
    expect(find('Prysma is down', [prisma])[0]).toMatchObject({ original: 'Prysma', replacement: 'Prisma', reason: 'phonetic' });
    // "email" -> YAML keys to AML (3 chars) at 0.855: the aliased lone-token bar stops it
    expect(find('send the email', [{ canonical: 'YAML', aliases: ['yammel'] }])).toHaveLength(0);
    // without aliases the bar is 0.82, and the first-letter guard (e vs y, similarity 0.4) stops it instead
    expect(find('send the email', [{ canonical: 'YAML', aliases: [] }])).toHaveLength(0);
  });

  it('does not rewrite a capitalised sound-alike word to an aliased term (bug G: Inter -> Entire.io)', () => {
    // "inter" and "entire" both key to ANTR; the hit was phonetic 0.86 and the old bar
    // only applied to lowercase tokens, so the font name became Entire.io.
    const entire: Term = { canonical: 'Entire.io', aliases: ['entire i o', 'entire dot io'] };
    expect(find('the Inter font looks right', [entire])).toHaveLength(0);
    expect(find('Inter is the font', [entire])).toHaveLength(0);
    expect(find('the inter font looks right', [entire])).toHaveLength(0);
    // the explicit alias and the implicit domain stem still fire as exact hits
    expect(find('Entire dot io sessions', [entire])[0]).toMatchObject({ original: 'Entire dot io', replacement: 'Entire.io', reason: 'alias', confidence: 1 });
    expect(find('entire i o sessions', [entire])[0]).toMatchObject({ original: 'entire i o', replacement: 'Entire.io', reason: 'alias', confidence: 1 });
    expect(find('entire sessions', [entire])[0]).toMatchObject({ original: 'entire', replacement: 'Entire.io', reason: 'alias', confidence: 1 });
    // a sentence-initial capitalised garble that clears 0.88 still matches
    expect(find('Ashlur is down', [ASHLR])[0]).toMatchObject({ original: 'Ashlur', replacement: 'Ashlr.AI', reason: 'phonetic' });
    expect(find('Ashlur is down', [ASHLR])[0].confidence).toBeGreaterThanOrEqual(0.88);
  });

  it('requires a vowel-initial lone phonetic candidate to share its first letter or 0.6 similarity with the alias (bug G)', () => {
    // same first letter: no similarity check
    expect(find('use hetsner boxes', [{ canonical: 'Hetzner', aliases: [] }])[0]).toMatchObject({ original: 'hetsner', replacement: 'Hetzner', reason: 'phonetic' });
    expect(find('ashlur is down', [ASHLR])[0]).toMatchObject({ original: 'ashlur', replacement: 'Ashlr.AI', reason: 'phonetic' });
    // different initial vowel, similarity 0.5: rejected even with no aliases and confidence (0.86) above the bar
    expect(find('the inter font', [{ canonical: 'Entire.io', aliases: [] }])).toHaveLength(0);
    expect(find('the Inter font', [{ canonical: 'Entire', aliases: [] }])).toHaveLength(0);
    // vowel vs y: "email" / "yaml" both key to AML
    expect(find('send the email', [{ canonical: 'YAML', aliases: [] }])).toHaveLength(0);
    // two different initial consonants already agreed on the key's first consonant: exempt
    expect(similarity('coopernetties', 'kubernetes')).toBeLessThan(0.6);
    expect(find('deploy to coopernetties', [K8S])[0]).toMatchObject({ replacement: 'Kubernetes', reason: 'phonetic' });
    // multi-token windows are exempt
    expect(find("Deploy to Cooper Nettie's tonight", [K8S])[0]).toMatchObject({ replacement: 'Kubernetes', reason: 'phonetic' });
  });

  it('does not let an inexact window start or end on a function word (bug A)', () => {
    const terms: Term[] = [{ canonical: 'normalizeTranscript', aliases: [] }, { canonical: 'harvestRepo', aliases: [] }];
    const text = 'the bug is in normalise transcript i think, or harvest ripo i guess';
    const reps = find(text, terms);
    expect(reps.map((r) => [r.original, r.replacement])).toEqual([
      ['normalise transcript', 'normalizeTranscript'],
      ['harvest ripo', 'harvestRepo'],
    ]);
    expect(apply(text, reps)).toBe('the bug is in normalizeTranscript i think, or harvestRepo i guess');
    expect(find('add a wisper model', [{ canonical: 'Whisper', aliases: [] }])[0]).toMatchObject({ original: 'wisper' });
    expect(find('the doctor said to rest', [{ canonical: 'Zod', aliases: [] }])).toHaveLength(0);
    expect(find('the flow of traffic was steady', [{ canonical: 'STT', aliases: ['ess tee tee'] }])).toHaveLength(0);
    // "her" is deliberately not a function word: STT splits "-er" off ("dock her")
    expect(find('why is dock her throwing', [{ canonical: 'Docker', aliases: [] }])[0]).toMatchObject({ original: 'dock her', replacement: 'Docker' });
  });

  it('fires on a stoplist word when the user lists it as an explicit alias', () => {
    const reps = find('add some sauce', [{ canonical: 'SaaS', aliases: ['sauce'] }]);
    expect(reps[0]).toMatchObject({ original: 'sauce', replacement: 'SaaS', reason: 'alias', confidence: 1 });
  });

  it('respects term.never and settings.protectedWords', () => {
    expect(find('sass business', [{ canonical: 'SaaS', aliases: [], never: ['sass'] }])).toHaveLength(0);
    expect(find('sass business', [SAAS], undefined, { protectedWords: ['sass'] })).toHaveLength(0);
    // protectedWords beats even an explicit alias
    expect(find('sass business', [{ canonical: 'SaaS', aliases: ['sass'] }], undefined, { protectedWords: ['sass'] })).toHaveLength(0);
  });

  it('never fires on windows shorter than 3 chars or all digits', () => {
    expect(find('123 42 1235', [{ canonical: '1234', aliases: [] }])).toHaveLength(0);
    expect(find('ay', [{ canonical: 'AI', aliases: [] }])).toHaveLength(0);
    // "ai" -> "AI" is an exact implicit-alias casing fix, never a phonetic hit
    const reps = find('ai', [{ canonical: 'AI', aliases: [] }]);
    expect(reps).toHaveLength(1);
    expect(reps[0].reason).toBe('alias');
  });

  it('can be disabled', () => {
    expect(find("Cooper Nettie's", [K8S], { phonetic: false })).toHaveLength(0);
    expect(find("Cooper Nettie's", [K8S], undefined, { phonetic: false })).toHaveLength(0);
  });
});

describe('fuzzy pass', () => {
  it('rewrites Ashlet -> Ashlr.AI via the Ashler alias (phonetic keys differ)', () => {
    const reps = find('ask Ashlet about it', [ASHLR]);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ original: 'Ashlet', replacement: 'Ashlr.AI', reason: 'fuzzy' });
    expect(reps[0].confidence).toBeCloseTo(1 - 1 / 6, 5);
  });

  it('rewrites Ashlor -> Ashlr.AI via fuzzy when phonetic is off', () => {
    const reps = find('ask Ashlor about it', [ASHLR], { phonetic: false });
    expect(reps[0]).toMatchObject({ original: 'Ashlor', replacement: 'Ashlr.AI', reason: 'fuzzy' });
    expect(reps[0].confidence).toBeGreaterThanOrEqual(0.82);
  });

  it('scores a transposed typo above 0.9 (bug F)', () => {
    const reps = find('use levenshtien here', [{ canonical: 'Levenshtein', aliases: [] }], { phonetic: false });
    expect(reps[0]).toMatchObject({ original: 'levenshtien', replacement: 'Levenshtein', reason: 'fuzzy' });
    expect(reps[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('holds a lone lowercase word to 0.88 when the term has explicit aliases', () => {
    const prisma: Term = { canonical: 'Prisma', aliases: ['prizma', 'prism a', 'prismo'] };
    // "prism" -> "prisma" is 0.83 by edit distance: blocked for a plain word, allowed when capitalised.
    // Unlike the phonetic pass (bug G), fuzzy keeps the case heuristic: its confidence is an edit
    // similarity, and a capitalised token one edit from a listed alias is what the alias is for
    // ("Ashlet" -> Ashlr.AI above would otherwise be lost).
    expect(find('the prism split the light', [prisma], { phonetic: false })).toHaveLength(0);
    expect(find('ask Prism about it', [prisma], { phonetic: false })[0]).toMatchObject({ original: 'Prism', reason: 'fuzzy' });
    // "Inter" / "entire" is 0.5 by edit distance, nowhere near the fuzzy bar
    expect(find('the Inter font', [{ canonical: 'Entire.io', aliases: ['entire i o', 'entire dot io'] }], { phonetic: false })).toHaveLength(0);
  });

  it('respects minConfidence override', () => {
    expect(find('ask Ashlet about it', [ASHLR], { minConfidence: 0.9 })).toHaveLength(0);
    expect(find('ask Ashlet about it', [ASHLR], undefined, { minConfidence: 0.9 })).toHaveLength(0);
    expect(find('ask Ashlet about it', [ASHLR], { minConfidence: 0.7 })).toHaveLength(1);
  });

  it('never fires on stoplist words or short windows', () => {
    expect(find('the', [{ canonical: 'Thee', aliases: [] }])).toHaveLength(0);
    expect(find('cat', [{ canonical: 'Cats', aliases: [] }])).toHaveLength(0);
    expect(find('cat', [{ canonical: 'Catz', aliases: [] }], { minConfidence: 0.5 })).toHaveLength(0);
  });

  it('can be disabled', () => {
    expect(find('ask Ashlet about it', [ASHLR], { fuzzy: false })).toHaveLength(0);
  });
});

describe('overlap resolution', () => {
  it('prefers the longest span, then the earliest start', () => {
    const reps = find('Ashler AI and Ashler', [ASHLR]);
    expect(reps.map((r) => r.original)).toEqual(['Ashler AI', 'Ashler']);
    expect(reps[0].start).toBeLessThan(reps[1].start);
  });

  it('lets an exact hit beat a longer inexact window that swallowed the next word (bug A)', () => {
    const text = 'refactor normalizeTranscript to take options';
    expect(find(text, [{ canonical: 'normalizeTranscript', aliases: [] }])).toHaveLength(0);

    const terms: Term[] = [{ canonical: 'JWT', aliases: ['jay w t'] }, { canonical: 'Priyanka Raghunathan', aliases: [] }];
    const jwt = 'add j w t to the service';
    const reps = find(jwt, terms);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ original: 'j w t', replacement: 'JWT', reason: 'alias' });
    expect(apply(jwt, reps)).toBe('add JWT to the service');

    const kafka = 'kaf ka is not picking up';
    expect(apply(kafka, find(kafka, [{ canonical: 'Kafka', aliases: ['kaf ka'] }]))).toBe('Kafka is not picking up');
  });

  it('keeps the possessive on inexact multi-token matches (bug B)', () => {
    const text = "ashler ai's dashboard";
    const reps = find(text, [{ canonical: 'Ashlr.AI', aliases: ['Ashler AI'] }]);
    expect(reps).toHaveLength(1);
    expect(reps[0]).toMatchObject({ original: 'ashler ai', replacement: 'Ashlr.AI', reason: 'alias' });
    expect(apply(text, reps)).toBe("Ashlr.AI's dashboard");

    const fuzzy = "kwamay mensa's pr is waiting";
    const fr = find(fuzzy, [{ canonical: 'Kwame Mensah', aliases: [] }]);
    expect(fr).toHaveLength(1);
    expect(fr[0].reason).not.toBe('alias');
    expect(apply(fuzzy, fr)).toBe("Kwame Mensah's pr is waiting");

    // the full view still wins when only it matches ("Cooper Nettie's" -> Kubernetes)
    expect(find("Cooper Nettie's cluster", [K8S])[0]).toMatchObject({ original: "Cooper Nettie's" });
  });

  it('claims spans that already equal a canonical so no other term can take a token inside (bug C)', () => {
    // "tee tee s" is 7 letters like "tadeusz", so the guess scores 0.9 and clears the aliased lone-token bar
    const tts: Term = { canonical: 'TTS', aliases: ['tee tee s'] };
    expect(find('remind Tadeusz Wróblewski today', [{ canonical: 'Tadeusz Wróblewski', aliases: [] }, tts])).toHaveLength(0);
    // without the name in the lexicon the phonetic pass is free to guess
    expect(find('remind Tadeusz today', [tts])).toHaveLength(1);
    // with the longer alias the guess scores 0.85 and the aliased lone-token bar stops it on its own (bug G)
    expect(find('remind Tadeusz today', [{ canonical: 'TTS', aliases: ['tee tee ess'] }])).toHaveLength(0);

    const wispr: Term = { canonical: 'Wispr Flow', aliases: ['whisper flow'] };
    const whisper: Term = { canonical: 'Whisper', aliases: [] };
    expect(find("Wispr Flow's dashboard", [wispr, whisper])).toHaveLength(0);
    expect(find('Wispr Flow dashboard', [wispr, whisper])).toHaveLength(0);
    // the claim is not reported as a replacement, and a real fix next to it still is
    expect(find('Wispr Flow beats wisper', [wispr, whisper]).map((r) => r.original)).toEqual(['wisper']);
  });

  it('returns non-overlapping, start-sorted results', () => {
    const reps = find("Ashler said Cooper Nettie's beats Ashler AI", [ASHLR, K8S]);
    for (let i = 1; i < reps.length; i++) expect(reps[i].start).toBeGreaterThanOrEqual(reps[i - 1].end);
    expect(reps.map((r) => r.replacement)).toEqual(['Ashlr.AI', 'Kubernetes', 'Ashlr.AI']);
  });
});

describe('skipCode', () => {
  const text = 'Ashler wrote `Ashler` in ```\nAshler\n``` at https://ashler.com/x see src/ashler/index.ts and mail ashler@ashler.com';

  it('skips inline code, fences, URLs, paths and emails by default', () => {
    const reps = find(text, [ASHLR]);
    expect(reps).toHaveLength(1);
    expect(reps[0].start).toBe(0);
  });

  it('rewrites everywhere when skipCode is false', () => {
    expect(find(text, [ASHLR], { skipCode: false }).length).toBeGreaterThan(3);
  });

  it('does not skip an ordinary slash like and/or', () => {
    expect(find('Ashler and/or Ashlar', [ASHLR])).toHaveLength(2);
  });
});

describe('robustness and performance', () => {
  it('handles empty input and empty lexicon', () => {
    expect(find('', [ASHLR])).toEqual([]);
    expect(find('Ashler', [])).toEqual([]);
  });

  it('ignores blank aliases and blank never entries', () => {
    const reps = find('Ashler', [{ canonical: 'Ashlr.AI', aliases: ['', '  ', 'Ashler'], never: [''] }]);
    expect(reps).toHaveLength(1);
  });

  it('finds replacements in a 2KB text with 200 terms in under 20ms', () => {
    const terms: Term[] = Array.from({ length: 200 }, (_, i) => ({
      canonical: `Widgetron${i}X`,
      aliases: [`widget tron ${i}`, `wigetron${i}`],
    }));
    terms.push(ASHLR, K8S);
    const index = buildIndex(lex(terms));
    const text = "The quick brown fox jumps over the lazy dog while Ashler ships Cooper Nettie's clusters to widget tron 7. ".repeat(20);
    expect(text.length).toBeGreaterThan(2000);
    findReplacements(text, index); // warm-up
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const reps = findReplacements(text, index);
      best = Math.min(best, performance.now() - t0);
      expect(reps.length).toBe(60);
    }
    expect(best).toBeLessThan(20);
  });
});
