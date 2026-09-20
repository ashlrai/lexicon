import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Instrument_Sans, Newsreader } from 'next/font/google';
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

const DESCRIPTION =
  'Speech-to-text is excellent at English and wrong about your vocabulary. ' +
  'Lexicon is one YAML file of the names, products and acronyms you say out loud, ' +
  'applied to every transcript before an agent reads it.';

export const metadata: Metadata = {
  metadataBase: new URL('https://lexicon.ashlr.ai'),
  title: {
    default: 'Lexicon: the words your dictation keeps getting wrong',
    template: '%s | Lexicon',
  },
  description: DESCRIPTION,
  applicationName: 'Lexicon',
  keywords: [
    'dictation', 'speech to text', 'MCP', 'Model Context Protocol',
    'Claude Code', 'whisper.cpp', 'vocabulary', 'transcription',
  ],
  authors: [{ name: 'Ashlr.AI', url: 'https://ashlr.ai' }],
  openGraph: {
    type: 'website',
    url: 'https://lexicon.ashlr.ai',
    siteName: 'Lexicon',
    title: 'Lexicon: the words your dictation keeps getting wrong',
    description: DESCRIPTION,
    images: [{ url: '/og.png', width: 1280, height: 640, alt: 'Lexicon' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Lexicon: the words your dictation keeps getting wrong',
    description: DESCRIPTION,
    images: ['/og.png'],
  },
  alternates: { canonical: 'https://lexicon.ashlr.ai' },
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
      <body>{children}</body>
    </html>
  );
}
