/**
 * Ashlr companion handshake v1 (`lexicon --ashlr-handshake [--json]`): one
 * JSON object naming the CLI, its protocols and capabilities, local health
 * and the files lexicon may edit, so `phm companions` / `phm doctor` stop
 * guessing from `--help`. Same shape as locus, ashlr-stack, ashlr-plugin and
 * ashlr-md; contract: docs/ashlr-handshake.md.
 *
 * Answered before commander parses anything: no network, and the lexicon
 * file is only checked for existence, never read.
 */

export const HANDSHAKE_FLAG = '--ashlr-handshake';

export interface Handshake {
  kind: 'ashlr.handshake';
  schema_version: 1;
  name: string;
  command: string;
  version: string;
  protocols: Record<string, number>;
  capabilities: string[];
  health: { status: 'ok' | 'degraded' | 'unknown'; checks: Array<{ id: string; status: 'ok' | 'missing' | 'absent' }> };
  edits: string[];
  receipts: string[];
}

export function buildHandshake(version: string, found: { globalLexicon: boolean }): Handshake {
  return {
    kind: 'ashlr.handshake',
    schema_version: 1,
    name: 'lexicon',
    command: 'lexicon',
    version,
    protocols: { 'ashlr.handshake': 1, mcp: 1 },
    capabilities: ['transcript-normalize', 'term-lexicon', 'suggest-terms', 'mcp-server', 'agent-install', 'voice-hooks', 'doctor-json'],
    health: {
      // A fresh install has no lexicon file yet; `lexicon setup` creates it.
      status: 'ok',
      checks: [{ id: 'global-lexicon', status: found.globalLexicon ? 'ok' : 'absent' }],
    },
    edits: [
      '~/.config/lexicon/',
      '.lexicon.yaml',
      '.mcp.json',
      '.cursor/mcp.json',
      '~/.claude/settings.json',
      '~/.cursor/mcp.json',
      '~/.codex/config.toml',
    ],
    receipts: [],
  };
}

/** True when the arguments (without node and the script) ask for it; `--json` alongside is accepted. */
export function wantsHandshake(args: readonly string[]): boolean {
  return args.includes(HANDSHAKE_FLAG);
}
