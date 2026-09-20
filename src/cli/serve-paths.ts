/**
 * Names and file locations of the `lexicon serve` login service, shared by
 * the installer (cmd-serve.ts) and the doctor (commands.ts). Nothing here
 * touches the filesystem, so both can import it without a cycle.
 */
import path from 'node:path';

export const LAUNCH_AGENT_LABEL = 'ai.ashlr.lexicon.serve';
export const SYSTEMD_UNIT_NAME = 'lexicon-serve.service';

/** Overrides the launchd label (tests and scratch installs on a machine where the real label is in use). */
export const SERVE_LABEL_ENV_VAR = 'LEXICON_SERVE_LABEL';

/** The launchd label: `$LEXICON_SERVE_LABEL` when set, else `ai.ashlr.lexicon.serve`. */
export function serveLabel(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SERVE_LABEL_ENV_VAR]?.trim();
  return override && /^[A-Za-z0-9._-]+$/.test(override) ? override : LAUNCH_AGENT_LABEL;
}

export function launchAgentPath(home: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home, 'Library', 'LaunchAgents', `${serveLabel(env)}.plist`);
}

export function launchAgentLogPath(home: string): string {
  return path.join(home, 'Library', 'Logs', 'lexicon', 'serve.log');
}

export function systemdUnitPath(home: string, env: NodeJS.ProcessEnv): string {
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(configHome, 'systemd', 'user', SYSTEMD_UNIT_NAME);
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
