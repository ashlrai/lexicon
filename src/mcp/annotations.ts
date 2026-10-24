/**
 * The MCP tool annotations (`readOnlyHint`, `destructiveHint`,
 * `idempotentHint`, `openWorldHint`) of every tool, in one table so each
 * claim can be read next to the others and checked against what the handler
 * does. A client uses them to decide what to run without asking: with none,
 * the spec's defaults say every tool may be destructive and reach the open
 * world, so `list_terms` looked as risky as `remove_term`.
 *
 * A hint covers the tool's most far-reaching call: `harvest_repo` previews
 * by default, but `add: true` writes, so it is not read-only. Every hint is
 * spelled out, the defaults included, so nothing rests on a client's default.
 * `createServer` refuses to register a tool missing from this table.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

type Hints = Required<Pick<ToolAnnotations, 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>>;

/** Reads only (a cache file aside): nothing a call changes. */
const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds or merges; nothing is deleted or replaced, and a repeat changes nothing more. */
const MERGE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOL_ANNOTATIONS: Readonly<Record<string, Hints>> = {
  // Bumps a per-term hit counter in the lexicon file on a real change, so not
  // read-only, and a repeat counts again.
  normalize_transcript: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  add_term: MERGE,
  // Deletes a term or an alias; a second call finds nothing more to remove.
  remove_term: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  list_terms: READ,
  export_lexicon: READ,
  // Adds an alias, or recases a term's canonical; the same correction again changes nothing.
  learn_correction: MERGE,
  suggest_canonical: READ,
  lexicon_stats: READ,
  // Read-only preview unless `add: true`, which merges candidates into the project file.
  harvest_repo: MERGE,
  suggest_terms: READ,
  // A 'stale' suggestion removes a term; applying it again is refused, not a no-op.
  apply_suggestion: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  // 'untrust' deletes the registry entry; 'trust' pins (after the user answers).
  trust_project: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  lexicon_doctor: READ,
  // Writes the lexicon entry into a client config (replacing a stale launch of
  // lexicon's own, never another server).
  install_client: MERGE,
  uninstall_client: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  // Seeds terms, installs into clients and packs, may install a login service.
  setup_lexicon: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  // Probes 127.0.0.1 only.
  serve_status: READ,
  // With `registry`, fetches a community index over the network.
  list_packs: { ...READ, openWorldHint: true },
  // A community pack is downloaded from its registry.
  add_pack: { ...MERGE, openWorldHint: true },
  // Reads the user's Contacts, Calendar or GitHub (through gh), then merges
  // once per preview token: a second apply with the same token is refused.
  import_vocabulary: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  import_dictionary: MERGE,
};

/** The annotations for `name`; throws for a tool the table does not list, so a new tool cannot ship without them. */
export function toolAnnotations(name: string): Hints {
  const hints = TOOL_ANNOTATIONS[name];
  if (hints === undefined) throw new Error(`MCP tool ${name} has no entry in TOOL_ANNOTATIONS (src/mcp/annotations.ts)`);
  return hints;
}
