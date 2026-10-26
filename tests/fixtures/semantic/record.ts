/** Explicit, manual fixture refresh against an already installed local bge-m3. Never run by tests. */
import { writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { localEmbeddings } from '../../../src/match/local-embeddings.js';
import cases from './cases.json' with { type: 'json' };

const model = 'bge-m3:latest';
const tags = await new Promise<{ models: { name: string; digest: string }[] }>((resolve, reject) => {
  const req = get('http://127.0.0.1:11434/api/tags', { agent: false, signal: AbortSignal.timeout(2000) }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('error', reject);
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
  });
  req.on('error', reject);
});
const installed = tags.models.find(m => m.name === model);
if (!installed) throw new Error('Install bge-m3 yourself before recording; this script does not download models.');
const inputs = [...new Set([...cases.terms, ...cases.cases.map(c => c.heard)])];
const vectors = await localEmbeddings(inputs, { model, timeoutMs: 10_000 });
const fixture = {
  provenance: { model, digest: installed.digest, recordedAt: new Date().toISOString(), dimensions: vectors[0].length, endpoint: 'http://127.0.0.1:11434/api/embed', rounding: 'unit vectors rounded to 7 decimal places' },
  vectors: Object.fromEntries(inputs.map((input, i) => [input, vectors[i].map(v => Number(v.toFixed(7)))])),
};
// One vector per line keeps provenance and input names reviewable without expanding 59k scalars.
const rows = Object.entries(fixture.vectors).map(([input, v]) => `    ${JSON.stringify(input)}: ${JSON.stringify(v)}`);
await writeFile(new URL('./bge-m3.json', import.meta.url), `{
  "provenance": ${JSON.stringify(fixture.provenance)},
  "vectors": {
${rows.join(',\n')}
  }
}\n`);
console.log(`Recorded ${inputs.length} local ${model} vectors (${vectors[0].length} dimensions).`);
