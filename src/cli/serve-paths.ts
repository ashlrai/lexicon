/**
 * Names and file locations of the `lexicon serve` login service, shared by
 * the installer (cmd-serve.ts) and the doctor (commands.ts). Nothing here
 * touches the filesystem, so both can import it without a cycle.
 */
import path from 'node:path';
import { xdgConfigHome } from '../util/xdg.js';

export const LAUNCH_AGENT_LABEL = 'ai.ashlr.lexicon.serve';
export const SYSTEMD_UNIT_NAME = 'lexicon-serve.service';
/** Task Scheduler task name on Windows (`schtasks /TN`). */
export const SCHEDULED_TASK_NAME = 'Lexicon';

/** Overrides the launchd label (tests and scratch installs on a machine where the real label is in use). */
export const SERVE_LABEL_ENV_VAR = 'LEXICON_SERVE_LABEL';

/** The launchd label: `$LEXICON_SERVE_LABEL` when set, else `ai.ashlr.lexicon.serve`. */
export function serveLabel(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SERVE_LABEL_ENV_VAR]?.trim();
  return override && /^[A-Za-z0-9._-]+$/.test(override) ? override : LAUNCH_AGENT_LABEL;
}

/**
 * The Scheduled Task name: `$LEXICON_SERVE_LABEL` when set, else `Lexicon`.
 * Shares the override with launchd so one env var renames a scratch install on
 * every platform. A leading `\` would make schtasks read it as a folder path,
 * and the label pattern already excludes one.
 */
export function scheduledTaskName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SERVE_LABEL_ENV_VAR]?.trim();
  return override && /^[A-Za-z0-9._-]+$/.test(override) ? override : SCHEDULED_TASK_NAME;
}

export function launchAgentPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home, 'Library', 'LaunchAgents', `${serveLabel(env)}.plist`);
}

export function launchAgentLogPath(home: string): string {
  return path.join(home, 'Library', 'Logs', 'lexicon', 'serve.log');
}

export function systemdUnitPath(home: string, env: NodeJS.ProcessEnv): string {
  return path.join(xdgConfigHome(env, home), 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

/**
 * The program path a launchd plist runs: the second `<string>` of its
 * `ProgramArguments` array (the first is the node binary). Undefined when
 * the plist has no such array. Written by `launchAgentPlist`, so the shape is
 * known; entities are decoded for the four `xmlEscape` produces.
 */
export function programPathFromPlist(plist: string): string | undefined {
  const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!block) return undefined;
  const strings = [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => xmlUnescape(m[1]));
  return strings[1];
}

/**
 * The program path a Scheduled Task runs, as `schtasks /Query /XML` prints it.
 *
 * This is the *CLI entry*, not the node binary: `<Command>` is node and
 * `<Arguments>` is `"<cli>" serve`, exactly as the plist's ProgramArguments
 * and the unit's ExecStart put node first and the entry second. The doctor
 * compares this against the filesystem to catch a service left pointing at an
 * uninstalled copy, so all three platforms have to mean the same thing by it.
 */
export function programPathFromTaskXml(xml: string): string | undefined {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(xml);
  if (!args) return undefined;
  const quoted = /"([^"]*)"/.exec(xmlUnescape(args[1]));
  return quoted ? quoted[1] : undefined;
}

/** The program path a systemd unit runs: the second quoted word of `ExecStart=`. */
export function programPathFromUnit(unit: string): string | undefined {
  const line = unit.split('\n').find((l) => l.startsWith('ExecStart='));
  if (!line) return undefined;
  const words = [...line.slice('ExecStart='.length).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return words[1];
}

function xmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
