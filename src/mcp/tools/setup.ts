/**
 * First-run setup and health: the doctor report, installing into an agent
 * client, the guided `setup_lexicon` flow, and whether `lexicon serve` is up.
 */
import { z } from 'zod';
import { INSTALL_CLIENT_VALUES, INSTALL_SCOPES, SERVE_HEALTH_URL, bufferIO, cliDirForInstall, guarded, textResult } from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import type { SetupOptions } from '../../cli/cmd-setup.js';
import { errorMessage } from '../../util/errors.js';
import { isRecord } from '../../util/json.js';
import { runDoctorReport } from '../../cli/commands.js';
import { runInstall } from '../../cli/cmd-install.js';
import { runSetup } from '../../cli/cmd-setup.js';

export const registerSetupTools: ToolRegistrar = (server, { cwd, load }) => {
  server.registerTool(
    'lexicon_doctor',
    {
      title: 'Diagnose the lexicon install',
      description:
        'Diagnose the lexicon install: files, trust, hooks, MCP registration, clipboard, voice tools. ' +
        'Call when corrections are not happening or the user asks whether it is set up. ' +
        "Returns { ok, checks: [{ level: 'ok'|'warn'|'fail'|'info', message }], paths, versions }; summarise the fails and warns for the user and offer the fix each message names.",
      inputSchema: {},
    },
    async () => guarded(async () => textResult(await runDoctorReport({ cwd }))),
  );

  server.registerTool(
    'install_client',
    {
      title: 'Register the lexicon MCP server in an agent client',
      description:
        "Register the lexicon MCP server (and, for Claude Code, its hooks) in an agent client's config: claude, codex, cursor, windsurf, gemini, vscode or claude-desktop. " +
        'Call with apply omitted (or false) first: that is a preview that returns the exact file and entry that would change and writes nothing. ' +
        'Show the preview to the user and call again with apply: true only after they confirm. Idempotent: an entry that is already present is left alone.',
      inputSchema: {
        client: z.enum(INSTALL_CLIENT_VALUES).describe('Which client to configure.'),
        apply: z.boolean().optional().describe('false/omitted = preview only (default). true = write the config after the user confirmed.'),
        scope: z
          .enum(INSTALL_SCOPES)
          .optional()
          .describe("'user' (default: the user-level config) or 'project' (the config inside the current repo, e.g. ./.cursor/mcp.json)."),
      },
    },
    async ({ client, apply, scope }) =>
      guarded(async () => {
        const io = bufferIO();
        const cliDir = cliDirForInstall();
        const code = await runInstall(
          client,
          { cwd, apply: apply === true, ...(scope !== undefined ? { scope } : {}) },
          io,
          cliDir !== undefined ? { cliDir } : {},
        );
        const stderr = io.err().trim();
        return textResult({
          client,
          scope: scope ?? 'user',
          applied: apply === true,
          ok: code === 0,
          output: io.out().trimEnd(),
          ...(stderr ? { stderr } : {}),
          ...(apply === true ? {} : { next: 'Show this to the user; call again with apply: true once they confirm.' }),
        });
      }),
  );

  server.registerTool(
    'setup_lexicon',
    {
      title: 'One-shot onboarding (preview, then apply)',
      description:
        "One-shot onboarding: seed the lexicon with the user's company and name, register the MCP server and hooks in their agent clients, optionally harvest the repo and install the local API as a login service. " +
        'Ask the user for their company/product spelling, their own name, and which agent clients they use (claude, claude-desktop, codex, cursor, windsurf, gemini, vscode), then call this. ' +
        'Preview by default. Call once without apply to get the plan, show it to the user, then call again with apply: true, clients: [...] and serve: true only if the user agreed to each. ' +
        'The plan is { plan: true, lexiconPath, lexiconExists, wouldSeed, wouldInstallPacks, wouldHarvest, detectedClients, wouldInstallClients, wouldInstallServe, wouldExport } and is computed without writing anything. ' +
        'It writes the global lexicon and each named client\'s config. It does not install clients that are not listed (omitted = none; detectedClients in the plan tells you what to offer), ' +
        'does not install starter packs unless packs: [...] names them (wouldInstallPacks in the plan is the default set to offer; list_packs describes each), ' +
        'does not harvest the repo unless harvest: true (wouldHarvest in the plan is what to offer; harvest_repo previews the same names), and does not install the local API unless serve: true; offer those separately. ' +
        'Runs non-interactively and returns { ok, applied: true, summary }; tell the user what was installed and where the lexicon lives.',
      inputSchema: {
        company: z.string().optional().describe('Company or product name, spelled exactly as it should appear.'),
        person: z.string().optional().describe("The user's own name as they write it."),
        clients: z
          .array(z.enum(INSTALL_CLIENT_VALUES))
          .optional()
          .describe('Agent clients to register the server in, exactly as the user agreed. Omitted or empty = none (the plan lists the detected ones so you can ask).'),
        packs: z
          .array(z.string().regex(/^[a-z0-9-]+$/))
          .optional()
          .describe('Starter packs to install into the global lexicon (developer, ai, business, voice-tools), exactly as the user agreed. Omitted or empty = none (the plan lists the defaults in wouldInstallPacks so you can ask).'),
        harvest: z
          .boolean()
          .optional()
          .describe('true = also add the repo names in wouldHarvest to the project .lexicon.yaml (and trust it). Only after the user agreed; omitted = not harvested.'),
        serve: z.boolean().optional().describe('true = also install the local API (`lexicon serve`) as a login service. Only after the user agreed; omitted = not installed.'),
        apply: z
          .boolean()
          .optional()
          .describe('false/omitted = preview only: return the plan and write nothing (default). true = perform the setup after the user confirmed the plan.'),
      },
    },
    async ({ company, person, clients, packs, harvest, serve, apply }) =>
      guarded(async () => {
        const io = bufferIO();
        const cliDir = cliDirForInstall();
        const applied = apply === true;
        const options: SetupOptions = {
          cwd,
          yes: true,
          json: true,
          ...(company !== undefined ? { company } : {}),
          ...(person !== undefined ? { person } : {}),
          // runSetup takes the CLI's comma-separated form. Omitted means "none" here, never
          // "every detected client": the plan names the detected ones and the model asks.
          clients: clients !== undefined && clients.length > 0 ? clients.join(',') : 'none',
          // Same for the starter packs: only an explicit list installs any (runSetup with yes
          // and no --packs installs none); omitted leaves the plan's default set for the model to offer.
          ...(packs !== undefined ? { packs: packs.length > 0 ? packs.join(',') : 'none' } : {}),
          // The login service is opt-in; runSetup with yes also refuses it unless serve is true.
          serve: serve === true,
          // So is the harvest (a project write plus a trust decision). The plan lists the
          // candidates regardless, so the model can offer them; only an apply needs the flag.
          ...(applied || harvest === false ? { harvest: harvest === true } : {}),
          ...(applied ? {} : { dryRun: true }),
        };
        const { code, summary, plan } = await runSetup(options, io, cliDir !== undefined ? { cliDir } : {});
        const stderr = io.err().trim();
        if (!applied) {
          return textResult({
            ...plan,
            ...(stderr ? { stderr } : {}),
            next: 'Nothing was written. Show this plan to the user; call again with apply: true, clients: [...] for the clients they agreed to, harvest: true only if they agreed to the repo names in wouldHarvest, and serve: true only if they agreed to the login service.',
          });
        }
        return textResult({ ok: code === 0, applied: true, summary, ...(stderr ? { stderr } : {}) });
      }),
  );

  server.registerTool(
    'serve_status',
    {
      title: 'Local API status',
      description:
        'Check whether the local lexicon API (`lexicon serve`, used by the browser extension, Claude Desktop, Shortcuts and the menu bar app) is running on 127.0.0.1:41733. ' +
        'Returns { up: true, version, terms, ... } or { up: false }. Call when a non-MCP surface is not correcting text.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        try {
          const res = await fetch(SERVE_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
          if (!res.ok) return textResult({ up: false, url: SERVE_HEALTH_URL, status: res.status });
          const body: unknown = await res.json();
          return textResult({ up: true, url: SERVE_HEALTH_URL, ...(isRecord(body) ? body : { body }) });
        } catch (err) {
          return textResult({
            up: false,
            url: SERVE_HEALTH_URL,
            error: errorMessage(err),
            hint: 'Start it with `lexicon serve`, or `lexicon serve --install` to keep it running at login (setup_lexicon with serve: true does the same).',
          });
        }
      }),
  );

  // ------------------------------------------------------------ resources
};
