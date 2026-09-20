import icons from '@/lib/generated/brand-icons.json';

/*
 * Nominative use: this wall says what Lexicon is compatible with, nothing more.
 * The policy, applied per brand and documented in docs/LANDING.md:
 *
 *  - Apple's Identity Guidelines forbid using the Apple logo to indicate
 *    compatibility, so macOS is set as a word in our own type. No Apple mark
 *    appears anywhere on this page.
 *  - Where simple-icons ships a CC0 path for a brand, we use it, monochrome, in
 *    the page's neutral foreground. Never in the accent colour, never sized to
 *    dominate, never locked up with a Lexicon mark.
 *  - Where simple-icons does NOT ship a path -- usually because the owner asked
 *    for its removal, as OpenAI, Microsoft and xAI did -- we set the product
 *    name as text instead of reproducing a mark they asked not to be copied.
 *  - Every entry is verified against the repo. Nothing aspirational is listed.
 */

type Mark = { title: string; path: string };
const MARKS = icons as Record<string, Mark>;

type Item = { name: string; slug?: string };

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
      { name: 'OpenAI Codex' },
      { name: 'VS Code' },
    ],
    note: 'lexicon install writes the MCP server into each client’s own config file. Any other MCP client works too — lexicon install generic prints the block to paste.',
  },
  {
    label: 'browser chats',
    lead: 'and into the composer on',
    // extension/manifest.json host_permissions, extension/src/adapters.ts
    items: [
      { name: 'ChatGPT' },
      { name: 'Claude', slug: 'claude' },
      { name: 'Gemini', slug: 'googlegemini' },
      { name: 'Grok' },
      { name: 'Perplexity', slug: 'perplexity' },
      { name: 'Microsoft Copilot' },
      { name: 'Poe', slug: 'poe' },
    ],
    note: 'The extension runs in Chrome, Edge, Brave and Firefox, and can be switched on for any other site with a text box. It reads the composer before you send and never touches audio.',
  },
  {
    label: 'dictation and speech engines',
    lead: 'It also exports your words to',
    // src/core/exporters — 15 formats
    items: [
      { name: 'Wispr Flow' },
      { name: 'Superwhisper' },
      { name: 'Whisper' },
      { name: 'Deepgram', slug: 'deepgram' },
      { name: 'AssemblyAI' },
      { name: 'Azure Speech' },
      { name: 'Google Speech-to-Text', slug: 'googlecloud' },
      { name: 'espanso' },
      { name: 'macOS Text Replacement' },
    ],
    note: 'Fifteen export formats in all. Lexicon writes the dictionary, keyword list or prompt each of these accepts — it never calls their APIs, and seven importers read the dictionaries back out again.',
  },
];

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
            {row.items.map((item) => {
              const mark = item.slug ? MARKS[item.slug] : undefined;
              return (
                <li
                  key={item.name}
                  className="flex items-center gap-2 rounded-md border border-rule-soft bg-ink-2 px-3 py-2"
                >
                  {mark ? (
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      className="size-[15px] flex-none fill-paper-2"
                    >
                      <path d={mark.path} />
                    </svg>
                  ) : null}
                  <span className="text-[0.85rem] leading-none text-paper">{item.name}</span>
                </li>
              );
            })}
          </ul>

          <p className="mt-4 max-w-[58ch] text-[0.85rem] leading-relaxed text-paper-3">
            {row.note}
          </p>
        </div>
      ))}
    </div>
  );
}
