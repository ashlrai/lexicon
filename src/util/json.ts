/**
 * Reading and writing the JSON config files this tool merges into: Claude's
 * settings.json, the MCP client configs behind `lexicon install`, the trust
 * registry, serve.json. Every writer here merges into what is already on disk
 * and formats the same way (2-space indent, one trailing newline), so a config
 * this tool touched stays diffable against one a human edited.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errorMessage, isEnoent } from './errors.js';

/** A plain object (not null, not an array) — the shape every config merge expects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How a JSON config file is formatted when this tool writes it. */
export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The outcome of reading a JSON config: missing, parsed, or present but
 * unreadable/invalid. Callers distinguish the three because "not there yet" is
 * normal (create it) while "there but broken" must be reported, never clobbered.
 */
export interface JsonFileRead {
  exists: boolean;
  value?: unknown;
  error?: string;
}

/** Read and parse a JSON config file. An empty file parses as `{}`. Never throws. */
export async function readJsonFile(file: string): Promise<JsonFileRead> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (isEnoent(err)) return { exists: false };
    return { exists: true, error: errorMessage(err) };
  }
  try {
    return { exists: true, value: raw.trim() === '' ? {} : (JSON.parse(raw) as unknown) };
  } catch (err) {
    return { exists: true, error: errorMessage(err) };
  }
}

/** `mkdir -p` the parent directory and write `value` as formatted JSON. */
export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, formatJson(value), 'utf8');
}
