export interface MarkdownLink {
  target: string;
  line: number;
}

export function anchorsOf(file: string): Set<string>;
export function linksIn(text: string): MarkdownLink[];
export function check(rootDir?: string): { files: number; checked: number; external: number; broken: string[] };
export function main(rootDir?: string): void;
export function targets(rootDir?: string): string[];
