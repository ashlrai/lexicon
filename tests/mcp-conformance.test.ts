/**
 * Raw JSON-RPC conformance for Lexicon's initialization-based MCP interface.
 * Revision 2025-11-25: basic/lifecycle, server/tools, and basic/utilities/cancellation
 * at https://modelcontextprotocol.io/specification/2025-11-25/.
 * The current 2026-07-28 basic/versioning spec calls this the legacy interface;
 * these tests do not claim support for its modern per-request metadata interface.
 * No Client wrapper: protocol errors must stay distinct from isError results.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema, InitializeResultSchema, ListToolsResultSchema,
  type JSONRPCMessage, type JSONRPCResultResponse, type JSONRPCError,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadLexicon } from '../src/core/index.js';
import { TOOL_ANNOTATIONS } from '../src/mcp/annotations.js';
import { createServer } from '../src/mcp/server.js';

vi.mock('../src/core/index.js', async (original) => ({
  ...await original<typeof import('../src/core/index.js')>(),
  loadLexicon: vi.fn(async () => ({
    merged: { version: 1, terms: [] },
    global: { path: '/unused/lexicon.yaml', scope: 'global', exists: false, lexicon: { version: 1, terms: [] } },
  })),
}));

type Reply = JSONRPCResultResponse | JSONRPCError;
let directory: string;
let server: ReturnType<typeof createServer>;
let wire: InMemoryTransport;
let received: JSONRPCMessage[];
let nextId: number;
const pending = new Map<string | number, (reply: Reply) => void>();

async function request(method: string, params?: Record<string, unknown>, id: string | number = nextId++): Promise<Reply> {
  const reply = new Promise<Reply>((resolve) => pending.set(id, resolve));
  await wire.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  return reply;
}

function result(reply: Reply): JSONRPCResultResponse['result'] {
  expect(reply).toHaveProperty('result');
  if (!('result' in reply)) throw new Error(`Unexpected protocol error: ${reply.error.message}`);
  return reply.result;
}

async function initialize(protocolVersion = '2025-11-25') {
  const reply = await request('initialize', {
    protocolVersion, capabilities: {}, clientInfo: { name: 'conformance', version: '1' },
  });
  const initialized = InitializeResultSchema.parse(result(reply));
  await wire.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return initialized;
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'lexicon-conformance-'));
  server = createServer({ cwd: directory });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  wire = clientTransport;
  received = [];
  nextId = 1;
  wire.onmessage = (message) => {
    received.push(message);
    if ('id' in message && message.id !== undefined && ('result' in message || 'error' in message)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  await server.connect(serverTransport);
  await wire.start();
});

afterEach(async () => {
  await server.close();
  await wire.close();
  pending.clear();
  vi.clearAllMocks();
  await rm(directory, { recursive: true, force: true });
});

describe('MCP legacy wire conformance', () => {
  it.each(['2025-11-25', '2025-06-18', '2024-11-05'])('negotiates supported version %s and advertises implemented capabilities', async (version) => {
    const initialized = await initialize(version);
    expect(initialized.protocolVersion).toBe(version);
    expect(initialized.serverInfo).toMatchObject({ name: 'lexicon', version: expect.any(String) });
    expect(initialized.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {} });
    expect(initialized.instructions).toContain('lexicon://me');
    expect(result(await request('ping'))).toEqual({});
  });

  it('offers a supported version when the requested version is unknown', async () => {
    expect((await initialize('1900-01-01')).protocolVersion).toBe('2025-11-25');
  });

  it('lists the complete registry deterministically with strict object schemas and explicit annotations', async () => {
    await initialize();
    const first = ListToolsResultSchema.parse(result(await request('tools/list')));
    expect(first.tools.length).toBeGreaterThan(0);
    expect(new Set(first.tools.map((tool) => tool.name)).size).toBe(first.tools.length);
    expect(first.tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
    expect(first.nextCursor).toBeUndefined();
    for (const tool of first.tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
      expect(tool.description?.length, tool.name).toBeGreaterThan(0);
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.annotations, tool.name).toEqual(TOOL_ANNOTATIONS[tool.name]);
    }
    await request('tools/call', { name: 'list_terms' });
    expect(ListToolsResultSchema.parse(result(await request('tools/list', {})))).toEqual(first);
  });

  it.each(['missing_tool', '__proto__', 'constructor'])('returns a protocol error for unknown tool %s and preserves string request IDs', async (name) => {
    await initialize();
    const reply = await request('tools/call', { name, arguments: {} }, 'unknown-tool');
    expect(reply).toMatchObject({ jsonrpc: '2.0', id: 'unknown-tool', error: { code: -32602, message: expect.stringContaining(name) } });
    expect(reply).not.toHaveProperty('result');
    expect(loadLexicon).not.toHaveBeenCalled();
  });

  it('rejects unknown methods as method-not-found protocol errors', async () => {
    await initialize();
    expect(await request('conformance/unknown')).toMatchObject({ error: { code: -32601 } });
  });

  it.each([{}, { name: 42 }, { name: 'list_terms', arguments: 'invalid' }])('rejects malformed call envelopes %j as protocol errors', async (params) => {
    await initialize();
    expect(await request('tools/call', params)).toMatchObject({ error: { code: -32602 } });
    expect(loadLexicon).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'normalize_transcript', arguments: {} },
    { name: 'normalize_transcript', arguments: { text: 42 } },
    { name: 'list_terms', arguments: { undeclared: true } },
    { name: 'list_terms', arguments: { limit: -1 } },
  ])('reports invalid tool inputs as execution errors %j without invoking the core', async (params) => {
    await initialize();
    const error = CallToolResultSchema.parse(result(await request('tools/call', params)));
    expect(error.isError).toBe(true);
    expect(error.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.any(String) })]));
    expect(loadLexicon).not.toHaveBeenCalled();
  });

  it('returns actionable execution failures and handles a successful retry on the same connection', async () => {
    await initialize();
    vi.mocked(loadLexicon).mockRejectedValueOnce(new Error('Conformance read failure'));
    const error = CallToolResultSchema.parse(result(await request('tools/call', { name: 'list_terms' })));
    expect(error.isError).toBe(true);
    expect(error.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: expect.stringContaining('Conformance read failure') })]));
    const success = CallToolResultSchema.parse(result(await request('tools/call', { name: 'list_terms', arguments: {} })));
    expect(success.isError).not.toBe(true);
  });

  it('suppresses a cancelled in-flight response without cancelling a concurrent request', async () => {
    await initialize();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const loaded = await loadLexicon({ cwd: directory });
    vi.mocked(loadLexicon).mockImplementationOnce(async () => {
      entered();
      await blocked;
      return loaded;
    });
    await wire.send({ jsonrpc: '2.0', id: 'cancel-me', method: 'tools/call', params: { name: 'list_terms' } });
    await started;
    try {
      await wire.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me', reason: 'Conformance cancellation' } });
      expect(result(await request('tools/call', { name: 'list_terms' }))).toHaveProperty('content');
    } finally {
      release();
    }
    // Drain promise continuations and the SDK's response path after the core finishes.
    await setImmediate();
    await setImmediate();
    expect(received.filter((message) => 'id' in message && message.id === 'cancel-me')).toEqual([]);
    expect(result(await request('ping'))).toEqual({});
  });

  it('ignores unknown and completed cancellation IDs and never replies to notifications', async () => {
    await initialize();
    await request('ping', undefined, 'completed');
    const count = received.length;
    for (const requestId of ['unknown', 'completed']) {
      await wire.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
    }
    await setImmediate();
    expect(received).toHaveLength(count);
    expect(result(await request('ping'))).toEqual({});
  });
});
