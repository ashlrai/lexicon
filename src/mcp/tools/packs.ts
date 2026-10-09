/**
 * Bulk term sources: the curated starter packs, community pack registries,
 * the guided vocabulary import, and importing a dictionary exported from
 * another dictation tool.
 */
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
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
  importCandidateId,
  importCandidatePreview,
  importPreviewDigest,
  selectImportCandidates,
  resolvePaths,
  listImportSources,
  listPacks,
  loadRegistryIndex,
  findRegistryEntry,
  downloadPack,
  parsePackText,
  parseRegistryRef,
  verifyPackChecksum,
} from '../../core/index.js';
import type { HarvestCandidate, ImportSourceId } from '../../core/index.js';
import { IMPORT_FORMAT_VALUES, bufferIO, guarded, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { MAX_IMPORT_BYTES, runImport } from '../../cli/cmd-import.js';

const REGISTRY_SOURCE_DESC =
  'Registry index for community packs: a local path, file:// URL or https:// URL. Omit for the vendored starter packs only.';

export const registerPackTools: ToolRegistrar = (server, { cwd, load }) => {
  // Short-lived process memory only: neither previewed personal names nor
  // tokens are persisted. Applying uses this exact snapshot, never a re-harvest.
  const imports = new Map<string, { at: number; sources: string[]; destination: string; candidates: HarvestCandidate[] }>();
  const destination = (scope: string | undefined) => JSON.stringify({ cwd, scope: scope ?? 'global', ...resolvePaths({ cwd }) });
  const pruneImports = () => {
    for (const [token, preview] of imports) if (Date.now() - preview.at > 300_000) imports.delete(token);
  };
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
        previewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Community packs: digest returned by the approved full-content preview; required with confirm.'),
      },
    },
    async ({ name, scope, registry, confirm, previewDigest }) =>
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
            terms: pack.lexicon.terms.map((t) => ({ ...t })),
          };
          const digest = createHash('sha256').update(JSON.stringify({
            name, registry, destination: destination(scope), entry, preview,
            bytes: createHash('sha256').update(bytes).digest('hex'),
          })).digest('hex');
          if (confirm !== true) {
            return textResult({
              preview,
              previewDigest: digest,
              installed: false,
              next: 'Show this term list to the user; call again with confirm: true and this previewDigest only after they approve every term field.',
            });
          }
          if (previewDigest !== digest) throw new Error('community pack contents or destination changed, or preview digest is missing; preview again before installing');
          const result = await installRegistryPack(entry, base, registry, {
            cwd,
            approvedBytes: bytes,
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
        'Ask which sources to read first, then pass explicit sources without apply to preview candidates. Show the candidate contents and ids; apply requires the returned previewToken and only approvedCandidateIds. Applying consumes the same snapshot without reading the sources again. ' +
        'Candidates merge like a pack install: an existing term keeps its spelling and only gains aliases; new terms are stamped import:<source> so their origin stays visible.',
      inputSchema: {
        sources: z
          .array(z.enum(IMPLEMENTED_IMPORT_SOURCES))
          .optional()
          .describe('Explicit sources the user approved reading. Omitted sources returns only descriptions without probing or harvesting.'),
        apply: z.boolean().optional().describe('false/omitted = preview only: return availability and candidates, write nothing (default). true = write the candidates after the user approved the preview.'),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project' (.lexicon.yaml in the current repo)."),
        previewToken: z.string().optional().describe('Token from the approved preview; required to apply. Expires after five minutes or a server restart.'),
        approvedCandidateIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(50).optional().describe('Only candidate ids approved by the user from that preview; required to apply, empty means import nothing.'),
      },
    },
    async ({ sources, apply, scope, previewToken, approvedCandidateIds }) =>
      guarded(async () => {
        pruneImports();
        if (apply === true) {
          if (sources === undefined || previewToken === undefined || approvedCandidateIds === undefined) {
            throw new Error('apply requires explicit sources, previewToken and approvedCandidateIds from a user-approved preview');
          }
          const saved = imports.get(previewToken);
          if (!saved || saved.destination !== destination(scope) ||
              JSON.stringify([...new Set(sources)].sort()) !== JSON.stringify(saved.sources)) {
            throw new Error('preview is missing, expired, or belongs to different sources/destination; preview again');
          }
          const accepted = selectImportCandidates(saved.candidates, approvedCandidateIds);
          imports.delete(previewToken);
          const result = await applyImportCandidates(accepted, { cwd, ...(scope !== undefined ? { scope } : {}) });
          return textResult({
            applied: true, candidates: accepted.map((c) => ({ id: importCandidateId(c), ...importCandidatePreview(c) })),
            added: result.added, merged: result.merged, path: result.path,
            summary: `imported ${result.added + result.merged} terms (${result.added} new, ${result.merged} merged)${result.path ? ` into ${result.path}` : ''}`,
          });
        }
        const wanted = [...new Set(sources ?? [])];
        const availability: { id: ImportSourceId; label: string; privacy: string; implemented: boolean; available: boolean; reason?: string; chosen: boolean }[] = [];
        for (const source of listImportSources()) {
          const chosen = wanted.includes(source.id);
          const checked = chosen ? await source.checkAvailable() : { available: false, reason: 'not selected; availability was not probed' };
          availability.push({ id: source.id, label: source.label, privacy: source.privacy,
            implemented: source.implemented, ...checked, chosen });
        }
        const chosen = wanted.filter((id) => availability.some((s) => s.id === id && s.implemented && s.available));
        const candidates = chosen.length === 0 ? [] : await harvestImportSources(chosen, {}, { limit: 50 });
        while (imports.size >= 20) imports.delete(imports.keys().next().value!);
        const token = randomUUID();
        imports.set(token, { at: Date.now(), sources: [...new Set(wanted)].sort(), destination: destination(scope), candidates: structuredClone(candidates) });
        return textResult({ sources: availability,
          candidates: candidates.map((c) => ({ id: importCandidateId(c), ...importCandidatePreview(c) })),
          previewToken: token, previewDigest: importPreviewDigest(wanted, candidates, destination(scope)), applied: false,
          next: sources === undefined ? 'Ask which sources the user wants read, then preview with explicit sources.' :
            'Show the contents and ids to the user; call with apply: true, the same sources/scope, previewToken and only approvedCandidateIds.',
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
