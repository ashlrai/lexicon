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
  packAlreadyInstalledNote,
  findRegistryEntry,
  downloadPack,
  findRegistryRecordMismatch,
  parsePackText,
  parseRegistryRef,
  verifyPackChecksum,
  assertUserRegistry,
} from '../../core/index.js';
import type { HarvestCandidate, ImportSourceId } from '../../core/index.js';
import { HARVEST_ROOTS_ENV, IMPORT_FORMAT_VALUES, bufferIO, containedPath, guarded, mcpWriteOpts, nonBlank, shellWord, skippedProjectFields, textResult, untrustedWriteFields } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import { MAX_IMPORT_BYTES, runImport } from '../../cli/cmd-import.js';
import { cliCommand } from '../../util/cli-hint.js';

const REGISTRY_SOURCE_DESC =
  'Registry index for community packs, as the user gave it: only an index the user registered is read (one they installed a pack from with the CLI, or one in LEXICON_REGISTRIES); any other is refused. Omit for the vendored starter packs only.';

export const registerPackTools: ToolRegistrar = (server, ctx) => {
  // `ctx.cwd` is read on every call: it follows the client's MCP roots once they arrive.
  const { load } = ctx;
  // Short-lived process memory only: neither previewed personal names nor
  // tokens are persisted. Applying uses this exact snapshot, never a re-harvest.
  const imports = new Map<string, { at: number; sources: string[]; destination: string; candidates: HarvestCandidate[] }>();
  const destination = (scope: string | undefined) => JSON.stringify({ cwd: ctx.cwd, scope: scope ?? 'global', ...resolvePaths({ cwd: ctx.cwd }) });
  const pruneImports = () => {
    for (const [token, preview] of imports) if (Date.now() - preview.at > 300_000) imports.delete(token);
  };
  server.registerTool(
    'list_packs',
    {
      title: 'List the starter term packs',
      description:
        'List the starter packs shipped with the lexicon (developer, ai, business, voice-tools: curated names with the misspellings STT produces for them) and which are already installed. ' +
        'Pass registry (an index the user registered; others are refused) to also list that index\'s community packs (<author>/<name>), with an installed flag for each. ' +
        'The installed flags come from trusted lexicon files only: when the repo has an untrusted project lexicon, the result carries `projectTrust`, `skippedProject` (its path) and `note`, and a pack only that file records reads as not installed. ' +
        'When a lexicon file\'s settings.packs and the registry records disagree, `registryMismatch { fileOnly, recordOnly }` names the refs: fileOnly will not be checked by ' + cliCommand('pack update') + ', recordOnly reads as not installed (' + cliCommand('pack remove <ref>') + ' clears the record). ' +
        'Call when onboarding a new user or when they ask what packs exist; describe each pack in one line, then call add_pack only for the ones they pick.',
      inputSchema: {
        registry: z.string().optional().describe(REGISTRY_SOURCE_DESC),
      },
    },
    async ({ registry }) =>
      guarded(async () => {
        // installedPacks and the mismatch read trusted files only, and the
        // skipped one is named by path, so it is never parsed.
        const [packs, loaded] = await Promise.all([listPacks(), load({ parseSkipped: false })]);
        const installed = installedPacks(loaded);
        // `lexicon pack list` and `pack search` report the same disagreement.
        const mismatch = await findRegistryRecordMismatch(loaded, { cwd: ctx.cwd });
        const result: Record<string, unknown> = {
          packs: packs.map((p) => ({ name: p.name, title: p.title, description: p.description, terms: p.terms, aliases: p.aliases, installed: installed.includes(p.name) })),
          installed,
          ...(mismatch ? { registryMismatch: mismatch } : {}),
        };
        if (registry) {
          await assertUserRegistry(registry, { cwd: ctx.cwd });
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
        // installedPacks reads trusted files only: a pack the skipped project
        // file records shows as not installed, so name that file (path only).
        return textResult({
          ...result,
          ...skippedProjectFields(loaded, 'A pack recorded only in that file shows as not installed until it is trusted.'),
        });
      }),
  );

  server.registerTool(
    'add_pack',
    {
      title: 'Install a starter term pack',
      description:
        'Install one starter pack from list_packs into the global lexicon (or the project .lexicon.yaml with scope: project; a project file that is not trusted yet is left untrusted, `trusted: false`: relay `nextStep`). ' +
        'Adds the pack\'s terms with source "pack"; a term the user already has keeps its own spelling and aliases and only gains the pack\'s. Idempotent. ' +
        'A pack adds dozens of terms (list_packs gives each pack\'s `terms` count), so name the pack and its size and ask before calling this. Remove one later with ' + cliCommand('pack remove <name>') + '. ' +
        'For a community pack, pass name as <author>/<name> with registry pointing at the index: without confirm the tool returns the full term-list preview and writes nothing (show it to the user first); with confirm: true it installs after they approved. A vendored pack installs directly: registry, previewDigest or confirm: false with one is refused and nothing is written. Community installs pin the checksum, so ' + cliCommand('pack update') + ' re-checks it later.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Pack name from list_packs (e.g. developer) or a community ref like example/cardiology. A pack name is 1 to 64 lowercase letters, digits and dashes, starting with a letter or digit; ' +
              'a community ref is <author>/<name>, the author 1 to 39 of the same characters, optionally followed by @<version> (up to 32 characters). Anything else is refused.',
          ),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project'."),
        registry: z.string().optional().describe(REGISTRY_SOURCE_DESC + ' Required for community refs.'),
        confirm: z.boolean().optional().describe('Community packs only: true = install after the user approved the preview. Omit/false = preview only, write nothing. A vendored pack has no preview: confirm: false with one is refused.'),
        previewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional().describe('Community packs only: digest returned by the approved full-content preview; required with confirm. Refused with a vendored pack.'),
      },
    },
    async ({ name, scope, registry, confirm, previewDigest }) =>
      guarded(async () => {
        if (isRegistryRef(name)) {
          if (!registry) throw new Error('a community pack ref needs the registry parameter (the index it was listed from)');
          const parsed = parseRegistryRef(name);
          await assertUserRegistry(registry, { cwd: ctx.cwd });
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
          const writeOpts = scope === 'project' ? await mcpWriteOpts(ctx) : {};
          const result = await installRegistryPack(entry, base, registry, {
            cwd: ctx.cwd,
            ...writeOpts,
            approvedBytes: bytes,
            ...(scope !== undefined ? { scope } : {}),
            ...(parsed.version !== undefined ? { pinnedVersion: parsed.version } : {}),
          });
          return textResult({
            name: result.ref,
            title: result.pack.title,
            added: result.added,
            merged: result.merged,
            alreadyInstalled: result.alreadyInstalled === true,
            path: result.path,
            scope: result.scope,
            summary: result.alreadyInstalled
              ? packAlreadyInstalledNote(result.ref, result)
              : `installed community pack ${result.ref}: ${result.added} new term${result.added === 1 ? '' : 's'}, ${result.merged} merged into ${result.path}`,
            ...(writeOpts.leaveUntrusted ? untrustedWriteFields(result.path, `The ${result.ref} terms`, true) : {}),
          });
        }
        if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`unknown pack "${name}" (pass a list_packs name or an <author>/<name> community ref)`);
        // A vendored pack installs in one call. registry, previewDigest and
        // confirm: false belong to the community preview flow; silently
        // installing anyway would turn a call that asked for a preview (or for
        // a registry's pack of that name) into a write.
        const stray = [
          ...(registry !== undefined ? ['registry'] : []),
          ...(previewDigest !== undefined ? ['previewDigest'] : []),
          ...(confirm === false ? ['confirm: false'] : []),
        ];
        if (stray.length > 0) {
          throw new Error(
            `"${name}" is a vendored starter pack, which installs directly without a preview, so ${stray.join(', ')} ${stray.length === 1 ? 'does' : 'do'} not apply (they are for <author>/<name> community refs). Nothing was installed. ` +
              'Call again with only name (and scope) once the user agreed to this pack, or pass the <author>/<name> ref for a community pack.',
          );
        }
        const writeOpts = scope === 'project' ? await mcpWriteOpts(ctx) : {};
        const result = await installPack(name, { cwd: ctx.cwd, ...(scope !== undefined ? { scope } : {}), ...writeOpts });
        return textResult({
          name: result.pack.name,
          title: result.pack.title,
          added: result.added,
          merged: result.merged,
          // A reinstall that changed nothing says so, with the pack's counts,
          // as `lexicon pack add` does, instead of "0 new terms, N merged".
          alreadyInstalled: result.alreadyInstalled === true,
          path: result.path,
          scope: result.scope,
          summary: result.alreadyInstalled
            ? packAlreadyInstalledNote(result.pack.name, result)
            : `installed ${result.pack.name}: ${result.added} new term${result.added === 1 ? '' : 's'}, ${result.merged} merged into ${result.path}`,
          ...(writeOpts.leaveUntrusted ? untrustedWriteFields(result.path, `The ${result.pack.name} pack's terms`, true) : {}),
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
        'Candidates merge like a pack install: an existing term keeps its spelling and only gains aliases; new terms are stamped import:<source> so their origin stays visible. ' +
        'With scope project and a project file that is not trusted yet, the file is written but left untrusted (`trusted: false`): relay `nextStep`.',
      inputSchema: {
        sources: z
          .array(z.enum(IMPLEMENTED_IMPORT_SOURCES))
          .optional()
          .describe('Explicit sources the user approved reading. Omitted sources returns only descriptions without probing or harvesting.'),
        apply: z.boolean().optional().describe('false/omitted = preview only: return availability and candidates, write nothing (default). true = write the candidates after the user approved the preview.'),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project' (.lexicon.yaml in the current repo)."),
        previewToken: z.string().optional().describe('Token from the approved preview; required to apply, refused without apply: true. Expires after five minutes or a server restart.'),
        approvedCandidateIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(50).optional().describe('Only candidate ids approved by the user from that preview; required to apply, refused without apply: true; empty means import nothing.'),
      },
    },
    async ({ sources, apply, scope, previewToken, approvedCandidateIds }) =>
      guarded(async () => {
        pruneImports();
        if (apply !== true && (previewToken !== undefined || approvedCandidateIds !== undefined)) {
          // Without apply this is a preview: a token or approval passed here
          // would be dropped while the call reads the sources again, and a
          // model that meant to apply would be told nothing was written only
          // by `applied: false`. Refuse before probing anything; the saved
          // preview stays usable.
          const stray = [...(previewToken !== undefined ? ['previewToken'] : []), ...(approvedCandidateIds !== undefined ? ['approvedCandidateIds'] : [])];
          throw new Error(
            `${stray.join(' and ')} ${stray.length === 1 ? 'is' : 'are'} only used with apply: true, so nothing was read or written and the preview is kept. ` +
              'To import the approved candidates, call again with apply: true, the same sources and scope, previewToken and approvedCandidateIds; to preview again, omit them.',
          );
        }
        if (apply === true) {
          if (sources === undefined || previewToken === undefined || approvedCandidateIds === undefined) {
            // Name what is missing and the call that produces it: an agent that
            // jumped to apply had no preview to take a token from.
            const missing = [
              ...(sources === undefined ? ['sources'] : []),
              ...(previewToken === undefined ? ['previewToken'] : []),
              ...(approvedCandidateIds === undefined ? ['approvedCandidateIds'] : []),
            ];
            throw new Error(
              `apply: true needs sources, previewToken and approvedCandidateIds from a user-approved preview; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing, so nothing was read or written. ` +
                'Preview first: call without apply, with the sources the user agreed to read (and the same scope), show the candidates, then call again with apply: true, those sources, the returned previewToken and only the ids the user approved.',
            );
          }
          const saved = imports.get(previewToken);
          if (!saved || saved.destination !== destination(scope) ||
              JSON.stringify([...new Set(sources)].sort()) !== JSON.stringify(saved.sources)) {
            throw new Error('preview is missing, expired, or belongs to different sources/destination; preview again');
          }
          const accepted = selectImportCandidates(saved.candidates, approvedCandidateIds);
          imports.delete(previewToken);
          const writeOpts = scope === 'project' ? await mcpWriteOpts(ctx) : {};
          const result = await applyImportCandidates(accepted, { cwd: ctx.cwd, ...(scope !== undefined ? { scope } : {}), ...writeOpts });
          return textResult({
            applied: true, candidates: accepted.map((c) => ({ id: importCandidateId(c), ...importCandidatePreview(c) })),
            added: result.added, merged: result.merged, path: result.path,
            summary: `imported ${result.added + result.merged} terms (${result.added} new, ${result.merged} merged)${result.path ? ` into ${result.path}` : ''}`,
            ...(writeOpts.leaveUntrusted && result.path !== undefined ? untrustedWriteFields(result.path, 'The imported terms', true) : {}),
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
        `\`path\` must be inside the server directory, its git root, a client root or ${HARVEST_ROOTS_ENV}; anything else is refused with the command the user can run themselves. ` +
        'Use dryRun: true first to show the user what would be added, then run again without it. ' +
        'With scope project and a project file that is not trusted yet, the file is written but left untrusted (`trusted: false`): relay `nextStep`. ' +
        'A dry run against such a file does not read it, so its rows carry no `created` (the report has `untrustedTarget: true`).',
      inputSchema: {
        path: nonBlank().optional().describe('File to import. Its extension helps auto-detection.'),
        content: nonBlank().max(MAX_IMPORT_BYTES).optional().describe('The dictionary text, when the file is not on this machine. Must not be blank.'),
        format: z.enum(IMPORT_FORMAT_VALUES).optional().describe("Input format; 'auto' (default) sniffs it."),
        scope: z.enum(TERM_SCOPES).optional().describe("'global' (default) or 'project' (.lexicon.yaml in the current repo)."),
        dryRun: z.boolean().optional().describe('Report what would be added without writing.'),
      },
    },
    async ({ path, content, format, scope, dryRun }) =>
      guarded(async () => {
        if (path === undefined && content === undefined) {
          throw new Error(
            'pass path or content: path is a dictionary file in this workspace, content the dictionary text itself (format defaults to auto); nothing was imported',
          );
        }
        // A model picks `path`, and the report echoes every line that parses
        // as a term (a dry run too), so an unchecked path read any file it
        // named into the conversation. With `content` the path is never read.
        const file = content === undefined && path !== undefined ? containedPath(ctx, path, (f) => `import ${shellWord(f)}`) : path ?? '-';
        const io = bufferIO();
        // A dry run passes it too: runImport then does not read an untrusted
        // project file to label each term new or merged.
        const writeOpts = scope === 'project' ? await mcpWriteOpts(ctx) : {};
        const code = await runImport(
          file,
          { cwd: ctx.cwd, format: format ?? 'auto', project: scope === 'project', dryRun: dryRun === true, json: true, ...writeOpts },
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
        // `import --json` leads with the CLI's `ok: true`; the tool result keeps its own shape.
        if (isRecord(report) && report.ok === true) delete report.ok;
        const target = isRecord(report) && typeof report.path === 'string' && writeOpts.leaveUntrusted === true ? report.path : undefined;
        const pending =
          target === undefined
            ? {}
            : dryRun !== true
              ? untrustedWriteFields(target, 'The imported terms', true)
              : {
                  trusted: false,
                  note:
                    `A run without dryRun would write to ${target}, which is not trusted, so the terms would not apply until the user trusts it` +
                    (isRecord(report) && report.untrustedTarget === true ? '; its terms were not read, so no row says whether it is new or merged.' : '.'),
                };
        return textResult(isRecord(report) ? { ...report, ...pending, ...(stderr ? { stderr } : {}) } : report);
      }),
  );
};
