import { describe, expect, it } from 'vitest';
import { importLexicon, detectImportFormat } from '../src/core/importers/index.js';
import { xmlUnescape } from '../src/core/importers/macos.js';
import { exportText } from '../src/core/exporters/text.js';
import type { Lexicon } from '../src/core/types.js';

const plist = (phrase: string, shortcut: string): string =>
  `<?xml version="1.0"?>\n<plist><array>\n<dict><key>phrase</key><string>${phrase}</string><key>shortcut</key><string>${shortcut}</string></dict>\n` +
  '<dict><key>phrase</key><string>Kubernetes</string><key>shortcut</key><string>cooper netties</string></dict>\n</array></plist>\n';

describe('macos importer: character references', () => {
  it('leaves an out-of-range numeric reference as text instead of throwing a RangeError', () => {
    expect(xmlUnescape('A&#99999999;B')).toBe('A&#99999999;B');
    expect(xmlUnescape('A&#x110000;B')).toBe('A&#x110000;B');
    expect(xmlUnescape('A&#xD800;B')).toBe('A&#xD800;B');
    expect(xmlUnescape('A&#0;B')).toBe('A&#0;B');
    expect(xmlUnescape('&#65;&#x42;&amp;')).toBe('AB&');
  });

  it('imports the rest of the file when one entry has a bad reference', () => {
    const r = importLexicon(plist('Ashlr.AI', 'ash&#99999999;ler'), 'auto');
    expect(r.format).toBe('macos');
    expect(r.terms.map((t) => t.canonical)).toEqual(['Ashlr.AI', 'Kubernetes']);
  });
});

describe('csv importers: unterminated quote', () => {
  it('refuses a wispr file whose quote never closes instead of folding the rest of the file into one term', () => {
    const content = 'word,replacement\nashler,"Ashlr.AI\ncooper netties,Kubernetes\nsuper base,Supabase\n';
    expect(() => importLexicon(content, 'wispr')).toThrow(/line 2.*never closes/);
    expect(() => importLexicon(content, 'auto')).toThrow(/line 2.*never closes/);
  });

  it('refuses the generic csv the same way', () => {
    const content = 'canonical,alias\nAshlr.AI,"ashler\nKubernetes,cooper netties\n';
    expect(() => importLexicon(content, 'csv')).toThrow(/line 2.*never closes/);
  });

  it('still reads a quoted field that spans lines and closes', () => {
    const r = importLexicon('word,replacement\n"ashler, inc",Ashlr.AI\ncooper,Kubernetes\n', 'wispr');
    expect(r.terms.map((t) => [t.canonical, t.aliases])).toEqual([
      ['Ashlr.AI', ['ashler, inc']],
      ['Kubernetes', ['cooper']],
    ]);
  });

  it('auto-detects a plain text file that opens with a stray quote', () => {
    expect(detectImportFormat('"Ashlr.AI: ashler\nKubernetes\n', 'names.txt')).toBe('text');
  });
});

describe('text export and import round trip', () => {
  it('keeps a canonical with a colon and no aliases whole', () => {
    const lexicon: Lexicon = {
      version: 1,
      terms: [
        { canonical: 'Re:Invent', aliases: [] },
        { canonical: 'Ashlr.AI', aliases: ['ashler'] },
        { canonical: 'Kubernetes', aliases: [] },
      ],
    };
    const r = importLexicon(exportText(lexicon), 'text');
    expect(r.terms.map((t) => [t.canonical, t.aliases])).toEqual([
      ['Ashlr.AI', ['ashler']],
      ['Kubernetes', []],
      ['Re:Invent', []],
    ]);
  });

  it('reads "Canonical =" with nothing after it as a term with no aliases', () => {
    const r = importLexicon('Re:Invent =\n', 'text');
    expect(r.terms).toEqual([{ canonical: 'Re:Invent', aliases: [], source: 'import' }]);
  });
});
