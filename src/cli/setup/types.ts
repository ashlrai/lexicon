/**
 * The vocabulary of `lexicon setup`: its options, the per-step result shapes,
 * the injected collaborators, and the `Ctx` bag the steps thread through.
 * Split out so ./detect.ts and ./steps.ts can share them without importing
 * the command module that uses them.
 */
import { INSTALL_CLIENTS } from '../cmd-install.js';
import type { InstallClient, InstallOptions } from '../cmd-install.js';
import type { ServeDeps, ServeOptions } from '../cmd-serve.js';
import type { Prompter } from '../prompt.js';
import type { CommonOptions, IO } from '../io.js';
import type { InstallOutcome } from '../commands.js';
import type {
  HarvestCandidate,
  HarvestOptions,
  InstallPackResult,
  PackInfo,
  StoreOptions,
  TermScope,
} from '../../core/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Clients `setup` knows how to detect and install (everything but `generic`). */
export const SETUP_CLIENTS = INSTALL_CLIENTS.filter((c): c is Exclude<InstallClient, 'generic'> => c !== 'generic');
export type SetupClient = (typeof SETUP_CLIENTS)[number];

/** Dictation apps `setup` can export for, with the export format behind each. */
export const SETUP_APPS = ['wispr', 'superwhisper', 'macos', 'none'] as const;
export type SetupApp = (typeof SETUP_APPS)[number];

export const HARVEST_LIMIT = 10;
export const HARVEST_MIN_COUNT = 5;
/** A lexicon with at least this many terms is considered seeded already. */
export const SEEDED_TERMS = 3;

export interface SetupOptions extends CommonOptions {
  /** Take every default without prompting. */
  yes?: boolean;
  /** Print the SetupSummary as JSON on stdout (progress goes to stderr). */
  json?: boolean;
  /** Seed person/company even when the lexicon already has terms. */
  reseed?: boolean;
  /** Comma-separated client names, or `none`. Skips detection and the checklist. */
  clients?: string;
  /** Company or product name to seed (non-interactive default for the prompt). */
  company?: string;
  /** Person name to seed (default: `git config --global user.name`). */
  person?: string;
  /** Pronunciation hint for the company term. */
  phonetic?: string;
  /**
   * `--harvest` / `--no-harvest`: add the repo's top names to the project
   * lexicon. With a prompter, undefined shows the candidates and asks
   * (default yes); without one (`--yes`, no TTY, MCP) undefined skips the
   * write: a harvest is a write plus a trust decision and is never done
   * silently. A dry run lists the candidates in the plan either way.
   */
  harvest?: boolean;
  /**
   * `--serve` / `--no-serve`: install the local API login service. With a
   * prompter, undefined asks (default yes); without one (`--yes`, no TTY,
   * MCP) undefined skips it: a login service is never created silently.
   */
  serve?: boolean;
  /**
   * `--packs <list>` / `--no-packs`: starter packs to install into the global
   * lexicon (`lexicon pack add`). A comma-separated list (or `none`) installs
   * exactly those; `false` skips the step without a prompt; undefined shows the
   * checklist on a terminal (developer, ai, voice-tools checked) and installs
   * nothing without one (`--yes`, no TTY, MCP): a pack is a hundred-odd terms
   * and is never added silently. A dry run lists the defaults in
   * `wouldInstallPacks` unless `packs === false`.
   */
  packs?: string | false;
  /** Run detection and suggestions only; write nothing and fill in `SetupPlan`. */
  dryRun?: boolean;
  /** Dictation app to export for: wispr|superwhisper|macos|none. */
  app?: string;
  /** Directory for the dictation export (default ~/Desktop, else the config dir). */
  exportDir?: string;
  /** Treat <dir> as the home directory (forwarded to the installers). */
  home?: string;
}

export interface SetupClientResult {
  name: string;
  status: 'installed' | 'skipped' | 'failed';
  /**
   * For `installed`: the config file(s) the installer wrote, comma separated,
   * `(unchanged)` after one that already had the entry. For `failed`: the
   * installer's last error line.
   */
  detail?: string;
}

export interface SetupPackResult {
  name: string;
  /** Terms created by the pack. */
  added: number;
  /** Terms that already existed and only gained aliases. */
  merged: number;
}

export interface SetupSummary {
  lexiconPath: string;
  /** Seeded and harvested terms created by this run (pack terms are counted in `packs`). */
  termsAdded: string[];
  /** Starter packs installed by this run (a pack that was already installed is not listed). */
  packs: SetupPackResult[];
  clients: SetupClientResult[];
  serve: 'installed' | 'skipped' | 'failed';
  exports: { format: string; path: string }[];
}

/** What `runSetup` would do, computed by a dry run that writes nothing. */
export interface SetupPlan {
  plan: true;
  lexiconPath: string;
  /** False when the global lexicon would be created. */
  lexiconExists: boolean;
  /** Canonicals that would be seeded into the global lexicon (person, company). */
  wouldSeed: string[];
  /**
   * Starter packs that would be installed: the `--packs` list, else the
   * defaults (developer, ai, voice-tools) a terminal would show checked, so a
   * caller can offer them; empty under `--no-packs`. A non-interactive apply
   * installs only an explicit `--packs` list.
   */
  wouldInstallPacks: string[];
  /** Repo names that would be added to the project lexicon (names the packs cover are left out). */
  wouldHarvest: string[];
  /** Every client found on this machine, whether or not it would be installed. */
  detectedClients: string[];
  /** Clients that would get the MCP server (and hooks) written. */
  wouldInstallClients: string[];
  wouldInstallServe: boolean;
  wouldExport: { format: string; path: string }[];
}

/** Runs a command and returns trimmed stdout; throws when it fails. */
export type SetupExec = (file: string, args: readonly string[]) => string;

export interface SetupDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Home directory used for detection and forwarded to the installers. Default os.homedir(). */
  home?: string;
  /** Filesystem probe for detection. Default existsSync. */
  exists?: (p: string) => boolean;
  /** Runs `git config` / `git remote`. Default execFileSync with a short timeout. */
  exec?: SetupExec;
  /** Directory containing the built CLI (dist/cli), forwarded to the installers. */
  cliDir?: string;
  isInteractive?: () => boolean;
  createPrompter?: () => Prompter;
  /**
   * Installs one client with `--apply`. Default runInstall. `onWritten` is
   * called for every config file the installer touched; the summary's
   * `detail` is built from it (falling back to the installer's last line).
   */
  installClient?: (client: SetupClient, opts: InstallOptions, io: IO, onWritten: (file: string, outcome: InstallOutcome) => void) => Promise<number>;
  /**
   * Installs the local API login service. Default runServeInstall, called
   * with `deps`: platform, env, home (when overridden) and `cliPath`
   * (`<cliDir>/index.js` when `cliDir` is set; the installer resolves it
   * otherwise and refuses a path that does not exist).
   */
  installServe?: (opts: ServeOptions, io: IO, deps: ServeDeps) => Promise<number>;
  /** Repo scanner. Default harvestRepo. */
  harvest?: (root: string, opts: HarvestOptions) => Promise<HarvestCandidate[]>;
  /** The starter packs on offer. Default listPacks (the package's packs/). */
  listPacks?: () => Promise<PackInfo[]>;
  /** Installs one pack. Default installPack. */
  installPack?: (name: string, opts: StoreOptions & { scope: TermScope }) => Promise<InstallPackResult>;
}

export interface DetectedClient {
  name: SetupClient;
  detected: boolean;
  /** What was found (a directory, an app bundle or a binary), for the checklist. */
  evidence?: string;
}

/**
 * The mutable state the wizard threads through its steps: the resolved
 * environment, the output sinks, and the running record of what has been done
 * (`summary`) or would be done (`plan`, under --dry-run).
 */
export interface Ctx {
  opts: SetupOptions;
  deps: SetupDeps;
  /** Progress output: stdout normally, stderr under --json. */
  say: (s?: string) => void;
  warn: (s: string) => void;
  io: IO;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  exec: SetupExec;
  /** Undefined when running with defaults (--yes or no terminal). */
  prompter?: Prompter;
  /** True when --home or deps.home overrides os.homedir(); forwarded to the installers. */
  homeOverridden: boolean;
  /** The company term seeded in step 1, for the summary card. */
  company?: string;
  /** Canonicals seeded (or found already present) in step 1; the harvest skips these. */
  seeded: string[];
  /** Canonicals the packs of a dry run would add; the planned harvest leaves them out. */
  packCanonicals: string[];
  summary: SetupSummary;
  /** Present under `dryRun`: every step records what it would do here instead of doing it. */
  plan?: SetupPlan;
}
