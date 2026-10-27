/** Bounded Ollama /api/embed transport. Literal addresses and node:http avoid DNS and proxy routing. */

export interface LocalEmbeddingOptions {
  /** A locally installed Ollama model. No downloads or cloud model selection are performed. */
  model: string;
  /** Default http://127.0.0.1:11434/api/embed. Only 127.0.0.1 and [::1] are accepted. */
  endpoint?: string;
  /** Total request deadline, including the body, in milliseconds (1..10000). Default 2000. */
  timeoutMs?: number;
}

export const MAX_EMBEDDING_INPUTS = 128;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export function embeddingConfig(options: LocalEmbeddingOptions): { endpoint: URL; timeoutMs: number } {
  const endpoint = new URL(options.endpoint ?? 'http://127.0.0.1:11434/api/embed');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/embed') {
    throw new Error('Embedding endpoint must be an HTTP literal loopback /api/embed URL without credentials, query or fragment.');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(options.model) ||
      /https?:/i.test(options.model) || /(?:^|[:/._-])cloud(?:$|[:/._-])/i.test(options.model)) {
    throw new Error('Embedding model must name a locally installed model.');
  }
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error('Embedding timeoutMs must be an integer from 1 to 10000.');
  }
  return { endpoint, timeoutMs };
}

async function postLocal(endpoint: URL, payload: unknown, signal: AbortSignal): Promise<unknown> {
  // Even callers importing the public core facade pay no HTTP initialization
  // cost until an explicitly enabled fallback actually needs a model request.
  const { request } = await import('node:http');
  const body = JSON.stringify(payload);
  return new Promise<unknown>((resolve, reject) => {
    // agent:false uses a direct connection, independent of HTTP_PROXY and global agents.
    const req = request(endpoint, {
      method: 'POST', agent: false, signal,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, res => {
      // node:http never follows redirects. Destroy rejected responses without buffering them.
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error('Local embedding server rejected the request.'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('Local embedding response exceeds the byte limit.'));
        } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Local embedding response is not JSON.')); }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Throws on any malformed batch, so a partial response never changes candidate competition. */
export async function localEmbeddings(
  input: readonly string[], options: LocalEmbeddingOptions, signal?: AbortSignal,
): Promise<number[][]> {
  // Callers may reuse and edit an options object while metadata is in flight.
  // Pin the model as well as the destination so the checked model is the one used.
  const model = options.model;
  const { endpoint, timeoutMs } = embeddingConfig({ model, endpoint: options.endpoint, timeoutMs: options.timeoutMs });
  if (input.length === 0 || input.length > MAX_EMBEDDING_INPUTS || input.some(s => s.length === 0 || s.length > 80)) {
    throw new Error('Embedding batch exceeds the term limits.');
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // An Ollama running on loopback can still proxy a cloud model. Inspect metadata
  // before sending vocabulary, even when a remote model has an innocuous local alias.
  const metadata = await postLocal(new URL('/api/show', endpoint), { model }, combined);
  if (!metadata || typeof metadata !== 'object' ||
      ('remote_host' in metadata && metadata.remote_host) || ('remote_model' in metadata && metadata.remote_model) ||
      !('model_info' in metadata) || !metadata.model_info || typeof metadata.model_info !== 'object' ||
      Object.keys(metadata.model_info).length === 0 || !('capabilities' in metadata) ||
      !Array.isArray(metadata.capabilities) || !metadata.capabilities.includes('embedding')) {
    throw new Error('Embedding model metadata does not confirm a local embedding model.');
  }
  const payload = await postLocal(endpoint, { model, input, truncate: false, keep_alive: '0s' }, combined);
  if (!payload || typeof payload !== 'object' || !('embeddings' in payload) ||
      ('remote_host' in payload && payload.remote_host) || ('remote_model' in payload && payload.remote_model) ||
      !('model' in payload) || payload.model !== model || !Array.isArray(payload.embeddings) ||
      payload.embeddings.length !== input.length) throw new Error('Invalid local embedding batch.');
  let dimensions: number | undefined;
  return payload.embeddings.map((vector: unknown) => {
    if (!Array.isArray(vector) || vector.length === 0 || vector.length > 4096 ||
        vector.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new Error('Invalid embedding vector.');
    dimensions ??= vector.length;
    if (vector.length !== dimensions) throw new Error('Inconsistent embedding dimensions.');
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding norm.');
    return vector.map((v: number) => v / norm);
  });
}
