import icons from '@/lib/generated/brand-icons.json';
import { LATEST_ASSET } from '@/lib/site';

/*
 * What runs on each operating system, and what each tile is allowed to show.
 *
 * Two of these three marks may not be drawn here, and the reasons are on record
 * in web/public/brands/MANIFEST.md:
 *
 *  - Apple's Identity Guidelines forbid the Apple logo as a compatibility
 *    signal, so the macOS tile opens with a laptop we drew.
 *  - The Windows Trademark Guidelines require a licence for the Windows logo
 *    and name showing compatibility for other software as a use the logo is
 *    not for, which is exactly this. So that tile opens with a monitor we drew.
 *  - Tux is the one mascot with an affirmative grant: Larry Ewing permits use
 *    and modification on condition of credit, and the footer carries the line
 *    he asks for. The monochrome path is the CC0 one from simple-icons.
 *
 * The two glyphs we drew are deliberately plain hardware, not stylised OS
 * marks, so that neither one reads as an approximation of a logo we are not
 * allowed to use. All three sit in the same box at the same size so the row
 * reads as one set.
 */

type Mark = { title: string; path: string };
const MARKS = icons as Record<string, Mark>;

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-[19px] flex-none fill-paper-2">
      {children}
    </svg>
  );
}

/** A laptop. Ours, because the Apple logo may not say "works on a Mac". */
function LaptopGlyph() {
  return (
    <Glyph>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.25 4.5h13.5c.966 0 1.75.784 1.75 1.75V15.5H3.5V6.25c0-.966.784-1.75 1.75-1.75ZM5 6h14v8H5V6Z"
      />
      <path d="M1.75 16.75h20.5l-.6 1.8a1.5 1.5 0 0 1-1.42 1.03H3.77a1.5 1.5 0 0 1-1.42-1.03l-.6-1.8Z" />
    </Glyph>
  );
}

/** A desktop monitor. Ours, because the Windows logo may not say this either. */
function MonitorGlyph() {
  return (
    <Glyph>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4.25 3.5h15.5c.966 0 1.75.784 1.75 1.75v9.5c0 .966-.784 1.75-1.75 1.75H4.25a1.75 1.75 0 0 1-1.75-1.75v-9.5c0-.966.784-1.75 1.75-1.75ZM4 5.25v9.5c0 .138.112.25.25.25h15.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25H4.25a.25.25 0 0 0-.25.25Z"
      />
      <path d="M10.1 16.5h3.8l.45 2.75h-4.7l.45-2.75Z" />
      <path d="M7.75 19.25h8.5a.75.75 0 0 1 0 1.5h-8.5a.75.75 0 0 1 0-1.5Z" />
    </Glyph>
  );
}

/**
 * A terminal, for the day simple-icons drops Tux.
 *
 * The build skips a mark it cannot find rather than failing, so without a
 * fallback this tile would render an empty slot and break the row it exists to
 * make uniform. Ours, so nothing unlicensed can ever land here.
 */
function TerminalGlyph() {
  return (
    <Glyph>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3 4.75h18c.966 0 1.75.784 1.75 1.75v11c0 .966-.784 1.75-1.75 1.75H3a1.75 1.75 0 0 1-1.75-1.75v-11C1.25 5.534 2.034 4.75 3 4.75ZM2.75 6.5v11c0 .138.112.25.25.25h18a.25.25 0 0 0 .25-.25v-11a.25.25 0 0 0-.25-.25H3a.25.25 0 0 0-.25.25Z"
      />
      <path d="m6 9.1 3.4 2.9L6 14.9l-1-1.15L7.1 12 5 10.25 6 9.1Z" />
      <path d="M10.75 13.5h5.5V15h-5.5z" />
    </Glyph>
  );
}

/** Tux, drawn from the CC0 path. Credited to Larry Ewing in the footer. */
function TuxGlyph() {
  const tux = MARKS.linux;
  if (!tux) return <TerminalGlyph />;
  return (
    <Glyph>
      <path d={tux.path} />
    </Glyph>
  );
}

type Platform = {
  id: string;
  /** The heading. "Linux" is an adjective here, never a standalone noun. */
  name: React.ReactNode;
  glyph: React.ReactNode;
  body: string;
  download?: { label: string; href: string };
};

/*
 * The Linux Foundation permits the word mark referentially, as an adjective,
 * carrying the (R) on first use. This is that first use on the page, which is
 * why the symbol is here and not on the later mentions.
 */
const PLATFORMS: Platform[] = [
  {
    id: 'macos',
    name: 'macOS',
    glyph: <LaptopGlyph />,
    body: 'The menu bar app, the CLI and the MCP server. Fix everywhere rewrites dictated text in whatever field has focus.',
    download: { label: 'LexiconBar.app.zip', href: LATEST_ASSET('LexiconBar.app.zip') },
  },
  {
    id: 'windows',
    name: 'Windows',
    glyph: <MonitorGlyph />,
    body: 'The CLI and the MCP server, wherever Node 20 or newer is on the PATH. There is no tray app yet.',
  },
  {
    id: 'linux',
    name: (
      <>
        Linux<span className="align-super text-[0.6em]">&reg;</span> distributions
      </>
    ),
    glyph: <TuxGlyph />,
    body: 'The CLI and the MCP server, through the install script, Homebrew or npm. There is no tray app yet.',
  },
];

export function Platforms() {
  return (
    <div>
      <span className="micro mb-4 block">platforms</span>
      <ul className="grid gap-3 sm:grid-cols-3">
        {PLATFORMS.map((p) => (
          <li
            key={p.id}
            className="flex flex-col rounded-md border border-rule-soft bg-ink-2 px-3.5 py-3"
          >
            <div className="flex items-center gap-2.5">
              {p.glyph}
              <span className="text-[0.9rem] font-medium leading-none text-paper">{p.name}</span>
            </div>
            <p className="mt-2.5 text-[0.8rem] leading-relaxed text-paper-3">{p.body}</p>
            {p.download ? (
              <a className="link-accent mt-2.5 font-mono text-[0.78rem]" href={p.download.href}>
                {p.download.label}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
