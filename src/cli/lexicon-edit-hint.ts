/**
 * The `lexicon edit` command a parse error names. Kept out of io.ts so the
 * MCP server can report the same hint without loading the core.
 */
import path from 'node:path';

/**
 * The `lexicon edit` command that opens the file a store parse/validation
 * error names (`--project` for a `.lexicon.yaml`), or undefined when the
 * message is not one. The MCP server words its own next step around it.
 */
export function unreadableLexiconEdit(message: string): string | undefined {
  const m = /^(?:Failed to parse lexicon YAML|Invalid lexicon) at (.+?): /.exec(message);
  if (!m) return undefined;
  return path.basename(m[1] ?? '') === '.lexicon.yaml' ? 'lexicon edit --project' : 'lexicon edit';
}
