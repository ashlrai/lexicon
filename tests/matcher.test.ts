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

  it('STOPLIST is a large, frozen, lowercase, alphabetized set', () => {
    expect(STOPLIST.size).toBeGreaterThan(3000);
    const must = [
      'the', 'and', 'for', 'was', 'sauce', 'ash', 'head', 'off', 'auth',
      'lacks', 'lack', 'lacked', 'locks', 'lock', 'ashes', 'cooper', 'noon', 'vet', 'seed', 'suit', 'suite', 'said', 'cube',
      'email', 'zoo', 'sea', 'red', 'prison', 'wind', 'entire', 'graphical', 'lacking', 'looked', 'looking', 'users',
    ];
    for (const w of must) expect(STOPLIST.has(w), w).toBe(true);
    // product names that double as words stay out so a bare canonical is still case-fixed
    for (const w of ['docker', 'neon', 'whisper', 'playwright', 'prometheus', 'drizzle', 'prism', 'tale', 'dock', 'ai']) expect(STOPLIST.has(w), w).toBe(false);
    const words = [...STOPLIST];
    for (const w of words) expect(w).toMatch(/^[a-z]+$/);
    expect(words).toEqual([...words].sort());
    const mutable = STOPLIST as Set<string>;
    expect(() => mutable.add('zzz')).toThrow(TypeError);
    expect(() => mutable.delete('the')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect(STOPLIST.has('the')).toBe(true);
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
    // the bare domain stem is the ordinary word "entire", a stoplist word: an implicit alias never rewrites it
    expect(find('entire sessions', [entire])).toHaveLength(0);
    expect(find('the entire session', [entire])).toHaveLength(0);
    // listing it explicitly is the opt-in
    expect(find('entire sessions', [{ ...entire, aliases: [...entire.aliases, 'entire'] }])[0]).toMatchObject({ original: 'entire', replacement: 'Entire.io', reason: 'alias', confidence: 1 });
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

  it('does not rewrite an ordinary word to an alias-less sound-alike term (bug H: lacks -> Locus)', () => {
    // "lacks" and "locus" share the 3-consonant key LKS; the hit was phonetic 0.90 and the term had no
    // aliases, so neither the 0.88 aliased bar nor the old ~420-word stoplist stopped it.
    const locus: Term = { canonical: 'Locus', aliases: [] };
    const text = 'the process lacks locks';
    expect(find(text, [locus])).toHaveLength(0);
    expect(apply(text, find(text, [locus]))).toBe(text);
    expect(find('it likes the leaks', [locus])).toHaveLength(0);
    // the canonical itself is an implicit alias: a case-insensitive exact hit fixes the casing
    expect(find('locus is fine', [locus])[0]).toMatchObject({ original: 'locus', replacement: 'Locus', reason: 'alias', confidence: 1 });
    expect(find('Locus is fine', [locus])).toHaveLength(0);
    // a real garble (similarity 0.8 on the same key) still matches phonetically
    expect(find('open lokus now', [locus])[0]).toMatchObject({ original: 'lokus', replacement: 'Locus', reason: 'phonetic' });
    expect(find('open lokus now', [locus])[0].confidence).toBeCloseTo(0.9, 5);
  });

  it('holds a lone phonetic candidate to a similarity floor that shrinks with key length', () => {
    const docker: Term = { canonical: 'Docker', aliases: [] };
    // 3-consonant key (TKR): 0.8 needed. "doker" is 0.83 alike, "tucker" 0.67, "decor" 0.5
    expect(find('run doker here', [docker])[0]).toMatchObject({ original: 'doker', replacement: 'Docker', reason: 'phonetic' });
    expect(find('ask tucker later', [docker])).toHaveLength(0);
    expect(find('the art deco decor', [docker])).toHaveLength(0);
    expect(similarity('tucker', 'docker')).toBeCloseTo(0.667, 2);
    // 4-consonant key (PLRT / ANTR): 0.65 needed
    expect(find('the playwrite suite', [{ canonical: 'Playwright', aliases: [] }])[0]).toMatchObject({ original: 'playwrite', replacement: 'Playwright', reason: 'phonetic' });
    expect(find('the inter font', [{ canonical: 'Entire', aliases: [] }])).toHaveLength(0);
    // an aliased term is held to the floor too: "tropic" keys like the alias "tea rpc" (TRPK, 0.90) but is 0.33 alike
    expect(find('the tropic of cancer', [{ canonical: 'tRPC', aliases: ['tea rpc'] }])).toHaveLength(0);
    // 5+ consonants agreeing in order is spelling evidence enough: no floor beyond the initial-vowel guard
    expect(find('deploy to coopernetties', [K8S])[0]).toMatchObject({ replacement: 'Kubernetes', reason: 'phonetic' });
    expect(find('use olama locally', [{ canonical: 'Ollama', aliases: [] }])[0]).toMatchObject({ original: 'olama', replacement: 'Ollama', reason: 'phonetic' });
    // multi-token windows are exempt
    expect(find('why is dock her throwing', [docker])[0]).toMatchObject({ original: 'dock her', replacement: 'Docker' });
  });

  it('leaves a sentence of stoplist words untouched against a realistic lexicon', () => {
    const canonicals = [
      'Ashlr.AI', 'Kubernetes', 'Hetzner', 'Vercel', 'Supabase', 'Neon', 'Upstash', 'Deepgram', 'Wispr Flow', 'Superwhisper',
      'OpenClaw', 'Cloudflare', 'Anthropic', 'Prisma', 'Pydantic', 'Tailwind', 'Vitest', 'Terraform', 'Docker', 'LangChain',
      'Ollama', 'Whisper', 'Metaphone', 'Levenshtein', 'Prometheus', 'Playwright', 'Locus', 'Zod', 'YAML', 'GraphQL',
      'tRPC', 'PostgreSQL', 'Redis', 'Next.js', 'Entire.io', 'Drizzle', 'Grafana', 'Sentry', 'Datadog', 'Stripe',
      'Twilio', 'Figma', 'Notion', 'Linear', 'Vite', 'Deno', 'Rust', 'Golang', 'Python', 'TypeScript',
      'Svelte', 'Astro', 'Remix', 'Nuxt', 'Hono', 'Fastify', 'Express', 'Django', 'Flask', 'Rails',
    ];
    expect(canonicals).toHaveLength(60);
    const terms: Term[] = canonicals.map((canonical, i) => ({ canonical, aliases: i % 3 === 0 ? [`${canonical.toLowerCase()}x`] : [] }));
    const words = [...STOPLIST];
    // deterministic "random" sample: a small LCG seeded per run so the 20 words differ between the three runs
    for (const seed of [7, 1234, 98765]) {
      let state = seed;
      const next = (): number => (state = (state * 1103515245 + 12345) % 2147483648);
      const sample = Array.from({ length: 20 }, () => words[next() % words.length]);
      for (const w of sample) expect(find(w, terms), w).toHaveLength(0);
      const sentence = sample.join(' ');
      expect(find(sentence, terms), sentence).toHaveLength(0);
      expect(find(sentence, terms, { minConfidence: 0.5 }), sentence).toHaveLength(0);
    }
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

  // A phonetic window used to grow one token past the garble whenever the extra
  // token made no sound of its own. Phonetic confidence is a ratio of letter
  // counts, so a bare number costs literally nothing and a two-letter
  // abbreviation costs almost nothing; the wider window stayed above the
  // threshold and then won overlap resolution on span length, so the number or
  // the abbreviation was swallowed by the replacement.
  it('does not let a phonetic window start or end on a number or an abbreviation (bug K)', () => {
    const abbrev = 'cooper netties i.e. Terraform';
    const reps = find(abbrev, [K8S]);
    expect(reps.map((r) => r.original)).toEqual(['cooper netties']);
    expect(apply(abbrev, reps)).toBe('Kubernetes i.e. Terraform');

    const numbered = 'Terraform has 1. cooper netties 2. Cooper Netties as variants.';
    const numberedReps = find(numbered, [K8S]);
    expect(numberedReps.map((r) => r.original)).toEqual(['cooper netties', 'Cooper Netties']);
    expect(apply(numbered, numberedReps)).toBe('Terraform has 1. Kubernetes 2. Kubernetes as variants.');

    // The same shape with the number on the left, and across a newline, which
    // is whitespace and so joins two tokens into one window just as a space does.
    const leading = 'pick 2 cooper netties please';
    expect(find(leading, [K8S]).map((r) => r.original)).toEqual(['cooper netties']);
    const lines = '1. Terraform\n2. cooper netties\n3. Cooper Netties';
    expect(apply(lines, find(lines, [K8S]))).toBe('1. Terraform\n2. Kubernetes\n3. Kubernetes');
  });

  // The guard is phonetic-only and never touches the exact pass, because both
  // of the shapes it refuses are things users really do list as aliases.
  it('still matches an explicit alias that is a number or an abbreviation (bug K)', () => {
    expect(find('we sell b 2 b', [{ canonical: 'B2B', aliases: ['b 2 b'] }])[0]).toMatchObject({ original: 'b 2 b', replacement: 'B2B', reason: 'alias' });
    expect(find('log in with auth 0', [{ canonical: 'Auth0', aliases: ['auth 0'] }])[0]).toMatchObject({ original: 'auth 0', replacement: 'Auth0', reason: 'alias' });
    expect(find('the 11 labs voice', [{ canonical: 'ElevenLabs', aliases: ['11 labs'] }])[0]).toMatchObject({ original: '11 labs', replacement: 'ElevenLabs', reason: 'alias' });
  });

  // Why the guard names numbers and abbreviations instead of asking whether the
  // extra token added anything to the phonetic key: a trailing "ai" adds nothing
  // to the key either, and it is half the names this product exists for.
  it('still grows a phonetic window over a trailing syllable that keys as nothing (bug K)', () => {
    expect(find('we use opin ay for that', [{ canonical: 'OpenAI', aliases: [] }])[0]).toMatchObject({ original: 'opin ay', replacement: 'OpenAI', reason: 'phonetic' });
    expect(find('we use ashlur ay for that', [{ canonical: 'Ashlr.AI', aliases: [] }])[0]).toMatchObject({ original: 'ashlur ay', replacement: 'Ashlr.AI', reason: 'phonetic' });
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
    // "tadeus" keys to TTS like "tadeusz", one letter shorter (0.87) and 0.86 alike, so it clears every lone-token guard
    const tadeus: Term = { canonical: 'Tadeus', aliases: [] };
    expect(find('remind Tadeusz Wróblewski today', [{ canonical: 'Tadeusz Wróblewski', aliases: [] }, tadeus])).toHaveLength(0);
    // without the name in the lexicon the phonetic pass is free to guess
    expect(find('remind Tadeusz today', [tadeus])[0]).toMatchObject({ original: 'Tadeusz', replacement: 'Tadeus', reason: 'phonetic' });
    // "tee tee s" is 7 letters like "tadeusz", so the guess scored 0.9 and cleared the aliased lone-token bar;
    // the short-key similarity floor (TTS is 3 consonants, similarity 0.29) is what stops it now
    expect(find('remind Tadeusz today', [{ canonical: 'TTS', aliases: ['tee tee s'] }])).toHaveLength(0);
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

  // Markdown's other code block. Nothing matched a run of lines indented by
  // four spaces, so a bug report that pasted its repro as an indented block had
  // the repro corrected out of existence before anyone could read it.
  it('skips an indented code block (bug L)', () => {
    const block = 'Here is the repro:\n\n    findReplacements("Ashler", index)\n\nand that is it, Ashler.';
    const reps = find(block, [ASHLR]);
    expect(reps).toHaveLength(1);
    expect(reps[0].start).toBe(block.lastIndexOf('Ashler'));
    // a tab indents a block just as four spaces do
    expect(find('Repro:\n\n\tAshler\n', [ASHLR])).toHaveLength(0);
    // the block runs over several lines, is not ended by a blank line inside
    // it, and ends at the first line that is not indented
    const multi = 'Repro:\n\n    Ashler\n\n    Ashler again\n\nAshler in prose.';
    expect(find(multi, [ASHLR]).map((r) => r.start)).toEqual([multi.lastIndexOf('Ashler')]);
    // and skipCode: false still rewrites inside it
    expect(find(block, [ASHLR], { skipCode: false })).toHaveLength(2);
  });

  // The two ways of being wrong are not equal: a missed skip leaves a visible
  // correction, an over-eager one silently stops correcting ordinary text.
  it('treats an indented line that Markdown does not call code as prose (bug L)', () => {
    // four spaces with no blank line above is a wrapped line of a paragraph
    expect(find('a long sentence that wraps here\n    Ashler is still prose', [ASHLR])).toHaveLength(1);
    // a list item's indented continuation, and a nested bullet, are list content
    expect(find('- item one\n\n    Ashler continues the item\n\n- item two', [ASHLR])).toHaveLength(1);
    expect(find('- item one\n\n    - Ashler nested\n', [ASHLR])).toHaveLength(1);
    expect(find('1. item one\n\n    Ashler continues the item\n', [ASHLR])).toHaveLength(1);
    // so is anything hanging under a block quote, or under an indented line
    expect(find('> quoted line\n\n    Ashler under a quote\n', [ASHLR])).toHaveLength(1);
    expect(find('  indented paragraph\n\n    Ashler under it\n', [ASHLR])).toHaveLength(1);
  });

  it('does not skip an ordinary slash like and/or', () => {
    expect(find('Ashler and/or Ashlar', [ASHLR])).toHaveLength(2);
  });

  it('treats a scope/name slug as a path even without a file extension', () => {
    expect(find('ashlrai/lexicon', [ASHLR])).toHaveLength(0);
    expect(find('clone github.com/ashlrai/lexicon now', [ASHLR])).toHaveLength(0);
    expect(find('see ~/ashlr and /opt/ashlr', [ASHLR])).toHaveLength(0);
    // a slash with spaces around it is prose, not a path
    expect(find('ashler / ashlar', [ASHLR])).toHaveLength(2);
  });
});

describe('identifier glue', () => {
  it('leaves a window glued to @ / # : \\ ~ _ - on the left alone, in every pass', () => {
    const text = '@ashlr/lexicon';
    expect(find(text, [ASHLR])).toHaveLength(0);
    expect(find(text, [ASHLR], { skipCode: false })).toHaveLength(0);
    expect(find('install @ashlr/lexicon today', [ASHLR])).toHaveLength(0);
    expect(find('#ashlr', [ASHLR])).toHaveLength(0);
    expect(find('#ashler', [ASHLR])).toHaveLength(0);
    expect(find('C:\\ashlr', [ASHLR])).toHaveLength(0);
    expect(find('note:ashler', [ASHLR])).toHaveLength(0);
    expect(find('the -ashler flag', [ASHLR])).toHaveLength(0);
    expect(find('run coopernetties', [K8S])).toHaveLength(1);
    expect(find('run /coopernetties', [K8S])).toHaveLength(0);
    expect(find('run ~coopernetties', [K8S])).toHaveLength(0);
  });

  it('leaves a window glued to / \\ _ on the right alone', () => {
    expect(find('ashlrai/lexicon', [ASHLR], { skipCode: false })).toHaveLength(0);
    expect(find('ashlr_core', [ASHLR])).toHaveLength(0);
    expect(find('ashler_core and core_ashler', [ASHLR])).toHaveLength(0);
    expect(find('ashlr\\bin', [ASHLR])).toHaveLength(0);
    expect(find('coopernetties_cfg', [K8S])).toHaveLength(0);
    // only the window that touches the glue is skipped: "ashler ai" ends on "_", the lone "ashler" does not
    expect(find('ashler ai_core', [ASHLR]).map((r) => r.original)).toEqual(['ashler']);
  });

  it('still matches a plain word, a possessive, sentence punctuation and a spaced hyphen', () => {
    expect(find('ping ashlr today', [ASHLR])[0]).toMatchObject({ original: 'ashlr', replacement: 'Ashlr.AI', reason: 'alias' });
    const possessive = "ashler's team";
    expect(apply(possessive, find(possessive, [ASHLR]))).toBe("Ashlr.AI's team");
    const list = 'ashler, ashlar and ashler.';
    const reps = find(list, [ASHLR]);
    expect(reps).toHaveLength(3);
    expect(apply(list, reps)).toBe('Ashlr.AI, Ashlr.AI and Ashlr.AI.');
    const dash = 'see ashler - it works';
    expect(apply(dash, find(dash, [ASHLR]))).toBe('see Ashlr.AI - it works');
    expect(find('ashler- it works', [ASHLR])).toHaveLength(1);
    expect(find('(ashler) [ashlar] "ashler"', [ASHLR])).toHaveLength(3);
    expect(find('ashler@ashler.com', [ASHLR], { skipCode: false })).toHaveLength(1);
  });

  it('checks only the characters outside the window, so a hyphenated alias still matches whole', () => {
    const term: Term = { canonical: 'Ashlr.AI', aliases: ['ashler-ai'] };
    expect(find('use ashler-ai here', [term])[0]).toMatchObject({ original: 'ashler-ai', replacement: 'Ashlr.AI', reason: 'alias' });
    expect(find('use Ashlr-AI here', [ASHLR])).toHaveLength(1);
    // glued to a suffix it is one token and no longer the alias
    expect(find('use ashler-core here', [term])).toHaveLength(0);
    expect(find('use ashler-ai-core here', [term])).toHaveLength(0);
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

describe('bug I: stoplist words plus abbreviations never match phonetically', () => {
  const MASON = { canonical: 'Mason Wyatt', aliases: ['mason white'], category: 'person' as const };
  const OPENAI = { canonical: 'OpenAI', aliases: [] };
  it('does not turn "ms window" into a person', () => {
    expect(find('a 1 ms window could be clobbered', [MASON])).toHaveLength(0);
  });
  it('still matches the explicit alias and a real garble', () => {
    expect(find('ping mason white', [MASON])[0]).toMatchObject({ replacement: 'Mason Wyatt', reason: 'alias' });
    expect(find('ping mason wyat', [MASON])[0]).toMatchObject({ replacement: 'Mason Wyatt' });
  });
  it('keeps implicit split aliases that contain an abbreviation', () => {
    expect(find('ask open ai about it', [OPENAI])[0]).toMatchObject({ replacement: 'OpenAI', reason: 'alias' });
  });
});

describe('bug J: text that quotes a misspelling is not flattened into one spelling', () => {
  const MASON = { canonical: 'Mason Wyatt', aliases: ['Mason Wyat', 'mason white'], category: 'person' as const };
  const REDIS = { canonical: 'Redis', aliases: ['reddis', 'red iss'] };

  const keeps = (text: string, terms: Parameters<typeof find>[1]) =>
    expect(apply(text, find(text, terms))).toBe(text);

  // Quoting. Each of these names a spelling rather than committing one, and
  // flattening it destroys the only thing the sentence says.
  it('leaves a slash-delimited pair of misspellings alone', () => {
    keeps('Rewritten to name Mason Wyatt, the chips Mason Wiatt / Mason Wyat, and the Try it box.', [MASON]);
  });

  it('leaves a docs table row alone, with one alias or several', () => {
    keeps('| Ashlr.AI | Ashler, Ashlar | brand |', [ASHLR]);
    keeps('| Ashlr.AI | Ashler | brand |', [ASHLR]);
  });

  // These are the phrasings src/core/learn.ts teaches users to say. Rewriting
  // them to "X not X" makes learnCorrection reject its own documented example.
  it('leaves every "it is X not Y" correction phrasing alone', () => {
    keeps("it's Ashlr.AI, not Ashler", [ASHLR]);
    keeps('I said Ashlr.AI not Ashler', [ASHLR]);
    keeps('"Ashlr.AI" not "Ashler"', [ASHLR]);
    keeps('not Ashler, Ashlr.AI', [ASHLR]);
  });

  it('leaves other contrastive phrasings alone', () => {
    keeps('It keeps giving Ashler instead of Ashlr.AI.', [ASHLR]);
    keeps('Ashler vs Ashlr.AI in the logs.', [ASHLR]);
    keeps('Ashlr.AI sounds like Ashler or Ashlar to the recognizer.', [ASHLR]);
  });

  // A period followed by a space used to end the sentence here, stranding the
  // aliases away from the canonical they are contrasted with.
  it('does not treat list scaffolding as the end of a sentence', () => {
    keeps('Ashlr.AI is often wrong, e.g. Ashler and Ashlar.', [ASHLR]);
    keeps('Ashlr.AI has 1. Ashler 2. Ashlar as variants.', [ASHLR]);
  });

  // Dictation. The evidence for quoting has to sit next to the mentions: words
  // like alias, canonical, spelling and typography are a working programmer's
  // ordinary vocabulary, and an earlier version refused to correct all of these.
  it('still corrects ordinary prose that merely contains a spelling word', () => {
    const cases: [string, string][] = [
      ['Kubernetes is fine but the canonical cooper netties docs are not', 'Kubernetes is fine but the canonical Kubernetes docs are not'],
      ['That sounds like the Kubernetes issue, cooper netties keeps crashing', 'That sounds like the Kubernetes issue, Kubernetes keeps crashing'],
      ['Add a shell alias so Kubernetes and cooper netties both resolve', 'Add a shell alias so Kubernetes and Kubernetes both resolve'],
      ['Fix the anti-aliasing before Kubernetes and cooper netties ship', 'Fix the anti-aliasing before Kubernetes and Kubernetes ship'],
      ['The typography on the Kubernetes page and the cooper netties page differ', 'The typography on the Kubernetes page and the Kubernetes page differ'],
      ['Check the spelling on the Kubernetes and cooper netties pages', 'Check the spelling on the Kubernetes and Kubernetes pages'],
    ];
    for (const [input, expected] of cases) expect(apply(input, find(input, [K8S]))).toBe(expected);
  });

  it('still corrects a comma splice, which is dictation and not a list', () => {
    expect(apply('I pushed to Redis, reddis went down', find('I pushed to Redis, reddis went down', [REDIS]))).toBe(
      'I pushed to Redis, Redis went down',
    );
    const mason = 'Ping Mason Wyatt, Mason Wyat is on call tonight';
    expect(apply(mason, find(mason, [MASON]))).toBe('Ping Mason Wyatt, Mason Wyatt is on call tonight');
  });

  it('still corrects two garbles of one term with no canonical present', () => {
    const text = 'the reddis and red iss instances are the same box';
    expect(apply(text, find(text, [REDIS]))).toBe('the Redis and Redis instances are the same box');
  });

  it('confines the guard to the sentence that quotes', () => {
    const text = 'Ashlr.AI sounds like Ashler. My company Ashler ships today.';
    expect(apply(text, find(text, [ASHLR]))).toBe('Ashlr.AI sounds like Ashler. My company Ashlr.AI ships today.');
  });

  // A known limit, recorded rather than hidden. Everything between the two
  // mentions has to be about spelling, and "what we write, but the recognizer
  // keeps giving" is about the world. Loosening that is what produced the
  // false positives in the test above, so this trade is deliberate: an unfixed
  // name is cheap, a destroyed sentence is not.
  it('does not catch a contrast separated by a clause about the world', () => {
    const text = 'Ashlr.AI is what we write, but the recognizer keeps giving Ashler.';
    expect(apply(text, find(text, [ASHLR]))).toBe(
      'Ashlr.AI is what we write, but the recognizer keeps giving Ashlr.AI.',
    );
  });

  // The witnesses from the review that rebuilt this guard. The specification
  // is tests/enumeration.property.test.ts, which generates the round trip in
  // both directions; these are the individual strings that were reported
  // wrong, kept so a regression names itself.
  it('corrects the ordinary dictation an earlier guard refused', () => {
    const cases: [string, string][] = [
      ['I heard red iss went down but Redis Cloud is fine', 'I heard Redis went down but Redis Cloud is fine'],
      ['We wrote cooper netties scripts for the Kubernetes migration', 'We wrote Kubernetes scripts for the Kubernetes migration'],
      ['Redis is not caching, the reddis box is down', 'Redis is not caching, the Redis box is down'],
      ['Kubernetes is down and that means cooper netties is too', 'Kubernetes is down and that means Kubernetes is too'],
      ['Not cooper netties again, the Kubernetes cluster is flaky', 'Not Kubernetes again, the Kubernetes cluster is flaky'],
      ['The Kubernetes upgrade becomes cooper netties work next week', 'The Kubernetes upgrade becomes Kubernetes work next week'],
    ];
    for (const [input, expected] of cases) expect(apply(input, find(input, [K8S, REDIS]))).toBe(expected);
  });

  it('keeps the sentence a user types to add an alias, and the lexicon file itself', () => {
    keeps('Add Ashler as an alias of Ashlr.AI.', [ASHLR]);
    keeps('canonical: Ashlr.AI, alias: Ashler', [ASHLR]);
    keeps('aliases for Ashlr.AI include Ashler and Ashlar', [ASHLR]);
    keeps('Replace Ashler with Ashlr.AI', [ASHLR]);
    keeps('Ashlr.AI keeps coming out as Ashler', [ASHLR]);
    keeps('Ashler = Ashlr.AI', [ASHLR]);
    keeps('Ashler: Ashlr.AI', [ASHLR]);
    keeps('Ashler => Ashlr.AI', [ASHLR]);
    keeps('Ashlr.AI vs. Ashler', [ASHLR]);
  });

  // The canonical was matched with an exact indexOf, so the casing dictation
  // actually produces defeated the precondition and flattened the one sentence
  // learn.ts teaches. Any spelling that folds to the canonical anchors now.
  it('finds the canonical in the casing dictation produces', () => {
    keeps("it's ashlr.ai, not Ashler", [ASHLR]);
    keeps('Ashlr AI, not Ashler', [ASHLR]);
  });

  // A newline used to end a sentence, which put every item of a list or a YAML
  // block in a sentence of its own with no canonical in it: the guard was off
  // for exactly the files it exists to protect.
  it('reads a multi-line list and a YAML block as one passage', () => {
    keeps('Aliases for Ashlr.AI:\n- Ashler\n- Ashlar', [ASHLR]);
    keeps('canonical: Ashlr.AI\naliases:\n  - Ashler\n  - Ashlar', [ASHLR]);
    keeps('| canonical | alias |\n| --- | --- |\n| Ashlr.AI | Ashler |\n| Ashlr.AI | Ashlar |', [ASHLR]);
  });

  // Sentence bounds cannot be got right - a period after a digit or an
  // abbreviation does not end a thought - so the refusal is per run of linked
  // mentions instead. The quoted pair is kept and the ordinary mention after it
  // is still corrected, whichever side of a bound they fell on.
  it('declines the run that quotes, not everything that shares a block with it', () => {
    const text = 'Ashlr.AI, not Ashler, since 2024. My company Ashler ships today.';
    expect(apply(text, find(text, [ASHLR]))).toBe('Ashlr.AI, not Ashler, since 2024. My company Ashlr.AI ships today.');
  });

  // The word between the marker and the mention used to decide the answer. Each
  // of these is a modal, a frequency adverb or a relativizer - closed classes,
  // none of which refer to anything in the world - and each was flattened
  // because GLUE was documented as closed-class and held prepositions and
  // auxiliaries only. The generated suite could not see them because its
  // connectives were drawn from the same vocabulary it was testing.
  it('is not decided by a modal, an adverb of frequency or a relativizer', () => {
    keeps('Ashlr.AI is often spelled Ashler.', [ASHLR]);
    keeps('Ashlr.AI can come out as Ashler.', [ASHLR]);
    keeps('Ashlr.AI may come out as Ashler.', [ASHLR]);
    keeps('Ashlr.AI might be written as Ashler.', [ASHLR]);
    keeps('Ashlr.AI will sometimes be spelled Ashler.', [ASHLR]);
    keeps('Ashlr.AI would usually be spelled Ashler.', [ASHLR]);
    keeps('Ashlr.AI is commonly misspelled as Ashler.', [ASHLR]);
    keeps('Ashlr.AI is frequently transcribed as Ashler.', [ASHLR]);
    keeps('Ashlr.AI is always heard as Ashler.', [ASHLR]);
    keeps('Ashlr.AI, which is often written Ashler, is the brand.', [ASHLR]);
    keeps('Ashlr.AI but the recognizer writes Ashler.', [ASHLR]);
    keeps('We write Ashlr.AI because the recognizer gives Ashler.', [ASHLR]);
    keeps('Ashler needs to map to Ashlr.AI', [ASHLR]);
    keeps('Two spellings, Ashlr.AI and Ashler, same company', [ASHLR]);
  });

  // The other direction, and the reason the vocabulary above can be widened at
  // all: a lead needed only a marker before the first mention and glue after
  // it, so every ordinary imperative built on `fix`, `show`, `type`, `keep`,
  // `write`, `print`, `correct`, `replace`, `swap` or `change` was declined.
  // The determiner is the tell - `the reddis box` is a box, not a spelling.
  it('still corrects an ordinary imperative that opens with a spelling word', () => {
    const cases: [string, string][] = [
      ['Fix Redis on the reddis box', 'Fix Redis on the Redis box'],
      ['Show Redis in the reddis output', 'Show Redis in the Redis output'],
      ['Type Redis into the reddis box', 'Type Redis into the Redis box'],
      ['Keep Redis out of the reddis cluster', 'Keep Redis out of the Redis cluster'],
      ['Write Redis on the reddis form', 'Write Redis on the Redis form'],
      ['Replace Redis in the reddis config', 'Replace Redis in the Redis config'],
      ['Swap Redis for the reddis node tomorrow', 'Swap Redis for the Redis node tomorrow'],
    ];
    for (const [input, expected] of cases) expect(apply(input, find(input, [REDIS]))).toBe(expected);
    // and the substitution frames the lead rule exists for still hold
    keeps('Replace Ashler with Ashlr.AI', [ASHLR]);
    keeps('Replace Ashler with Ashlr.AI in the README', [ASHLR]);
    keeps('Add Ashler as an alias of Ashlr.AI.', [ASHLR]);
  });

  // A word inside its own quotation marks is being named, not used. This is the
  // one rule here that reads no vocabulary, and it is the one that holds for
  // the project's own documentation, where the words around the quote
  // ("pronounced", "generates likely STT misspellings", "you write") are
  // ordinary English the vocabulary will never contain.
  it('keeps a spelling that stands inside its own quotation marks', () => {
    keeps('Ashlr.AI, pronounced "ashler". And Entire.io.', [ASHLR]);
    keeps("Ashlr.AI, pronounced 'ashler'.", [ASHLR]);
    keeps('suggestAliases("Ashlr.AI") generates likely STT misspellings: "Ashler", "Ashlar".', [ASHLR]);
    keeps('The user dictates "ping ashler", you write "Ashler", they say it is Ashlr.AI.', [ASHLR]);
    keeps('Rewrote \u2018Mason Wiatt\u2019 and \u2018Ashler\u2019 to \u2018Mason Wyatt\u2019 and \u2018Ashlr.AI\u2019.', [ASHLR, MASON]);
    // unquoted, and with no canonical in reach, the same word is still fixed
    expect(apply('add ashler to the vocabulary', find('add ashler to the vocabulary', [ASHLR]))).toBe(
      'add Ashlr.AI to the vocabulary',
    );
  });

  // A README states the canonical, leaves a blank line, and lists the garbles
  // under it. A blank line ends a block, so there was no anchor in the block
  // that held the garbles and every rule was off for the shape the module
  // docstring names first. The anchor reaches one paragraph up now; linking is
  // unchanged, so two mentions still have to contrast before anything is kept.
  it('finds the canonical in the paragraph above a list of garbles', () => {
    keeps('Canonical: Ashlr.AI\n\nMisspellings: Ashler, Ashlar', [ASHLR]);
    keeps('# Ashlr.AI\n\nMisspellings: Ashler, Ashlar', [ASHLR]);
    // the anchor folds, so the paragraph above may say "Ashlr AI" (which is
    // itself canonicalised) and the garbles below are still kept
    const folded = 'Ashlr AI\n\nHeard as: Ashler, Ashlar';
    expect(apply(folded, find(folded, [ASHLR]))).toBe('Ashlr.AI\n\nHeard as: Ashler, Ashlar');
    keeps('## Spellings\n\nCanonical: Ashlr.AI\n\nGarbles:\n- Ashler\n- Ashlar', [ASHLR]);
    // one paragraph up, not two: an unrelated paragraph in between breaks it
    const far = 'Ashlr.AI ships today.\n\nThe cluster is fine.\n\nreddis and red iss are the same box.';
    expect(apply(far, find(far, [REDIS]))).toBe('Ashlr.AI ships today.\n\nThe cluster is fine.\n\nRedis and Redis are the same box.');
  });
});

// Three defects a review found in the matcher work of v0.5.3. Bug M is a
// regression of bug K's edge guard; bugs N and O are the indented-code-block
// rule of bug L. M and O are silent losses, so both are checked in the
// direction that does not announce itself: this must still be corrected.
describe('bugs M-O: a canonical that ends in a numeral, and what counts as an indented code block', () => {
  const CLAUDE4: Term = { canonical: 'Claude 4', aliases: [] };
  const K8S1: Term = { canonical: 'Kubernetes 1', aliases: [] };
  const PG16: Term = { canonical: 'Postgres 16', aliases: [] };

  // Bug K refused any multi-token phonetic window that started or ended on a
  // numeral, on the grounds that a numeral contributes no letters and so no
  // length penalty can price it. The same is true of the numeral in the term's
  // own name, which was not considered, so every version-suffixed canonical
  // stopped being reachable phonetically: Claude 4, Llama 3, Postgres 16.
  it('still corrects a phonetic garble of a canonical that ends in a numeral (bug M)', () => {
    const text = 'we use clawd 4 in production';
    const reps = find(text, [CLAUDE4]);
    expect(reps.map((r) => r.original)).toEqual(['clawd 4']);
    expect(reps[0]).toMatchObject({ replacement: 'Claude 4', reason: 'phonetic' });
    expect(apply(text, reps)).toBe('we use Claude 4 in production');
    // and the guard still holds in the direction it was written for: a numeral
    // the canonical does not have is not swallowed, at either end
    expect(find('pick 2 cooper netties please', [K8S]).map((r) => r.original)).toEqual(['cooper netties']);
  });

  // Worse than a miss. Forced onto the non-numeral prefix, the narrower window
  // rewrote the name and left the version number standing beside it.
  it('spans a version number instead of duplicating it (bug M)', () => {
    const one = 'we run cooper netties 1 here';
    expect(apply(one, find(one, [K8S1]))).toBe('we run Kubernetes 1 here');
    // The window budget counts the alias's own no-sound tokens too: alphaOnly
    // drops them, so "Postgres 16" allowed two tokens for a garble needing three.
    const pg = 'we run post gres 16 now';
    expect(apply(pg, find(pg, [PG16]))).toBe('we run Postgres 16 now');
    // unchanged: the same window against a term with no numeral in its name
    expect(find('cooper netties i.e. Terraform', [K8S]).map((r) => r.original)).toEqual(['cooper netties']);
  });

  // The list-or-quote exemption was tested against the candidate opening line
  // only, so one bullet-looking first line (a pasted diff, a shell flag, a
  // redirect) stopped the block opening at all and left every line under it
  // exposed. The answer depended on the order the lines happened to be in.
  it('judges an indented code block by the whole run, not by its first line (bug N)', () => {
    const body = ['- flag Ashler', 'lexicon add Ashler', 'echo Ashlar'];
    for (const order of [body, [body[1], body[0], body[2]]]) {
      const text = `Repro:\n\n${order.map((l) => `    ${l}`).join('\n')}\n`;
      expect(find(text, [ASHLR]), text).toHaveLength(0);
    }
    // a run of nothing but bullets is still a list someone indented, not code
    expect(find('Here is what I need:\n\n    - talk to Ashler\n    - ship it\n', [ASHLR])).toHaveLength(1);
  });

  // The rule also missed its own motivating case in its commonest form: a bug
  // report states its repro under a numbered step, a bullet or a quote.
  it('skips a repro indented under a numbered step, a bullet or a block quote (bug N)', () => {
    expect(find('1. Run this:\n\n        lexicon add Ashler\n', [ASHLR])).toHaveLength(0);
    expect(find('- Run this:\n\n        lexicon add Ashler\n', [ASHLR])).toHaveLength(0);
    expect(find('> Run this:\n>\n>     lexicon add Ashler\n', [ASHLR])).toHaveLength(0);
    // four columns past the item's own marker, not past column zero: anything
    // less than that is the item's indented continuation and ordinary text
    expect(find('1. Run this:\n\n    Ashler is the name\n', [ASHLR])).toHaveLength(1);
  });

  // prevBlank started true and nothing was required above, so a string that
  // simply began with an indent was code in its entirety. CommonMark-correct
  // for a document, wrong for a clipboard paste, a transcript or a prompt.
  it('treats text that merely begins indented as prose (bug O)', () => {
    expect(find('    Ashler is what the recognizer wrote today.', [ASHLR])).toHaveLength(1);
    expect(find('\tAshler is what it wrote.', [ASHLR])).toHaveLength(1);
    expect(find('\n\n    Ashler after nothing but blank lines.', [ASHLR])).toHaveLength(1);
  });

  // The docstring promised that a list item's indented continuation stays
  // ordinary text, but the marker test knew only bullets and digits.
  it('knows the list markers an outline uses, and a table row (bug O)', () => {
    for (const above of ['a) First step', 'i. First step', 'IV) First step', '3. First step']) {
      expect(find(`${above}\n\n    Ashler continues it\n`, [ASHLR]), above).toHaveLength(1);
    }
    expect(find('| Term | Note |\n| --- | --- |\n\n    Ashler under the table\n', [ASHLR])).toHaveLength(1);
  });
});
