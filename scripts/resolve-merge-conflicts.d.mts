export const UNION: 'union';
export const OURS_PLUS: 'ours+theirs-hunks';
export const REGENERATE: 'regenerate';
export function classify(rel: string): 'union' | 'ours+theirs-hunks' | 'regenerate' | null;
export function lockfileUrls(base: string, text: string): string[];
export function validateLockfile(base: string, text: string): { ok: boolean; bad: string[] };
