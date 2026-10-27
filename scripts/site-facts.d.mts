/** Types for scripts/site-facts.mjs, the site freshness generator and checker. */

export interface SiteCommands {
  script: string;
  npx: string;
  brew: string;
  npm: string;
  claudePlugin: string;
  claudePluginInstall: string;
}

export interface ReleaseInfo {
  version: string;
  date: string;
}

export interface BenchAudio {
  clips: number;
  sentencesPerVoice: number | null;
  voices: number | null;
  raw: { base: string; promptBase: string; small: string; promptSmall: string };
  lexicon: { base: string; promptBase: string; small: string; promptSmall: string };
  proseUnchanged: { hit: number; total: number };
}

export interface BenchCompare {
  raw: string | null;
  exact: string | null;
  exactCasing: string | null;
  prompt: string | null;
  lexicon: string | null;
  cleanProse: { hit: number; total: number } | null;
  inexactTiers: { terms: number; slots: number; points: string } | null;
}

export interface BenchFacts {
  synthetic: {
    cases: number;
    recallBefore: string;
    recallAfter: string;
    proseChanged: number;
    proseTotal: number;
  } | null;
  audio: BenchAudio | null;
  compare: BenchCompare | null;
  terms: number | null;
}

export interface SiteFacts {
  version: string;
  latestRelease: ReleaseInfo | null;
  packageName: string;
  serverName: string;
  commands: SiteCommands;
  mcpServerConfig: { mcpServers: Record<string, { command: string; args: string[] }> };
  mcpTools: string[];
  mcpResources: string[];
  mcpPrompts: string[];
  clients: string[];
  exportFormats: string[];
  importFormats: string[];
  cliCommands: string[];
  packs: { names: string[]; count: number; terms: number };
  bench: BenchFacts;
  counts: Record<string, number>;
  words: Record<string, string>;
}

export interface SiteProblem {
  file: string;
  line?: number;
  message: string;
}

export interface MarkerBlock {
  name: string;
  line: number;
  stale: boolean;
}

export interface MarkerResult {
  text: string;
  blocks: MarkerBlock[];
  problems: { line: number; message: string }[];
}

export function numWord(n: number): string;
export function wordToNum(raw: string): number | undefined;
export function deriveSiteFacts(root?: string): SiteFacts;
export function factsDocument(facts: SiteFacts): Record<string, unknown>;
export function factsJsonPath(root?: string): string;
export function writeFactsJson(facts: SiteFacts, root?: string): string;
export function renderSiteBlock(name: string, facts: SiteFacts): string;
export function siteBlockNames(): string[];
export function applySiteMarkers(text: string, facts: SiteFacts): MarkerResult;
export function syncSiteHtml(
  facts: SiteFacts,
  root?: string,
): { file: string; path: string; blocks: MarkerBlock[]; problems: { line: number; message: string }[] };
export function checkSite(root?: string): { facts: SiteFacts; problems: SiteProblem[] };
export function checkSiteLines(facts: SiteFacts, rel: string, text: string): SiteProblem[];
