import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Newsreader } from 'next/font/google';
import { DESCRIPTION, SITE_URL, TAGLINE } from '@/lib/site';
import './globals.css';

/*
 * Three faces, three jobs, the way a dictionary entry is set: a headword face,
 * an interface face, and a face for the raw material. All self-hosted by
 * next/font with `display: swap`, so nothing blocks first paint.
 */
const newsreader = Newsreader({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-newsreader',
  weight: ['400', '500'],
  style: ['normal', 'italic'],
});

const instrument = Instrument_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-instrument',
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-plex-mono',
  weight: ['400', '500'],
});

const TITLE = `Lexicon: ${TAGLINE}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: '%s | Lexicon',
  },
  description: DESCRIPTION,
  applicationName: 'Lexicon',
  category: 'technology',
  keywords: [
    'dictation', 'speech to text', 'transcription errors', 'proper nouns',
    'MCP', 'Model Context Protocol', 'MCP server', 'Claude Code', 'Cursor',
    'Codex', 'custom dictionary', 'Wispr Flow', 'Superwhisper', 'whisper.cpp',
    'voice to text', 'brand name', 'vocabulary',
  ],
  authors: [{ name: 'Ashlr.AI', url: 'https://ashlr.ai' }],
  creator: 'Ashlr.AI',
  publisher: 'Ashlr.AI',
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'Lexicon',
    locale: 'en_US',
    title: TITLE,
    description: DESCRIPTION,
    // No `images` here on purpose: app/opengraph-image.tsx supplies a generated
    // 1200x630 card that always matches the current copy. Setting images here
    // would override it with a file that goes stale the moment the page changes.
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
  },
  alternates: {
    canonical: '/',
    types: {
      // The llms.txt convention: a clean, linkable summary for models, advertised
      // from the head so a crawler finds it without being told.
      'text/plain': [
        { url: '/llms.txt', title: 'Lexicon for language models (index)' },
        { url: '/llms-full.txt', title: 'Lexicon for language models (full text)' },
      ],
      'application/json': [
        { url: '/mcp.json', title: 'Lexicon MCP server install manifest' },
      ],
    },
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#070a0f',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${instrument.variable} ${plexMono.variable}`}
    >
      {/*
        * The llms.txt v2 discovery convention (llmstxt.org): `rel="describedby"`
        * points at the llms.txt that covers this path. Next's metadata API has
        * no field for a custom `rel`, so it is written here and React hoists it
        * into the head. The `rel="alternate"` pair in `metadata.alternates` says
        * the same thing in the older form; both are cheap, and which one a given
        * crawler honours is not something we get to find out.
        */}
      <link rel="describedby" type="text/plain" href="/llms.txt" />
      <body>{children}</body>
    </html>
  );
}
