/**
 * Client and dictation-app names the CLI prints in --help. No other imports:
 * help must not load the installers to list these.
 */

export const INSTALL_CLIENTS = [
  'claude',
  'codex',
  'cursor',
  'windsurf',
  'gemini',
  'claude-desktop',
  'vscode',
  'generic',
] as const;

export type InstallClient = (typeof INSTALL_CLIENTS)[number];

/** Clients `setup` knows how to detect and install (everything but `generic`). */
export const SETUP_CLIENTS = INSTALL_CLIENTS.filter((c): c is Exclude<InstallClient, 'generic'> => c !== 'generic');
export type SetupClient = (typeof SETUP_CLIENTS)[number];

/** Dictation apps `setup` can export for. */
export const SETUP_APPS = ['wispr', 'superwhisper', 'macos', 'none'] as const;
export type SetupApp = (typeof SETUP_APPS)[number];
