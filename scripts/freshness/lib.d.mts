export interface FreshnessTruth {
  source: string;
  latest: string | null;
  latestDate: string | null;
  releases: { version: string; date: string | null }[];
}
export interface FreshnessBlock {
  name: string;
  line: number;
  stale: boolean;
}
export interface FreshnessProblem {
  file?: string;
  line: number;
  message: string;
}
export interface FreshnessFile {
  file: string;
  path: string;
  text: string;
  blocks: FreshnessBlock[];
}
export const repoRoot: string;
export function loadTruth(root?: string): FreshnessTruth;
export function blockNames(): string[];
export function renderBlock(name: string, truth: FreshnessTruth): { text: string; inline: boolean };
export function applyMarkers(
  text: string,
  truth: FreshnessTruth,
): { text: string; blocks: FreshnessBlock[]; problems: FreshnessProblem[] };
export function markedFiles(root?: string): string[];
export function planFreshness(root?: string): {
  truth: FreshnessTruth;
  files: FreshnessFile[];
  problems: FreshnessProblem[];
};
export function parseArgs(
  argv: string[],
  extraFlags?: string[],
): { root: string; flags: Set<string>; help?: boolean };
