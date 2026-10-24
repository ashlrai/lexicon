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
  untrustedWriteFields,
} from '../shared.js';
import type { ToolRegistrar } from '../shared.js';
import type { SetupOptions } from '../../cli/cmd-setup.js';
import { LIMITS } from '../../core/index.js';
import { isRecord } from '../../util/json.js';
import { errorMessage } from '../../util/errors.js';
import { runDoctorReport } from '../../cli/commands.js';
import { reloadStepFor, runInstall } from '../../cli/cmd-install.js';
import type { InstallOutcome } from '../../cli/cmd-install.js';
import { runSetup } from '../../cli/cmd-setup.js';
import { runUninstall } from '../../cli/cmd-uninstall.js';
import { setupNameProblem } from '../../cli/setup/detect.js';
import { serveInstallBlocker } from '../../cli/cmd-serve.js';
import { cliCommand } from '../../util/cli-hint.js';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  FOREIGN_HEALTH_ERROR,
  SERVE_STATUS_HINTS,
  getServePath,
  isLexiconHealth,
  probeHealth,
  readServeConfig,
  serveUrl,
  unusableServeConfigReason,
} from '../../serve/config.js';

/**
 * The API this user's `lexicon serve` listens on: the port in serve.json
 * (what `lexicon serve` and `serve --status` use, and what desktop clients
 * read), else the default, plus the token so a failing server explains
 * itself. Read-only: never creates serve.json.
 */
async function serveTarget(): Promise<{ base: string; token?: string; notConfigured: { configured?: false; configPath?: string; note?: string } }> {
  const config = await readServeConfig();
  const port = config !== undefined && config.port > 0 ? config.port : DEFAULT_PORT;
  // As `lexicon serve --status --json` says it: without this a serve.json
  // that is not valid JSON (which lexicon serve refuses to start on) or has
  // no usable token read the same as a server that is simply not started.
  const configPath = getServePath();
  const notConfigured =
    config === undefined ? { configured: false as const, configPath, note: `serve is not configured: ${configPath} ${unusableServeConfigReason(configPath)}` } : {};
  return { base: serveUrl(port), ...(config?.token ? { token: config.token } : {}), notConfigured };
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
        'and setup_lexicon will not repair it. Always relay `nextStep` as written instead of assuming setup is the fix; for an unreadable ' +
        'lexicon it names the file and the command that opens it. ' +
        'Also returns `ok` (no failing checks, which is weaker than `ready`: a lexicon with no terms fails nothing), `error` (only when ok is false: the first failing check), ' +
        "`checks: [{ level: 'ok'|'warn'|'fail'|'info', message }]`, `paths` and `versions`. Read `checks` only when the user asks for " +
        'detail or you need to diagnose something `nextStep` does not cover; warns are usually optional extras, not problems.',
      inputSchema: {},
    },
    async () => guarded(async () => textResult(await runDoctorReport({ cwd: ctx.cwd, audience: 'mcp' }))),
  );

  server.registerTool(
    'install_client',
    {
      title: 'Register the lexicon MCP server in an agent client',
      description:
        "Register the lexicon MCP server (and, for Claude Code, its hooks) in an agent client's config: claude, codex, cursor, windsurf, gemini, vscode or claude-desktop. " +
        'Call with apply omitted (or false) first: that is a preview that returns the exact file and entry that would change and writes nothing. ' +
        'Show the preview to the user and call again with apply: true only after they confirm. Idempotent: an entry that is already present is left alone. ' +
        'Returns { client, scope, applied, ok, written, output, reload?, stderr?, next?, nextStep? }: `reload` is what the user must do so the client loads the server (restart it, or reload its window), to relay after an apply; `written` lists each config file the call touched as { file, outcome } with outcome created, updated or unchanged (empty for a preview), the same list the CLI install command prints with --json, so read it instead of parsing `output`. ' +
          'Check `ok`: false means the preview or install did not complete (`output` and `stderr` say which step failed, and `nextStep` what to do), so do not report it as installed or call again with apply: true. ' +
        "windsurf and claude-desktop have no project-level config: scope 'project' with them is an error that says to call again without scope.",
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
        // The same `written` list `lexicon install --json` returns, so an agent
        // reads which files changed without parsing `output`.
        const written: { file: string; outcome: InstallOutcome }[] = [];
        const onWritten = (file: string, outcome: InstallOutcome): void => {
          written.push({ file, outcome });
        };
        let code: number;
        try {
          code = await runInstall(
            client,
            { cwd: ctx.cwd, apply: apply === true, ...(scope !== undefined ? { scope } : {}) },
            io,
            { ...(cliDir !== undefined ? { cliDir } : {}), onWritten },
          );
        } catch (err) {
          // The CLI's message says `drop --project`, a flag this tool does not take.
          if (scope === 'project' && /has no project-level MCP config/.test(errorMessage(err))) {
            throw new Error(`${client} has no project-level MCP config, so nothing was written; call install_client again without scope to use its user-level config.`);
          }
          throw err;
        }
        const stderr = io.err().trim();
        const ok = code === 0;
        return textResult({
          client,
          scope: scope ?? 'user',
          applied: apply === true,
          ok,
          written,
          output: io.out().trimEnd(),
          ...(stderr ? { stderr } : {}),
          // A failed preview is not one to confirm: `next` said to apply it anyway.
          // What the user does so the client loads the server (also the output's `then:` line).
          ...(ok ? { reload: reloadStepFor(client) } : {}),
          ...(!ok
            ? { nextStep: `The ${apply === true ? 'install' : 'preview'} did not complete; output and stderr say which step failed. Tell the user what failed and do not call again with apply: true until it is fixed.` }
            : apply === true
              ? {}
              : { next: 'Show this to the user; call again with apply: true once they confirm.' }),
        });
      }),
  );

  server.registerTool(
    'uninstall_client',
    {
      title: 'Remove the lexicon MCP server from an agent client',
      description:
        "Take back out what install_client (or the CLI install command) wrote for a client: claude, codex, cursor, windsurf, gemini, vscode or claude-desktop. " +
        'Only entries an install writes are removed: a lexicon server launched the way an install launches it and, for claude, the lexicon hook commands. ' +
        'A server of the user\'s own named lexicon is reported as kept and left alone, and every other entry in the file is untouched. ' +
        'SAFETY DEFAULT: apply omitted (or false) is a dry run that writes nothing and returns what would be removed; this tool never removes anything unless apply is true. ' +
        'Show the dry run to the user and call again with apply: true only after they confirm. ' +
        "Returns { client, scope, applied, ok, changes, output, stderr?, next?, nextStep? }: `changes` lists each entry as { file, entry, outcome } with outcome removed (would be removed, in a dry run), absent or kept, the list the CLI uninstall command prints with --json. " +
        'Check `ok`: false means it did not complete (`error` and `nextStep` say why), so do not report it as removed. ' +
        "windsurf and claude-desktop have no project-level config: scope 'project' with them is an error that says to call again without scope. " +
        'The Claude Code plugin is not removed by this tool; when it is installed, `output` names the command that removes it.',
      inputSchema: {
        client: z.enum(INSTALL_CLIENT_VALUES).describe('Which client to remove lexicon from.'),
        apply: z.boolean().optional().describe('false/omitted = dry run only (default): report what would be removed and write nothing. true = remove it after the user confirmed.'),
        scope: z
          .enum(INSTALL_SCOPES)
          .optional()
          .describe("'user' (default: the user-level config) or 'project' (the config inside the current repo), as for install_client."),
      },
    },
    async ({ client, apply, scope }) =>
      guarded(async () => {
        const io = bufferIO();
        const applied = apply === true;
        const code = await runUninstall(
          client,
          { cwd: ctx.cwd, dryRun: !applied, json: true, ...(scope !== undefined ? { scope } : {}) },
          io,
        );
        let doc: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(io.out());
          doc = isRecord(parsed) ? parsed : {};
        } catch {
          doc = {};
        }
        const stderr = io.err().trim();
        const output = typeof doc.output === 'string' ? doc.output : '';
        const changes = Array.isArray(doc.changes) ? doc.changes : [];
        if (doc.ok !== true && !Array.isArray(doc.changes)) {
          // A refusal before anything was touched: unknown client, bad scope, a file it cannot read.
          const error = typeof doc.error === 'string' ? doc.error : `uninstall ${client} did not complete${stderr ? `: ${stderr}` : ''}`;
          // The CLI's hints name `--project` and the CLI command; this tool takes `scope` and `apply`.
          throw new Error(
            /has no project-level MCP config/.test(error)
              ? `${client} has no project-level MCP config, so nothing was changed; call uninstall_client again without scope to use its user-level config.`
              : `${error}; nothing was changed. Fix that (the message names the file), then call uninstall_client again.`,
          );
        }
        if (code !== 0 || doc.ok !== true) {
          // A step failed part way (claude mcp get or remove): `changes` says what did happen.
          return textResult({
            client,
            scope: scope ?? 'user',
            applied,
            ok: false,
            changes,
            output,
            ...(stderr ? { stderr } : {}),
            nextStep: `The ${applied ? 'uninstall' : 'dry run'} did not complete; output says which step failed and changes what was ${applied ? 'removed' : 'found'}. Tell the user what failed and do not call again with apply: true until it is fixed.`,
          });
        }
        const wouldRemove = changes.some((c) => isRecord(c) && c.outcome === 'removed');
        return textResult({
          client,
          scope: scope ?? 'user',
          applied,
          ok: true,
          changes,
          output,
          ...(stderr ? { stderr } : {}),
          ...(applied
            ? wouldRemove
              ? { next: `Tell the user to restart or reload ${client === 'claude' ? 'Claude Code' : 'the client'} so a running session stops starting lexicon; install_client puts it back.` }
              : {}
            : wouldRemove
              ? { next: 'Nothing was written. Show this to the user; call again with apply: true once they confirm.' }
              : { next: 'Nothing was written, and there is nothing of lexicon\'s to remove for this client and scope.' }),
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
        'The plan is { plan: true, lexiconPath, lexiconExists, wouldSeed, wouldInstallPacks, packsOnOffer, packsToInstall, alreadyInstalledPacks?, wouldHarvest, detectedClients, wouldInstallClients, wouldInstallServe, serveBlocked?, wouldExport, demo?, interactive, wouldAsk, next } and is computed without writing anything; demo { heard, corrected, terms, usedExample } is the before and after a real run would end on, worth showing; interactive is false and wouldAsk empty here, since this tool never prompts; serveBlocked (with serve: true) says why the login service would be refused and how to fix it, so relay it instead of offering the service. ' +
        'It writes the global lexicon and each named client\'s config. It does not install clients that are not listed (omitted = none; detectedClients in the plan tells you what to offer), ' +
        'does not install starter packs unless packs: [...] names them (packsOnOffer, the same list as wouldInstallPacks, is the default set to offer, not what will be installed; packsToInstall is what this call would install, empty until packs names some; list_packs describes each), ' +
        'does not harvest the repo unless harvest: true (wouldHarvest in the plan is what to offer; harvest_repo previews the same names), and does not install the local API unless serve: true; offer those separately. ' +
        'Runs non-interactively and returns { ok, applied: true, summary, nextStep? }; tell the user what was installed and where the lexicon lives, and relay nextStep (a harvested project file that was not trusted already is left untrusted for the user to review).',
      inputSchema: {
        company: z
          .string()
          .optional()
          .describe(`Company or product name, spelled exactly as it should appear: one name of at most ${LIMITS.word} characters once trimmed, on one line (the lexicon's cap for a term). A longer, blank or multi-line one is refused, in the preview too, and nothing is written.`),
        person: z
          .string()
          .optional()
          .describe(`The user's own name as they write it: at most ${LIMITS.word} characters once trimmed, on one line. A longer, blank or multi-line one is refused, in the preview too, and nothing is written.`),
        clients: z
          .array(z.enum(INSTALL_CLIENT_VALUES))
          .optional()
          .describe('Agent clients to register the server in, exactly as the user agreed. Omitted or empty = none (the plan lists the detected ones so you can ask).'),
        packs: z
          .array(z.string().regex(/^[a-z0-9-]+$/))
          .optional()
          .describe('Starter packs to install into the global lexicon (developer, ai, business, voice-tools), exactly as the user agreed. Omitted or empty = none (the plan lists the defaults in packsOnOffer so you can ask).'),
        harvest: z
          .boolean()
          .optional()
          .describe('true = also add the repo names in wouldHarvest to the project .lexicon.yaml; a file the user already trusted stays trusted, any other is left untrusted until the user trusts it (relay `nextStep`). Only after the user agreed; omitted = not harvested.'),
        serve: z.boolean().optional().describe('true = also install the local API (`lexicon serve`) as a login service. Only after the user agreed; omitted = not installed.'),
        apply: z
          .boolean()
          .optional()
          .describe('false/omitted = preview only: return the plan and write nothing (default). true = perform the setup after the user confirmed the plan.'),
      },
    },
    async ({ company, person, clients, packs, harvest, serve, apply }) =>
      guarded(async () => {
        // The plan seeded a 100-character company without a word, then the
        // apply refused it with errors about generated aliases the agent never
        // passed. Check both names against the term caps up front, for both.
        for (const [field, value] of [['company', company], ['person', person]] as const) {
          const problem = value === undefined ? undefined : setupNameProblem(value);
          if (problem !== undefined) {
            throw new Error(`${field} ${problem}; nothing was written. Pass only the name, spelled as the user writes it, or omit ${field}.`);
          }
        }
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
          // Duplicates are dropped here, in the order first named, so the
          // options (and the command the plan echoes) list each client once.
          clients: clients !== undefined && clients.length > 0 ? [...new Set(clients)].join(',') : 'none',
          // Same for the starter packs: only an explicit list installs any (runSetup with yes
          // and no --packs installs none); omitted leaves the plan's default set for the model to offer.
          ...(packs !== undefined ? { packs: packs.length > 0 ? [...new Set(packs)].join(',') : 'none' } : {}),
          // The login service is opt-in; runSetup with yes also refuses it unless serve is true.
          serve: serve === true,
          // So is the harvest (a write inside the user's repo). The plan lists the
          // candidates regardless, so the model can offer them; only an apply needs the flag.
          ...(applied || harvest === false ? { harvest: harvest === true } : {}),
          // ...and a file it writes that the user has not trusted yet is left
          // for them to trust: the model relaying a yes is not the user
          // reviewing the names. An already-trusted file stays trusted.
          harvestUntrusted: true,
          // No progress text naming CLI flags (--packs, --harvest): the plan and the summary
          // carry the facts, and summary.nextStep names add_term.
          forAgent: true,
          ...(applied ? {} : { dryRun: true }),
        };
        const { code, summary, plan } = await runSetup(options, io, cliDir !== undefined ? { cliDir } : {});
        const stderr = io.err().trim();
        if (!applied) {
          return textResult({
            ...plan,
            ...(stderr ? { stderr } : {}),
            next: (plan?.serveBlocked !== undefined ? 'The login service cannot be installed from this copy (serveBlocked says why and how to fix it); do not offer serve: true until that is fixed. ' : '') + 'Nothing was written. Show this plan to the user; call again with apply: true, clients: [...] for the clients they agreed to, harvest: true only if they agreed to the repo names in wouldHarvest, and serve: true only if they agreed to the login service.',
          });
        }
        const untrusted = summary.untrustedProject;
        // The trust step first (the harvested names wait on it), then the one the summary names.
        const steps = [
          ...(untrusted !== undefined ? [untrustedWriteFields(untrusted, 'The repo names', true).nextStep] : []),
          ...(summary.nextStep !== undefined ? [summary.nextStep] : []),
        ];
        return textResult({
          ok: code === 0,
          applied: true,
          summary,
          ...(stderr ? { stderr } : {}),
          ...(steps.length > 0 ? { nextStep: steps.join(' Then: ') } : {}),
        });
      }),
  );

  server.registerTool(
    'serve_status',
    {
      title: 'Local API status',
      description:
        'Check whether the local lexicon API (the CLI serve command, used by the browser extension, Claude Desktop, Shortcuts and the menu bar app) is running on 127.0.0.1 (the port in serve.json, default 41733). ' +
        'Returns { up: true, version, terms, ... }; { up: false, running: true, status, error } when it is running but failing (fix `error`); { up: false, error } when nothing answers, or when something other than lexicon serve answers on the port. Every result carries `url`, the /health address probed, and every up: false result carries `hint`, the next step. When serve.json is missing or unusable (not valid JSON, no usable token, unreadable) the result adds `configured: false`, `configPath` and `note` saying why and what fixes it, as the CLI serve --status --json does. Call when a non-MCP surface is not correcting text.',
      inputSchema: {},
    },
    async () =>
      guarded(async () => {
        const { base, token, notConfigured } = await serveTarget();
        const url = `${base}/health`;
        const probe = await probeHealth(base, token !== undefined ? { token } : {});
        if (probe.state === 'up' && isLexiconHealth(probe.body)) return textResult({ up: true, url, ...(isRecord(probe.body) ? probe.body : {}), ...notConfigured });
        // A 200 that is not lexicon serve's /health: another program holds the port.
        if (probe.state === 'up') return textResult({ up: false, url, error: FOREIGN_HEALTH_ERROR, hint: SERVE_STATUS_HINTS.foreign, ...notConfigured });
        if (probe.state === 'failing') {
          return textResult({
            up: false,
            running: true,
            url,
            status: probe.status,
            error: probe.error,
            hint: SERVE_STATUS_HINTS.failing,
            ...notConfigured,
          });
        }
        // The CLI's hint names `lexicon serve`, which a plugin-only user does not
        // have, and setup_lexicon refuses the login service from a plugin or npx copy.
        const cliDir = cliDirForInstall();
        const blocked = await serveInstallBlocker(cliDir !== undefined ? { cliPath: join(cliDir, 'index.js') } : {});
        return textResult({
          up: false,
          url,
          error: probe.error,
          hint: blocked
            ? `Start it with ${cliCommand('serve')}. A login service that keeps it running cannot be installed from this copy: ${blocked}.`
            : `${SERVE_STATUS_HINTS.down} setup_lexicon with serve: true does the same.`,
          ...notConfigured,
        });
      }),
  );

  // ------------------------------------------------------------ resources
};
