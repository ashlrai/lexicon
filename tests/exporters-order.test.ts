/**
 * Export order is the same on every machine: the exporters sort with a fixed
 * collation, not the user's locale. A child process under a Swedish locale
 * (where `Ä` sorts after `Z`) must write what this process writes.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPORT_FORMATS, exportLexicon } from '../src/core/exporters/index.js';
import type { Lexicon } from '../src/core/types.js';

const lexicon: Lexicon = {
  version: 1,
  terms: [
    { canonical: 'Zeta', aliases: ['zetta'], category: 'brand' },
    { canonical: 'Äpple', aliases: ['epple'], category: 'brand' },
    { canonical: 'Örebro', aliases: ['orebro'], category: 'place' },
    { canonical: 'Café', aliases: ['kaffay'], category: 'brand' },
    { canonical: 'Café', aliases: ['kafay'], category: 'brand' },
    { canonical: 'apple', aliases: ['appel'], category: 'brand' },
    { canonical: 'Apple', aliases: ['appul'], category: 'brand' },
  ],
};

function exportIn(locale: string, input: Lexicon): Record<string, string> {
  const mod = pathToFileURL(resolve(process.cwd(), 'src/core/exporters/index.ts')).href;
  const script = `const m = await import(${JSON.stringify(mod)}); const lex = JSON.parse(process.env.LEX); const out = {}; for (const f of m.EXPORT_FORMATS) out[f] = m.exportLexicon(lex, f); out.limit = m.exportLexicon(lex, 'csv', { limit: 2 }); process.stdout.write(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, LEX: JSON.stringify(input), LC_ALL: locale, LANG: locale },
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Record<string, string>;
}

describe('export order', () => {
  // Catches: sortByImportance, sortByCategory and the text exporter used
  // localeCompare without a locale, so under LANG=sv_SE.UTF-8 the same
  // lexicon exported in another order and --limit kept other terms.
  it('does not depend on the locale', () => {
    const here: Record<string, string> = {};
    for (const f of EXPORT_FORMATS) here[f] = exportLexicon(lexicon, f);
    here.limit = exportLexicon(lexicon, 'csv', { limit: 2 });
    expect(here.text.split('\n').slice(0, 2)).toEqual(['apple: appel', 'Apple: appul']);
    expect(here.text.indexOf('Äpple')).toBeLessThan(here.text.indexOf('Zeta'));
    expect(exportIn('sv_SE.UTF-8', lexicon)).toEqual(here);
  });

  // Spellings the collation calls equal (one canonical in two Unicode forms)
  // still come out in one order whatever order the file lists them in.
  it('orders spellings the collation calls equal by their code units', () => {
    const reversed: Lexicon = { ...lexicon, terms: [...lexicon.terms].reverse() };
    for (const f of ['text', 'claude-md', 'markdown', 'whisper-prompt', 'deepgram', 'google'] as const) {
      expect(exportLexicon(reversed, f), f).toBe(exportLexicon(lexicon, f));
    }
  });
});
