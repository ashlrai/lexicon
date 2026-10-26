import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { matchTerm } from '../src/core/index.js';
import type { Lexicon, SemanticMatchOptions, Term } from '../src/core/index.js';
import { embeddingConfig, localEmbeddings } from '../src/match/local-embeddings.js';
import corpus from './fixtures/semantic/cases.json' with { type: 'json' };
import recorded from './fixtures/semantic/bge-m3.json' with { type: 'json' };

const model = 'fixture-local';
const localMetadata = { model_info: { 'general.architecture': 'bert' }, capabilities: ['embedding'] };
const lex = (terms: Term[], settings?: Lexicon['settings']): Lexicon => ({ version: 1, terms, settings });
const vectorTerm = { canonical: 'Vector', aliases: [] };
const vector = (score: number): number[] => [score, Math.sqrt(1 - score * score)];
type Handler = (body: { model: string; input: string[] }, req: IncomingMessage, res: ServerResponse) => void;

async function withServer(handler: Handler, run: (endpoint: string, paths: string[]) => Promise<void>): Promise<void> {
  const paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!);
    let text = '';
    for await (const chunk of req) text += chunk;
    handler(JSON.parse(text), req, res);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  try { await run(`http://127.0.0.1:${address.port}/api/embed`, paths); }
  finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const respond = (embeddings: unknown): Handler => (body, req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/api/show' ? localMetadata : { model: body.model, embeddings }));
};
const options = (endpoint: string, extra: Partial<NonNullable<SemanticMatchOptions['semantic']>> = {}): SemanticMatchOptions => ({
  phonetic: false, fuzzy: false, semantic: { enabled: true, model, endpoint, ...extra },
});

describe('opt-in whole-term fallback', () => {
  it('defaults off and does not validate or contact a configured model without explicit enablement', async () => {
    await withServer(respond([[1, 0], vector(0.99)]), async (endpoint, paths) => {
      expect(await matchTerm('Vektron', lex([vectorTerm]))).toEqual({ semantic: 'disabled' });
      expect(await matchTerm('Vektron', lex([vectorTerm]), { semantic: { model, endpoint } })).toEqual({ semantic: 'disabled' });
      expect(await matchTerm('Vektron', lex([vectorTerm]), { semantic: { model: '', endpoint: 'bad' } })).toEqual({ semantic: 'disabled' });
      expect(paths).toEqual([]);
    });
  });

  it('preserves baseline alias/phonetic/fuzzy priority, canonical no-ops and partial matches without IO', async () => {
    await withServer(respond([]), async (endpoint, paths) => {
      const terms = lex([{ canonical: 'Kubernetes', aliases: ['kube'] }, { canonical: 'LangChain', aliases: [] }]);
      const opt = { semantic: { enabled: true, model, endpoint } };
      expect((await matchTerm('kube', terms, opt)).match?.reason).toBe('alias');
      expect((await matchTerm('Kubernetiz', terms, opt)).match?.reason).toBe('phonetic');
      expect((await matchTerm('Langchaen', terms, opt)).match?.reason).toBe('fuzzy');
      expect((await matchTerm('Kubernetes', terms, opt)).match).toBeUndefined();
      expect((await matchTerm('kube Vektron', terms, opt)).match).toBeUndefined();
      expect(paths).toEqual([]);
    });
  });

  it('checks local metadata before embedding and returns a cosine-scored whole-term match', async () => {
    await withServer((body, req, res) => {
      expect(req.method).toBe('POST');
      if (req.url === '/api/embed') {
        expect(body).toMatchObject({ model, input: ['Vektron', 'Vector'], truncate: false, keep_alive: '0s' });
      } else expect(body).toEqual({ model });
      respond([[1, 0], vector(0.96)])(body, req, res);
    }, async (endpoint, paths) => {
      expect(await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).toEqual({
        match: { canonical: 'Vector', reason: 'embedding', confidence: 0.96 }, semantic: 'matched',
      });
      expect(paths).toEqual(['/api/show', '/api/embed']);
    });
  });

  it('requires a high similarity and respects stricter minConfidence, including NaN handling', async () => {
    for (const [score, minConfidence] of [[0.84, undefined], [0.9, 0.95], [0.8, NaN], [0.9, Infinity]] as const) {
      await withServer(respond([[1, 0], vector(score)]), async endpoint => {
        expect((await matchTerm('Vektron', lex([vectorTerm]), { ...options(endpoint), minConfidence })).semantic).toBe('no-match');
      });
    }
  });

  it('pins the model checked by metadata even if the caller edits shared options in flight', async () => {
    let config: SemanticMatchOptions;
    await withServer((body, req, res) => {
      expect(body.model).toBe(model);
      if (req.url === '/api/show') config.semantic!.model = 'hidden-cloud-alias';
      respond([[1, 0], vector(0.96)])(body, req, res);
    }, async endpoint => {
      config = options(endpoint);
      expect((await matchTerm('Vektron', lex([vectorTerm]), config)).match?.canonical).toBe('Vector');
    });
  });

  it('abstains on a close runner-up, independent of term order', async () => {
    for (const terms of [[vectorTerm, { canonical: 'Vektor', aliases: [] }], [{ canonical: 'Vektor', aliases: [] }, vectorTerm]]) {
      await withServer(respond([[1, 0], vector(0.96), vector(0.94)]), async endpoint => {
        expect((await matchTerm('Vektron', lex(terms), options(endpoint))).semantic).toBe('no-match');
      });
    }
  });

  it('competes per canonical rather than treating aliases of the winner as competitors', async () => {
    await withServer(respond([[1, 0], vector(0.97), vector(0.96)]), async endpoint => {
      const result = await matchTerm('Vektron', lex([{ canonical: 'Vector', aliases: ['Vektar'] }]), options(endpoint));
      expect(result.match?.canonical).toBe('Vector');
    });
  });

  it('abstains when the winning spelling is shared by different canonicals', async () => {
    await withServer(respond([[1, 0], vector(0.97)]), async endpoint => {
      const terms = lex([{ canonical: 'Zorb', aliases: ['Vektar'] }, { canonical: 'Zomp', aliases: ['Vektar'] }]);
      expect((await matchTerm('Vektron', terms, options(endpoint))).semantic).toBe('no-match');
    });
  });

  it.each(['sauce', 'vector', 'database', 'Vektron/code', '@Vektron', '#Vektron', '_Vektron', '`Vektron`', 'https://Vektron.dev', 'Vektron@example.com', "Vektron's", 'Vektron-core', '123', 'AI', 'Vector Vektron'])('never embeds protected prose or identifiers: %s', async heard => {
    await withServer(respond([]), async (endpoint, paths) => {
      expect((await matchTerm(heard, lex([vectorTerm]), options(endpoint))).match).toBeUndefined();
      expect(paths).toEqual([]);
    });
  });

  it('preserves protectedWords, never, caseSensitive and Unicode folding', async () => {
    const cases: [string, Lexicon][] = [
      ['Vektron', lex([vectorTerm], { protectedWords: ['Vektron'] })],
      ['Vektron', lex([{ ...vectorTerm, never: ['Vektron'] }])],
      ['Vektron', lex([{ ...vectorTerm, caseSensitive: true }])],
      ['Bjørnum', lex([{ canonical: 'Bjornus', aliases: [] }], { protectedWords: ['Bjørnum'] })],
      ['Bjørnum', lex([{ canonical: 'Bjornus', aliases: [], never: ['Bjørnum'] }])],
    ];
    await withServer(respond([]), async (endpoint, paths) => {
      for (const [heard, terms] of cases) expect((await matchTerm(heard, terms, options(endpoint))).match).toBeUndefined();
      expect(paths).toEqual([]);
    });
  });

  it('returns explicit limits rather than truncating terms or hiding competitors', async () => {
    await withServer(respond([]), async (endpoint, paths) => {
      expect((await matchTerm('x'.repeat(81), lex([vectorTerm]), options(endpoint))).semantic).toBe('limited');
      const aliases = Array.from({ length: 130 }, (_, i) => `Vekt${i}`);
      expect((await matchTerm('Vektron', lex([{ canonical: 'Vector', aliases }]), options(endpoint))).semantic).toBe('limited');
      expect(paths).toEqual([]);
    });
  });

  it('never uses synonym embeddings without spelling evidence', async () => {
    await withServer(respond([[1, 0], [1, 0]]), async (endpoint, paths) => {
      expect((await matchTerm('Datastore', lex([{ canonical: 'PostgreSQL', aliases: [] }]), options(endpoint))).match).toBeUndefined();
      expect(paths).toEqual([]);
    });
  });
});

describe('literal loopback transport and failure isolation', () => {
  it.each([
    'https://127.0.0.1/api/embed', 'http://localhost:11434/api/embed', 'http://127.evil.test/api/embed',
    'http://192.168.1.1/api/embed', 'http://[::ffff:192.168.1.1]/api/embed', 'http://[::2]/api/embed',
    'http://127.0.0.1@evil.test/api/embed', 'http://user:password@127.0.0.1/api/embed',
    'http://127.0.0.1/api/embed?q=x', 'http://127.0.0.1/api/embed#x', 'http://127.0.0.1/api/generate',
  ])('rejects endpoint before networking: %s', endpoint => {
    expect(() => embeddingConfig({ model, endpoint })).toThrow();
  });

  it('accepts IPv4 and IPv6 literal loopback only', () => {
    for (const endpoint of ['http://127.0.0.1:11434/api/embed', 'http://[::1]:11434/api/embed']) {
      expect(embeddingConfig({ model, endpoint }).endpoint.href).toBe(endpoint);
    }
  });

  it.each(['gpt-oss:120b-cloud', 'deepseek:cloud', 'cloud/model', 'https://evil/model', ''])('rejects nonlocal model selection: %s', name => {
    expect(() => embeddingConfig({ model: name })).toThrow();
  });

  it.each([0, -1, 10001, NaN, Infinity, 1.5])('bounds the deadline: %s', timeoutMs => {
    expect(() => embeddingConfig({ model, timeoutMs })).toThrow();
  });

  it.each([{ minSimilarity: 0.8 }, { minSimilarity: NaN }, { minMargin: 0 }, { minMargin: Infinity }])('refuses unsafe thresholds: %j', config => {
    return expect(matchTerm('Vektron', lex([vectorTerm]), options('http://127.0.0.1/api/embed', config))).rejects.toThrow();
  });

  it.each([
    { ...localMetadata, remote_host: 'https://ollama.com' },
    { ...localMetadata, remote_model: 'hidden-cloud-alias' },
    { capabilities: ['embedding'] },
    { model_info: {}, capabilities: ['embedding'] },
    { model_info: { architecture: 'llama' }, capabilities: ['completion'] },
  ])('checks locality before sending any vocabulary: %j', metadata => {
    return withServer((_body, _req, res) => res.end(JSON.stringify(metadata)), async (endpoint, paths) => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).semantic).toBe('unavailable');
      expect(paths).toEqual(['/api/show']);
    });
  });

  it('does not follow redirects, including to another loopback server', async () => {
    await withServer(respond([]), async (target, targetPaths) => {
      await withServer((_body, _req, res) => { res.writeHead(307, { location: target }); res.end(); }, async endpoint => {
        expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).semantic).toBe('unavailable');
      });
      expect(targetPaths).toEqual([]);
    });
  });

  it('bounds headers and stalled bodies by a total deadline', async () => {
    for (const sendHeaders of [false, true]) {
      await withServer((_body, _req, res) => { if (sendHeaders) { res.writeHead(200); res.write('{'); } }, async endpoint => {
        expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint, { timeoutMs: 30 }))).semantic).toBe('unavailable');
      });
    }
  });

  it('does not call a model after cancellation or a spent matching budget', async () => {
    await withServer(respond([]), async (endpoint, paths) => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), { ...options(endpoint), signal: AbortSignal.abort() })).semantic).toBe('unavailable');
      expect((await matchTerm('Vektron', lex([vectorTerm]), { ...options(endpoint), shouldStop: () => true })).semantic).toBe('unavailable');
      expect(paths).toEqual([]);
    });
  });

  it('aborts an in-flight request', async () => {
    const controller = new AbortController();
    await withServer(() => controller.abort(), async endpoint => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), { ...options(endpoint), signal: controller.signal })).semantic).toBe('unavailable');
    });
  });

  it.each(['remote_host', 'remote_model'])('rejects remote metadata on the embedding response: %s', field => {
    return withServer((body, req, res) => {
      if (req.url === '/api/show') respond([])(body, req, res);
      else res.end(JSON.stringify({ model, embeddings: [[1, 0], [1, 0]], [field]: 'remote' }));
    }, async endpoint => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).semantic).toBe('unavailable');
    });
  });

  it('shares one deadline across metadata and embedding requests', async () => {
    await withServer((body, req, res) => {
      // Each response fits a fresh deadline; their combined latency exceeds it.
      setTimeout(() => respond([[1, 0], vector(0.96)])(body, req, res), 40);
    }, async endpoint => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint, { timeoutMs: 60 }))).semantic).toBe('unavailable');
    });
  });

  it.each([[], [[1, 0]], [[1, 0], [0, 0]], [[1, 0], [1]], [[1, 0], [null, 1]], [[1, 0], ['bad', 1]], [[1, 0], Array(4097).fill(1)]].map(embeddings => ({ embeddings })))('rejects malformed batch $embeddings.length', ({ embeddings }) => {
    return withServer(respond(embeddings), async endpoint => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).semantic).toBe('unavailable');
    });
  });

  it.each(['not-json', '{"model":"fixture-local","embeddings":[[1e999,0],[1,0]]}', '{"model":"wrong","embeddings":[[1,0],[1,0]]}', 'x'.repeat(4 * 1024 * 1024 + 1)])('rejects invalid or oversized response %#', body => {
    return withServer((input, req, res) => {
      if (req.url === '/api/show') respond([])(input, req, res);
      else res.end(body);
    }, async endpoint => {
      expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).semantic).toBe('unavailable');
    });
  });

  it('rejects invalid batches before networking', async () => {
    for (const input of [[], Array(129).fill('term'), ['x'.repeat(81)]]) {
      await expect(localEmbeddings(input, { model })).rejects.toThrow();
    }
  });

  it('handles a refused connection', async () => {
    let endpoint = '';
    await withServer(respond([]), async url => { endpoint = url; });
    expect((await matchTerm('Vektron', lex([vectorTerm]), options(endpoint))).semantic).toBe('unavailable');
  });
});

describe('recorded local-model precision fixture', () => {
  it('measures baseline and fallback TP/FP/FN without requiring Ollama in CI', async () => {
    const vectors: Record<string, number[]> = recorded.vectors;
    const terms = lex(corpus.terms.map(canonical => ({ canonical, aliases: [] })));
    const counts = { baselineTP: 0, baselineFP: 0, baselineFN: 0, fallbackTP: 0, fallbackFP: 0, combinedTP: 0, combinedFP: 0, combinedFN: 0, negatives: 0 };
    expect(recorded.provenance.dimensions).toBe(1024);
    expect(recorded.provenance.digest).toMatch(/^[a-f0-9]{64}$/);
    await withServer((body, req, res) => {
      if (req.url === '/api/show') { respond([])(body, req, res); return; }
      expect(body.model).toBe(recorded.provenance.model);
      for (const input of body.input) expect(vectors[input], `Missing recorded input ${input}`).toBeDefined();
      respond(body.input.map(input => vectors[input]))(body, req, res);
    }, async endpoint => {
      for (const fixture of corpus.cases) {
        const baseline = await matchTerm(fixture.heard, terms);
        const result = await matchTerm(fixture.heard, terms, { semantic: { enabled: true, endpoint, model: recorded.provenance.model } });
        if (fixture.expected === null) counts.negatives++;
        if (baseline.match) baseline.match.canonical === fixture.expected ? counts.baselineTP++ : counts.baselineFP++;
        if (fixture.expected && baseline.match?.canonical !== fixture.expected) counts.baselineFN++;
        if (result.match) {
          const correct = result.match.canonical === fixture.expected;
          correct ? counts.combinedTP++ : counts.combinedFP++;
          if (result.match.reason === 'embedding') correct ? counts.fallbackTP++ : counts.fallbackFP++;
        }
        if (fixture.expected && result.match?.canonical !== fixture.expected) counts.combinedFN++;
        expect(result.semantic).not.toBe('unavailable');
      }
    });
    const positives = corpus.cases.filter(c => c.expected !== null).length;
    expect(counts.baselineTP + counts.baselineFN).toBe(positives);
    expect(counts.combinedTP + counts.combinedFN).toBe(positives);
    expect(counts).toEqual({ baselineTP: 22, baselineFP: 0, baselineFN: 6, fallbackTP: 1, fallbackFP: 0, combinedTP: 23, combinedFP: 0, combinedFN: 5, negatives: 12 });
    expect(counts.fallbackTP / (counts.fallbackTP + counts.fallbackFP)).toBe(1);
    expect(counts.combinedTP / positives).toBeCloseTo(23 / 28);
  });
});
