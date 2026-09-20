/**
 * Bulk term sources: the curated starter packs, and importing a dictionary
 * exported from another dictation tool.
 */
import { z } from 'zod';
import { isRecord } from '../../util/json.js';
import { TERM_SCOPES, installPack, installedPacks, listPacks } from '../../core/index.js';
import { IMPORT_FORMAT_VALUES, bufferIO, guarded, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { MAX_IMPORT_BYTES, runImport } from '../../cli/cmd-import.js';

export const registerPackTools: ToolRegistrar = (server, { cwd, load }) => {
  server.registerTool(
    'list_packs',
    {
      title: 'List the starter term packs',
      description:
        'List the starter packs shipped with the lexicon (developer, ai, business, voice-tools: curated names with the misspellings STT produces for them) and which are already installed. ' +
        'Call when onboarding a new user or when they ask what packs exist; describe each pack in one line, then call add_pack only for the ones they pick.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const [packs, loaded] = await Promise.all([listPacks(), load()]);
        const installed = installedPacks(loaded);
        return textResult({
          packs: packs.map((p) => ({ name: p.name, title: p.title, description: p.description, terms: p.terms, aliases: p.aliases, installed: installed.includes(p.name) })),
          installed,
        });
      }),
  );

  server.registerTool(
    'add_pack',
    {
      title: 'Install a starter term pack',
      description:
        'Install one starter pack from list_packs into the global lexicon (or the project .lexicon.yaml with scope: project). ' +
        'Adds the pack\'s terms with source "pack"; a term the user already has keeps its own spelling and aliases and only gains the pack\'s. Idempotent. ' +
        'A pack is sixty-odd terms, so name the pack and ask before calling this. Remove one later with `lexicon pack remove <name>`.',
      inputSchema: {
        name: z.string().regex(/^[a-z0-9-]+$/).describe('Pack name from list_packs, e.g. developer.'),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project'."),
      },
    },
    async ({ name, scope }) =>
      guarded(async () => {
        const result = await installPack(name, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({
          name: result.pack.name,
          title: result.pack.title,
          added: result.added,
          merged: result.merged,
          path: result.path,
          scope: result.scope,
          summary: `installed ${result.pack.name}: ${result.added} new term${result.added === 1 ? '' : 's'}, ${result.merged} merged into ${result.path}`,
        });
      }),
  );

  server.registerTool(
    'import_dictionary',
    {
      title: 'Import an existing dictionary',
      description:
        "Import a dictionary the user already has (Wispr Flow CSV, Superwhisper JSON, macOS Text Replacement plist, espanso YAML, plain text 'Canonical: alias1, alias2', generic CSV, or a lexicon JSON/YAML) into the lexicon. " +
        'Pass either path (a file on disk, resolved from the server working directory) or content (the text itself, up to 8 MB). ' +
        'Use dryRun: true first to show the user what would be added, then run again without it.',
      inputSchema: {
        path: z.string().optional().describe('File to import. Its extension helps auto-detection.'),
        content: z.string().max(MAX_IMPORT_BYTES).optional().describe('The dictionary text, when the file is not on this machine.'),
        format: z.enum(IMPORT_FORMAT_VALUES).optional().describe("Input format; 'auto' (default) sniffs it."),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project' (.lexicon.yaml in the current repo)."),
        dryRun: z.boolean().optional().describe('Report what would be added without writing.'),
      },
    },
    async ({ path, content, format, scope, dryRun }) =>
      guarded(async () => {
        if (path === undefined && content === undefined) throw new Error('pass path or content');
        const io = bufferIO();
        const code = await runImport(
          path ?? '-',
          { cwd, format: format ?? 'auto', project: scope === 'project', dryRun: dryRun === true, json: true },
          io,
          content !== undefined ? async () => content : undefined,
        );
        if (code !== 0) throw new Error(io.err().trim() || `import failed (exit ${code})`);
        const out = io.out().trim();
        let report: unknown;
        try {
          report = JSON.parse(out);
        } catch {
          report = { output: out };
        }
        const stderr = io.err().trim();
        return textResult(isRecord(report) ? { ...report, ...(stderr ? { stderr } : {}) } : report);
      }),
  );
};
