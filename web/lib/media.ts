import sizes from '@/lib/generated/media.json';

/*
 * Real product imagery, and what the page does when it is not there.
 *
 * Every shot is optional. `shot()` returns null for a file that was not in
 * `public/media` when `scripts/scan-media.mjs` last ran, and each call site
 * renders a drawn fallback instead, so a missing capture costs a screenshot
 * rather than leaving a hole in the layout.
 *
 * Alt text is written here, beside the rest of the site's copy, rather than in
 * the components: it is prose, it describes what a reader would see, and it is
 * the only version of the image that reaches somebody using a screen reader.
 */

type Declared = { alt: string; width: number; height: number };

/**
 * The shots the page knows how to place.
 *
 * `width` and `height` are a fallback aspect ratio, used only when the file's
 * own header cannot be read (an mp4, say). Every shot renders fluid-width, so
 * these numbers reserve the right amount of vertical space before the image
 * arrives and do nothing else.
 */
const CATALOG = {
  'fix-in-place.mp4': {
    alt: 'Dictated text in a Mac app being rewritten in place, with a small Lexicon bubble reporting the terms it replaced.',
    width: 1600,
    height: 900,
  },
  'fix-in-place.gif': {
    alt: 'Dictated text in a Mac app being rewritten in place, with a small Lexicon bubble reporting the terms it replaced.',
    width: 1600,
    height: 900,
  },
  'bubble.png': {
    alt: 'Lexicon’s correction bubble beside a Mac text field, naming the terms it replaced in the line just dictated.',
    width: 1200,
    height: 620,
  },
  'menubar.png': {
    alt: 'Lexicon’s macOS menu bar dropdown, showing its status and the controls for the focused text field.',
    width: 900,
    height: 700,
  },
  'onboarding-words.png': {
    alt: 'The Lexicon setup wizard in a terminal, asking how the user’s own name and company should be spelled.',
    width: 1400,
    height: 900,
  },
  'onboarding-packs.png': {
    alt: 'The Lexicon setup wizard offering its starter packs of terms to install.',
    width: 1400,
    height: 900,
  },
  'cli-setup.gif': {
    alt: 'A terminal running lexicon setup end to end: it writes the lexicon file, asks for the user’s own words, and registers the MCP server with the agent clients it finds.',
    width: 1200,
    height: 760,
  },
  'cli-normalize.png': {
    alt: 'A terminal correcting a dictated sentence with Lexicon, each replacement listed underneath the corrected line.',
    width: 1200,
    height: 680,
  },
  'extension.png': {
    alt: 'A browser chat composer with the Lexicon extension active: the mis-transcribed product names have been rewritten before the message is sent.',
    width: 1600,
    height: 900,
  },
} as const satisfies Record<string, Declared>;

export type MediaName = keyof typeof CATALOG;

export type Shot = {
  src: string;
  width: number;
  height: number;
  alt: string;
  /** An animated GIF through the image optimizer arrives as a single frame. */
  unoptimized: boolean;
};

const PRESENT: Record<string, { width: number; height: number }> = sizes;

/** The shot, or null when the file is not in this deployment. */
export function shot(name: MediaName): Shot | null {
  const found = PRESENT[name];
  if (!found) return null;
  const declared = CATALOG[name];
  return {
    src: `/media/${name}`,
    // A zero means the header was unreadable, not that the file is empty.
    width: found.width || declared.width,
    height: found.height || declared.height,
    alt: declared.alt,
    unoptimized: name.endsWith('.gif'),
  };
}

/** The first of these that exists. For a shot with an acceptable stand-in. */
export function firstShot(...names: MediaName[]): Shot | null {
  for (const name of names) {
    const found = shot(name);
    if (found) return found;
  }
  return null;
}

/**
 * The motion pair. The mp4 is a fraction of the GIF's weight, so it is what
 * plays; the GIF is the fallback inside the <video> element, and either one is
 * enough on its own.
 */
export function clip(base: 'fix-in-place' | 'cli-setup'): {
  mp4: string | null;
  gif: Shot | null;
  width: number;
  height: number;
  alt: string;
} | null {
  const mp4Name = `${base}.mp4` as MediaName;
  const gifName = `${base}.gif` as MediaName;
  const mp4 = mp4Name in CATALOG && PRESENT[mp4Name] ? `/media/${mp4Name}` : null;
  const gif = gifName in CATALOG ? shot(gifName) : null;
  if (!mp4 && !gif) return null;

  const declared = CATALOG[gifName in CATALOG ? gifName : mp4Name];
  return {
    mp4,
    gif,
    width: gif?.width ?? declared.width,
    height: gif?.height ?? declared.height,
    alt: declared.alt,
  };
}
