/**
 * First-run setup and health: the doctor report, installing into an agent
 * client, the guided `setup_lexicon` flow, and whether `lexicon serve` is up.
 */
import { z } from 'zod';
import {
  INSTALL_CLIENT_VALUES,
  INSTALL_SCOPES,
  bufferIO,
  cliDirForInstall,
  guarded,
  textResult,
} from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import type { SetupOptions } from '../../cli/cmd-setup.js';
import { isRecord } from '../../util/json.js';
import { runDoctorReport } from '../../cli/commands.js';
import { runInstall } from '../../cli/cmd-install.js';
import { runSetup } from '../../cli/cmd-setup.js';
import { DEFAULT_PORT, FOREIGN_HEALTH_ERROR, SERVE_STATUS_HINTS, isLexiconHealth, probeHealth, readServeConfig, serveUrl } from '../../serve/config.js';

/**
 * The API this user's `lexicon serve` listens on: the port in serve.json
 * (what `lexicon serve` and `serve --status` use, and what desktop clients
 * read), else the default, plus the token so a failing server explains
 * itself. Read-only: never creates serve.json.
 */
async function serveTarget(): Promise<{ base: string; token?: string }> {
  const config = await readServeConfig();
  const port = config !== undefined && config.port > 0 ? config.port : DEFAULT_PORT;
  return { base: serveUrl(port), ...(config?.token ? { token: config.token } : {}) };
}

export const registerSetupTools: ToolRegistrar = (server, ctx) => {
  // `ctx.cwd` is read on every call: it follows the client's MCP roots once they arrive.
  const { load } = ctx;
  server.registerTool(
    'lexicon_doctor',
    {
      title: 'Is the lexicon set up, and if not what fixes it',
      description:
        'Answers "is lexicon set up for this user, and what is the one command that fixes it" in a single call. ' +
        'WHEN TO CALL: when corrections are not happening, when the user asks whether it is set up, or before you offer to set it up, ' +
        'so you know whether there is anything to offer. Safe and free to call unprompted: it only reads. ' +
        'WHAT IT CHANGES: nothing. It writes no files and installs nothing. ' +
        'READ THESE THREE FIELDS FIRST: `ready` (boolean: true means terms are configured and an integration declaration was found; ' +
        'this does not verify a live client connection or an actual correction), `summary` (one sentence, safe to relay verbatim) and `nextStep` (the single thing to do ' +
        'next, already phrased as an instruction; always present, and when nothing is broken it tells the user how to try it). ' +
        'If ready is true and the user only asked whether it works, `summary` alone is the whole answer -- do not paste the checks. ' +
        'ready being false does not always mean "not set up yet": a lexicon file that exists but does not parse also reports ready false, ' +
        'and `lexicon setup` will not repair it. Always relay `nextStep` as written instead of assuming setup is the fix; for an unreadable ' +
        'lexicon it names the file and points at `lexicon edit`. ' +
        'Also returns `ok` (no failing checks, which is weaker than `ready`: a lexicon with no terms fails nothing), ' +
        "`checks: [{ level: 'ok'|'warn'|'fail'|'info', message }]`, `paths` and `versions`. Read `checks` only when the user asks for " +
        'detail or you need to diagnose something `nextStep` does not cover; warns are usually optional extras, not problems.',
      inputSchema: {},
    },
    async () => guarded(async () => textResult(await runDoctorReport({ cwd: ctx.cwd }))),
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
          { cwd: ctx.cwd, apply: apply === true, ...(scope !== undefined ? { scope } : {}) },
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
        'The plan is { plan: true, lexiconPath, lexiconExists, wouldSeed, wouldInstallPacks, alreadyInstalledPacks?, wouldHarvest, detectedClients, wouldInstallClients, wouldInstallServe, wouldExport } and is computed without writing anything. ' +
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
          cwd: ctx.cwd,
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
        'Check whether the local lexicon API (`lexicon serve`, used by the browser extension, Claude Desktop, Shortcuts and the menu bar app) is running on 127.0.0.1 (the port in serve.json, default 41733). ' +
        'Returns { up: true, version, terms, ... }; { up: false, running: true, status, error } when it is running but failing (fix `error`); { up: false, error } when nothing answers, or when something other than lexicon serve answers on the port. Every up: false result carries `hint`, the next step. Call when a non-MCP surface is not correcting text.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const { base, token } = await serveTarget();
        const url = `${base}/health`;
        const probe = await probeHealth(base, token !== undefined ? { token } : {});
        if (probe.state === 'up' && isLexiconHealth(probe.body)) return textResult({ up: true, url, ...(isRecord(probe.body) ? probe.body : {}) });
        // A 200 that is not lexicon serve's /health: another program holds the port.
        if (probe.state === 'up') return textResult({ up: false, url, error: FOREIGN_HEALTH_ERROR, hint: SERVE_STATUS_HINTS.foreign });
        if (probe.state === 'failing') {
          return textResult({
            up: false,
            running: true,
            url,
            status: probe.status,
            error: probe.error,
            hint: SERVE_STATUS_HINTS.failing,
          });
        }
        return textResult({
          up: false,
          url,
          error: probe.error,
          hint: `${SERVE_STATUS_HINTS.down} setup_lexicon with serve: true does the same.`,
        });
      }),
  );

  // ------------------------------------------------------------ resources
};
