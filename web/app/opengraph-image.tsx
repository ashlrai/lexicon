import { ImageResponse } from 'next/og';
import { DESCRIPTION, SITE_URL } from '@/lib/site';

export const alt =
  'Lexicon: dictation gets English right and your vocabulary wrong. ' +
  'A transcript reading "tell ashler to ship it" corrected to "tell Ashlr.AI to ship it".';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/*
 * Generated rather than drawn, so the card can never disagree with the page.
 * The old /og.png was a 1280x640 file somebody exported once; every copy change
 * since then left it quietly wrong, and 1280x640 is not the 1200x630 that
 * Twitter and LinkedIn crop to.
 *
 * The card is the product demo in one frame: the sentence as dictation wrote it,
 * struck through in the flag colour, and the same sentence corrected in
 * non-photo blue. Someone who never clicks still learns what this does.
 */

const INK = '#070a0f';
const INK_2 = '#0d131c';
const RULE = '#1d2836';
const PAPER = '#e6e9ee';
const PAPER_2 = '#98a4b5';
const PAPER_3 = '#5e6b7d';
const BLUE = '#a4dded';
const BLUE_DEEP = '#6fc2db';
const FLAG = '#e0654b';

/**
 * Google serves TTF to an old user agent and WOFF2 to a modern one, and satori
 * cannot read WOFF2. If the fetch fails (offline build, Google hiccup) the card
 * still renders in the bundled fallback face rather than failing the build.
 */
async function googleFont(family: string, weight: number): Promise<ArrayBuffer | null> {
  try {
    const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
    const css = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/533.21.1 (KHTML, like Gecko) Version/5.0.5 Safari/533.21.1',
      },
    }).then((r) => (r.ok ? r.text() : ''));
    const src = /src: url\((.+?)\) format\('(?:opentype|truetype)'\)/.exec(css)?.[1];
    if (!src) return null;
    const res = await fetch(src);
    return res.ok ? await res.arrayBuffer() : null;
  } catch {
    return null;
  }
}

export default async function Image() {
  const [display, mono] = await Promise.all([
    googleFont('Newsreader', 400),
    googleFont('IBM Plex Mono', 500),
  ]);

  const fonts = [
    display ? { name: 'Newsreader', data: display, weight: 400 as const, style: 'normal' as const } : null,
    mono ? { name: 'Plex', data: mono, weight: 500 as const, style: 'normal' as const } : null,
  ].filter((f): f is NonNullable<typeof f> => f !== null);

  const display_ = display ? 'Newsreader' : 'sans-serif';
  const mono_ = mono ? 'Plex' : 'monospace';

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: INK,
          padding: '64px 72px',
          // A faint wash of the accent in one corner, so the card is not a black slab.
          backgroundImage: `radial-gradient(900px 500px at 88% -10%, ${INK_2} 0%, ${INK} 62%)`,
        }}
      >
        {/* masthead */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <div style={{ fontFamily: display_, fontSize: 40, color: PAPER, letterSpacing: '-0.02em' }}>
            Lexicon
          </div>
          <div style={{ fontFamily: display_, fontSize: 24, color: BLUE_DEEP, fontStyle: 'italic' }}>
            \LEK-si-kon\
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ fontFamily: mono_, fontSize: 19, color: PAPER_3, letterSpacing: '0.14em' }}>
            {SITE_URL.replace('https://', '').toUpperCase()}
          </div>
        </div>

        {/* headline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div
            style={{
              fontFamily: display_,
              fontSize: 76,
              lineHeight: 1.06,
              color: PAPER,
              letterSpacing: '-0.025em',
              maxWidth: 900,
              display: 'flex',
            }}
          >
            Dictation gets English right and your vocabulary wrong.
          </div>
          <div style={{ fontSize: 26, lineHeight: 1.45, color: PAPER_2, maxWidth: 780, display: 'flex' }}>
            One YAML file of the names you say out loud, applied to every transcript
            before an agent reads it.
          </div>
        </div>

        {/* the correction itself */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            border: `1px solid ${RULE}`,
            borderRadius: 12,
            background: INK_2,
            padding: '24px 28px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
            <div style={{ fontFamily: mono_, fontSize: 16, color: PAPER_3, letterSpacing: '0.14em', width: 168 }}>
              WHAT IT WROTE
            </div>
            <div
              style={{
                fontFamily: mono_,
                fontSize: 27,
                color: PAPER_2,
                textDecoration: 'line-through',
                textDecorationColor: FLAG,
                display: 'flex',
              }}
            >
              tell ashler to ship it
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
            <div style={{ fontFamily: mono_, fontSize: 16, color: PAPER_3, letterSpacing: '0.14em', width: 168 }}>
              WHAT IT MEANT
            </div>
            <div style={{ fontFamily: mono_, fontSize: 27, color: BLUE, display: 'flex' }}>
              tell Ashlr.AI to ship it
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: fonts.length ? fonts : undefined },
  );
}

// `DESCRIPTION` is imported so this file fails the typecheck if lib/site.ts is
// renamed or gutted; the card's copy is intentionally shorter than the meta one.
void DESCRIPTION;
