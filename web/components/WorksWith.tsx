import icons from '@/lib/generated/brand-icons.json';

/*
 * Nominative use: this wall says what Lexicon is compatible with, nothing more.
 * The policy, applied per brand and recorded with its source URL in
 * web/public/brands/MANIFEST.md:
 *
 *  - Apple's Identity Guidelines forbid using the Apple logo to indicate
 *    compatibility, so macOS is set as a word in our own type. No Apple mark
 *    appears anywhere on this page.
 *  - Where simple-icons ships a CC0 path for a brand, we use it, monochrome, in
 *    the page's neutral foreground. Never in the accent colour, never sized to
 *    dominate, never locked up with a Lexicon mark.
 *  - Where simple-icons does NOT ship a path we set the product name as text.
 *    Checked against each owner's own terms on 2026-09-20, and the reasons
 *    differ: Microsoft did ask simple-icons for removal and licenses its logos,
 *    Windows guidelines name compatibility-signalling as a use its logo is not
 *    for, OpenAI forbids a third party's site carrying its marks, and xAI
 *    permits referential use but only unaltered, which the monochrome treatment
 *    here would break. Apple is the same conclusion for macOS. None of them
 *    object to the plain word.
 *  - Every entry is verified against the repo. Nothing aspirational is listed.
 *
 * Why every tile has a leading slot even when there is no mark to put in it:
 *
 *    Ten of the thirteen brands asked for cannot carry a logo, so sourcing more
 *    of them is not available as a fix. A wall where some tiles open with a
 *    glyph and others open with the name reads as a wall with holes in it, and
 *    the holes sit on exactly the brands we are least able to explain. So the
 *    slot is fixed and identical on every tile: the mark fills it where one is
 *    licensed, and a monogram set in our own mono face fills it where one is
 *    not, a step down in tone so it never poses as a logo. Same silhouette,
 *    same rhythm, and the absence of a mark reads as a decision rather than an
 *    oversight.
 */

type Mark = { title: string; path: string };
const MARKS = icons as Record<string, Mark>;

type Item = {
  name: string;
  /** A simple-icons slug, only where that project ships a CC0 path for it. */
  slug?: string;
  /** The monogram for a brand we may not reproduce. Two letters, our type. */
  mono?: string;
};

type Row = {
  label: string;
  lead: string;
  items: Item[];
  note: string;
};

const ROWS: Row[] = [
  {
    label: 'agents',
    lead: 'Lexicon corrects what you dictate into',
    // src/cli/cmd-install.ts, INSTALL_CLIENTS
    items: [
      { name: 'Claude Code', slug: 'claudecode' },
      { name: 'Claude Desktop', slug: 'claude' },
      { name: 'Cursor', slug: 'cursor' },
      { name: 'Windsurf', slug: 'windsurf' },
      { name: 'Gemini CLI', slug: 'googlegemini' },
      { name: 'OpenAI Codex', mono: 'CX' },
      { name: 'VS Code', mono: 'VS' },
    ],
    note: 'lexicon install writes the MCP server into each client’s own config file. Any other MCP client works too: lexicon install generic prints the block to paste.',
  },
  {
    label: 'browser chats',
    lead: 'and into the composer on',
    // extension/manifest.json host_permissions, extension/src/adapters.ts
    items: [
      { name: 'ChatGPT', mono: 'CG' },
      { name: 'Claude', slug: 'claude' },
      { name: 'Gemini', slug: 'googlegemini' },
      { name: 'Grok', mono: 'GK' },
      { name: 'Perplexity', slug: 'perplexity' },
      { name: 'Microsoft Copilot', mono: 'MC' },
      { name: 'Poe', slug: 'poe' },
    ],
    note: 'The extension runs in Chrome, Edge, Brave and Firefox, and can be switched on for any other site with a text box. It reads the composer before you send and never touches audio.',
  },
  {
    label: 'dictation and speech engines',
    lead: 'It also exports your words to',
    // src/core/exporters: 15 formats
    items: [
      { name: 'Wispr Flow', mono: 'WF' },
      { name: 'Superwhisper', mono: 'SW' },
      { name: 'Whisper', mono: 'WH' },
      { name: 'Deepgram', slug: 'deepgram' },
      { name: 'AssemblyAI', mono: 'AA' },
      { name: 'Azure Speech', mono: 'AZ' },
      { name: 'Google Speech-to-Text', slug: 'googlecloud' },
      { name: 'espanso', mono: 'ES' },
      { name: 'macOS Text Replacement', mono: 'TR' },
    ],
    note: 'Fifteen export formats in all. Lexicon writes the dictionary, keyword list or prompt each of these accepts, and it never calls their APIs, and seven importers read the dictionaries back out again.',
  },
];

/**
 * The monogram of last resort.
 *
 * Every tile without a `mono` has a `slug`, so this only runs when simple-icons
 * has dropped an icon we were shipping, which it does at a brand's request and
 * without warning. The build skips the missing path rather than failing, so
 * without this the tile would render an empty slot and the wall would go patchy
 * again on somebody else's schedule.
 */
function initials(name: string): string {
  const words = name.split(/[\s.-]+/).filter(Boolean);
  const two = words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2);
  return two.toUpperCase();
}

/** The fixed leading slot. A mark where one is licensed, a monogram where not. */
function Slot({ item }: { item: Item }) {
  const mark = item.slug ? MARKS[item.slug] : undefined;

  return (
    <span className="flex size-[17px] flex-none items-center justify-center">
      {mark ? (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="size-full fill-paper-2">
          <path d={mark.path} />
        </svg>
      ) : (
        <span
          aria-hidden="true"
          className="font-mono text-[0.56rem] font-medium uppercase leading-none tracking-[0.01em] text-paper-3"
        >
          {item.mono ?? initials(item.name)}
        </span>
      )}
    </span>
  );
}

export function WorksWith() {
  return (
    <div className="flex flex-col gap-12 sm:gap-14">
      {ROWS.map((row) => (
        <div key={row.label}>
          <div className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="micro">{row.label}</span>
            <span className="text-[0.92rem] text-paper-2">{row.lead}</span>
          </div>

          <ul className="flex flex-wrap gap-x-2 gap-y-2">
            {row.items.map((item) => (
              <li
                key={item.name}
                className="flex items-center gap-2 rounded-md border border-rule-soft bg-ink-2 px-3 py-2"
              >
                <Slot item={item} />
                <span className="text-[0.85rem] leading-none text-paper">{item.name}</span>
              </li>
            ))}
          </ul>

          <p className="mt-4 max-w-[58ch] text-[0.85rem] leading-relaxed text-paper-3">
            {row.note}
          </p>
        </div>
      ))}
    </div>
  );
}
