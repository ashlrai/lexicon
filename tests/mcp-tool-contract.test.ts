import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, expect, it } from 'vitest';

type Schema = {
  type?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  minLength?: number;
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
};

// Only required fields are populated: optional defaults must remain optional.
// Fail loudly on a new schema shape rather than silently omit its coverage.
function example(schema: Schema): unknown {
  if ('const' in schema) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf) return example(schema.anyOf[0]);
  switch (schema.type) {
    case 'string': return 'x'.repeat(Math.max(1, schema.minLength ?? 0));
    case 'number':
    case 'integer': return schema.minimum ?? 1;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return requiredArguments(schema);
    default: throw new Error(`Unhandled input schema: ${JSON.stringify(schema)}`);
  }
}

function requiredArguments(schema: Schema): Record<string, unknown> {
  return Object.fromEntries((schema.required ?? []).map((key) => [key, example(schema.properties![key])]));
}

let home: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'lexicon-tool-contract-'));
  client = new Client({ name: 'tool-contract', version: '1' });
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', import.meta.resolve('tsx'), resolve('src/mcp/server.ts')],
    cwd: home,
    env: {
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      LEXICON_PATH: join(home, 'lexicon.yaml'),
      LEXICON_CWD: home,
    },
    stderr: 'pipe',
  });
  await client.connect(transport);
});

afterAll(async () => {
  try {
    await client?.close();
    await transport?.close();
  } finally {
    if (home) await rm(home, { recursive: true, force: true });
  }
});

it('enforces every live tool input contract and survives every invalid call', async () => {
  const tools = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  expect(tools.length).toBeGreaterThan(0);

  let invalidCalls = 0;
  async function rejects(name: string, args: Record<string, unknown> | undefined, field: string) {
    const label = `${name}: invalid ${field}, arguments=${JSON.stringify(args)}`;
    const result = await client.callTool({ name, ...(args === undefined ? {} : { arguments: args }) });
    expect(result.isError, label).toBe(true);
    expect(result.content, label).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining(field) }),
    ]));
    invalidCalls++;
    // Same process and connection, including after the final malformed call.
    await client.ping();
  }

  for (const tool of tools) {
    const schema = tool.inputSchema as Schema;
    const baseline = requiredArguments(schema);
    const required = schema.required ?? [];
    if (required.length) {
      for (const field of required) {
        await rejects(tool.name, undefined, field);
        await rejects(tool.name, {}, field);
        const missing = { ...baseline };
        delete missing[field];
        await rejects(tool.name, missing, field);
      }
    } else {
      // Some tools require one of several optional fields in their handler.
      const result = await client.callTool({ name: tool.name });
      if (result.isError) {
        const text = JSON.stringify(result.content);
        const fields = Object.keys(schema.properties ?? {});
        expect(fields.some((field) => text.includes(field)), `${tool.name}: missing input must name a field`).toBe(true);
      }
      await client.ping();
    }
    for (const [field, property] of Object.entries(schema.properties ?? {})) {
      // null plus a second incompatible JSON type catches coercion as well.
      const wrong = property.type === 'string' ? 42 : 'wrong-type';
      for (const value of [null, wrong]) {
        await rejects(tool.name, { ...baseline, [field]: value }, field);
      }
    }
    // Even a zero-field tool must validate its input object.
    await rejects(tool.name, { ...baseline, __contract_unknown: true }, '__contract_unknown');
  }
  console.info(`Validated ${tools.length} live tools with ${invalidCalls} invalid calls and recovery pings`);
}, 60_000);
