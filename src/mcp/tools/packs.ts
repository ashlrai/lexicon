/**
 * Bulk term sources: the curated starter packs, community pack registries,
 * the guided vocabulary import, and importing a dictionary exported from
 * another dictation tool.
 */
import { z } from 'zod';
import { isRecord } from '../../util/json.js';
import {
  IMPLEMENTED_IMPORT_SOURCES,
  TERM_SCOPES,
  applyImportCandidates,
  getImportSource,
  harvestImportSources,
  installPack,
  installRegistryPack,
  installedPacks,
  isRegistryRef,
  listImportSources,
  listPacks,
  loadRegistryIndex,
  findRegistryEntry,
  downloadPack,
  parsePackText,
  parseRegistryRef,
  verifyPackChecksum,
} from '../../core/index.js';
import { IMPORT_FORMAT_VALUES, bufferIO, guarded, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { MAX_IMPORT_BYTES, runImport } from '../../cli/cmd-import.js';

const REGISTRY_SOURCE_DESC =
  'Registry index for community packs: a local path, file:// URL or https:// URL. Omit for the vendored starter packs only.';

export const registerPackTools: ToolRegistrar = (server, { cwd, load }) => {
  server.registerTool(
    'list_packs',
    {
      title: 'List the starter term packs',
      description:
        'List the starter packs shipped with the lexicon (developer, ai, business, voice-tools: curated names with the misspellings STT produces for them) and which are already installed. ' +
        'Pass registry (a local path, file:// or https:// URL) to also list that index\'s community packs (<author>/<name>), with an installed flag for each. ' +
        'Call when onboarding a new user or when they ask what packs exist; describe each pack in one line, then call add_pack only for the ones they pick.',
      inputSchema: {
        registry: z.string().optional().describe(REGISTRY_SOURCE_DESC),
      },
    },
    async ({ registry }) =>
      guarded(async () => {
        const [packs, loaded] = await Promise.all([listPacks(), load()]);
        const installed = installedPacks(loaded);
        const result: Record<string, unknown> = {
          packs: packs.map((p) => ({ name: p.name, title: p.title, description: p.description, terms: p.terms, aliases: p.aliases, installed: installed.includes(p.name) })),
          installed,
        };
        if (registry) {
          const { index } = await loadRegistryIndex(registry);
          result.community = index.packs.map((p) => ({
            ref: p.ref,
            name: p.name,
            author: p.author,
            title: p.title,
            description: p.description,
            version: p.version,
            terms: p.terms,
            aliases: p.aliases,
            checksum: p.checksum,
            installed: installed.includes(p.ref),
          }));
        }
        return textResult(result);
      }),
  );

  server.registerTool(
    'add_pack',
    {
      title: 'Install a starter term pack',
      description:
        'Install one starter pack from list_packs into the global lexicon (or the project .lexicon.yaml with scope: project). ' +
        'Adds the pack\'s terms with source "pack"; a term the user already has keeps its own spelling and aliases and only gains the pack\'s. Idempotent. ' +
        'A pack is sixty-odd terms, so name the pack and ask before calling this. Remove one later with `lexicon pack remove <name>`. ' +
        'For a community pack, pass name as <author>/<name> with registry pointing at the index: without confirm the tool returns the full term-list preview and writes nothing (show it to the user first); with confirm: true it installs after they approved. Community installs pin the checksum, so `lexicon pack update` re-checks it later.',
      inputSchema: {
        name: z.string().describe('Pack name from list_packs (e.g. developer) or a community ref like example/cardiology.'),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project'."),
        registry: z.string().optional().describe(REGISTRY_SOURCE_DESC + ' Required for community refs.'),
        confirm: z.boolean().optional().describe('Community packs only: true = install after the user approved the preview. Omit/false = preview only, write nothing.'),
      },
    },
    async ({ name, scope, registry, confirm }) =>
      guarded(async () => {
        if (isRegistryRef(name)) {
          if (!registry) throw new Error('a community pack ref needs the registry parameter (the index it was listed from)');
          const parsed = parseRegistryRef(name);
          const { index, base } = await loadRegistryIndex(registry);
          const entry = findRegistryEntry(index, parsed.ref);
          const bytes = await downloadPack(entry, base);
          verifyPackChecksum(bytes, entry.checksum, entry.ref);
          const pack = parsePackText(bytes.toString('utf8'), entry.url, entry.name);
          const preview = {
            ref: entry.ref,
            title: entry.title,
            author: entry.author,
            homepage: entry.homepage,
            version: entry.version,
            checksum: entry.checksum,
            terms: pack.lexicon.terms.map((t) => ({ canonical: t.canonical, aliases: t.aliases, category: t.category })),
          };
          if (confirm !== true) {
            return textResult({
              preview,
              installed: false,
              next: 'Show this term list to the user; call again with confirm: true only after they approve it.',
            });
          }
          const result = await installRegistryPack(entry, base, registry, {
            cwd,
            ...(scope !== undefined ? { scope } : {}),
            ...(parsed.version !== undefined ? { pinnedVersion: parsed.version } : {}),
          });
          return textResult({
            name: result.ref,
            title: result.pack.title,
            added: result.added,
            merged: result.merged,
            path: result.path,
            scope: result.scope,
            summary: `installed community pack ${result.ref}: ${result.added} new term${result.added === 1 ? '' : 's'}, ${result.merged} merged into ${result.path}`,
          });
        }
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`unknown pack "${name}" (pass a list_packs name or an <author>/<name> community ref)`);
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
    'import_vocabulary',
    {
      title: 'Import proper nouns from the user\'s own sources (preview, then apply)',
      description:
        'Guided vocabulary import: harvest candidate terms from where the user\'s proper nouns live (contacts: macOS Contacts names; calendar: macOS Calendar event titles and attendee names; github: the gh CLI\'s username, org members and repo names). ' +
        'Every source is local-first and opt-in: the preview names exactly what each source reads, unavailable sources say why, and email/Slack are not implemented (reading mail needs new OAuth scopes, which is a conversation, not a default). ' +
        'Call without apply first: that is a preview that lists each source\'s availability and the merged candidates (canonical, aliases, evidence) and writes nothing. Show it to the user, let them strike candidates, then call again with apply: true and sources limited to what they chose. ' +
        'Candidates merge like a pack install: an existing term keeps its spelling and only gains aliases; new terms are stamped import:<source> so their origin stays visible.',
      inputSchema: {
        sources: z
          .array(z.enum(IMPLEMENTED_IMPORT_SOURCES))
          .optional()
          .describe('Sources to harvest (default: every available one). Ask the user which of contacts, calendar, github they want before applying.'),
        apply: z.boolean().optional().describe('false/omitted = preview only: return availability and candidates, write nothing (default). true = write the candidates after the user approved the preview.'),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project' (.lexicon.yaml in the current repo)."),
      },
    },
    async ({ sources, apply, scope }) =>
      guarded(async () => {
        const wanted = sources ?? [...IMPLEMENTED_IMPORT_SOURCES];
        const availability = [];
        for (const s of listImportSources()) {
          const checked = await s.checkAvailable();
          availability.push({
            id: s.id,
            label: s.label,
            privacy: s.privacy,
            implemented: s.implemented,
            available: checked.available,
            ...(checked.reason ? { reason: checked.reason } : {}),
            chosen: wanted.includes(s.id as (typeof IMPLEMENTED_IMPORT_SOURCES)[number]),
          });
        }
        const chosen = wanted.filter((id) => {
          const s = getImportSource(id);
          return s.implemented;
        });
        const candidates = await harvestImportSources(chosen, {}, { limit: 50 });
        const preview = {
          sources: availability,
          candidates: candidates.map((c) => ({
            canonical: c.canonical,
            category: c.category,
            source: c.source,
            aliases: c.suggestedAliases,
            evidence: c.evidence,
            count: c.count,
          })),
        };
        if (apply !== true) {
          return textResult({
            ...preview,
            applied: false,
            next: 'Show the candidates to the user, let them strike any, then call again with apply: true and sources limited to what they chose.',
          });
        }
        const result = await applyImportCandidates(candidates, { cwd, ...(scope !== undefined ? { scope } : {}) });
        return textResult({
          ...preview,
          applied: true,
          added: result.added,
          merged: result.merged,
          path: result.path,
          summary: `imported ${result.added + result.merged} terms (${result.added} new, ${result.merged} merged)${result.path ? ` into ${result.path}` : ''}`,
        });
      }),
  );

  server.registerTool(
    'import_dictionary',
    {
      title: 'Import an existing dictionary',
      description:
        "Import a dictionary the user already has (Wispr Flow CSV, Superwhisper JSON, macOS Text Replacement plist, espanso YAML, markdown (the CLAUDE.md '## Voice lexicon' table or '- **Canonical**: aliases' bullets), plain text 'Canonical: alias1, alias2', generic CSV, or a lexicon JSON/YAML) into the lexicon. " +
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
