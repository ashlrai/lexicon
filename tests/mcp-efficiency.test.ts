/** Wire compatibility snapshots are captured before the size reductions. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { createServer } from '../src/mcp/server.js';
import { runAdd, runList, runNormalize, runPath } from '../src/cli/commands.js';

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, v]) => [key, withoutDescriptions(v)]));
  return value;
}

it('preserves discovery schemas, annotations and parsed common command results', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lexicon-efficiency-'));
  const previous = process.env.LEXICON_PATH;
  process.env.LEXICON_PATH = path.join(dir, 'lexicon.yaml');
  const server = createServer({ cwd: dir });
  const client = new Client({ name: 'efficiency-test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const measurements: Record<string, { bytes: number; estimatedTokens: number }> = {};
  const measure = (label: string, text: string) => {
    const bytes = Buffer.byteLength(text);
    measurements[label] = { bytes, estimatedTokens: Math.ceil(bytes / 4) };
  };
  const stable = (value: unknown): unknown => JSON.parse(JSON.stringify(value).split(dir).join('<fixture>').replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '2026-01-01T00:00:00.000Z'));
  try {
    await server.connect(st);
    await client.connect(ct);
    const listed = await client.listTools();
    measure('tools/list', JSON.stringify(listed));
    for (const tool of listed.tools) measure(`tool/${tool.name}`, JSON.stringify(tool));
    expect(withoutDescriptions(listed)).toMatchSnapshot('discovery contract');
    const opts = { cwd: dir, json: true };
    let output = '';
    const io = { stdout: (s: string) => { output += s; }, stderr: (_s: string) => {} };
    for (const [name, run] of [
      ['add', () => runAdd('Ashlr.AI', ['Ashler'], opts, io)],
      ['list', () => runList(opts, io)],
      ['normalize', () => runNormalize(['Ashler builds tools'], { ...opts, dryRun: true }, io)],
      ['path', () => runPath(opts, io)],
    ] as const) {
      output = '';
      expect(await run()).toBe(0);
      expect(output).toBe(JSON.stringify(JSON.parse(output)) + '\n');
      measure(`cli/${name}`, JSON.stringify(stable(JSON.parse(output)), null, output.includes('\n  ') ? 2 : undefined) + '\n');
      expect(stable(JSON.parse(output))).toMatchSnapshot(`cli/${name}`);
    }
    for (const [name, args] of [
      ['list_terms', {}], ['list_terms', { limit: 1, offset: 0 }],
      ['normalize_transcript', { text: 'Ashler builds tools', dryRun: true }], ['lexicon_stats', {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const label = `mcp/${name}${'limit' in args ? '/page' : ''}`;
      measure(label, JSON.stringify(stable(result)));
      const parsed = { ...result, content: (result.content as { type: string; text: string }[]).map((block) => ({ ...block, text: JSON.parse(block.text) as unknown })) };
      expect(stable(parsed)).toMatchSnapshot(label);
    }
    // Byte/4 is a reproducible estimate, not a model-specific tokenizer.
    if (process.env.LEXICON_AUDIT_REPORT) await fs.writeFile(process.env.LEXICON_AUDIT_REPORT, JSON.stringify(measurements, null, 2) + '\n');
    // Baseline: 53,285 bytes. Guard the reduction against future verbosity.
    expect(measurements['tools/list']!.bytes).toBeLessThanOrEqual(51764);
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env.LEXICON_PATH;
    else process.env.LEXICON_PATH = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
