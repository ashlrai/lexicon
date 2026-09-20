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
    alt: 'A TextEdit note in which the dictated line ‘ashler is shipping cuban eats support on versal next week’ rewrites itself to ‘Ashlr.AI is shipping Kubernetes support on Vercel next week’, with a bubble beside the caret listing the three fixes.',
    width: 1600,
    height: 900,
  },
  'fix-in-place.gif': {
    alt: 'A TextEdit note in which the dictated line ‘ashler is shipping cuban eats support on versal next week’ rewrites itself to ‘Ashlr.AI is shipping Kubernetes support on Vercel next week’, with a bubble beside the caret listing the three fixes.',
    width: 1600,
    height: 900,
  },
  'bubble.png': {
    alt: 'Lexicon’s correction bubble reading ‘Fixed 3 words’, listing ashler corrected to Ashlr.AI, cuban eats to Kubernetes and versal to Vercel, with Undo and Never buttons.',
    width: 1200,
    height: 620,
  },
  /*
   * The one 1x asset, deliberately. The menu bar carrying our status item is on
   * this Mac's main display, a 1920x1080 external at scale 1.0, so no 2x capture
   * of it exists to take. Moving the menu bar to the Retina built-in does not fix
   * it: that bar is narrower (1512pt against 1920pt) and drops its leftmost status
   * items, and ours is the leftmost of about fifteen, so it would be cropped out
   * rather than captured sharper. Render it at its natural 388px and never wider,
   * or it goes soft: pass a max-width, do not let it run fluid to the column.
   */
  'menubar.png': {
    alt: 'The LexiconBar waveform icon in the macOS menu bar with its menu open: push to talk, fix clipboard now, fix everywhere with a separate toggle for Claude, the correction bubble, the local API running at login, and Quit LexiconBar 0.5.1.',
    width: 900,
    height: 700,
  },
  'onboarding-words.png': {
    alt: 'Lexicon’s macOS setup window on the step ‘Your words’, showing the name Mason Wyatt with the suggested misspellings Mason Wiatt and Mason Wyat, both switched on, above a Try it box holding a dictated sentence.',
    width: 1400,
    height: 900,
  },
  'onboarding-packs.png': {
    alt: 'Lexicon’s starter pack picker with four cards: AI models and tools, Business and startup vocabulary, Developer tools, and Voice and dictation tools, each with its term count and an on/off switch.',
    width: 1400,
    height: 900,
  },
  /*
   * The alt describes the recording, which installs a subset of the starter
   * packs rather than all of them. check-facts reads any count beside the word
   * "packs" as a claim about how many exist, so the line opts out instead of
   * being made wrong to satisfy the checker.
   */
  'cli-setup.gif': {
    alt: 'A terminal running lexicon setup through all seven steps (writing the lexicon file, installing three starter packs, registering the MCP server with five agent clients, exporting for dictation), ending by showing a dictated sentence corrected from Mason Wiatt and Ashler to Mason Wyatt and Ashlr.AI.', // check-facts:ignore
    width: 1200,
    height: 760,
  },
  'cli-normalize.png': {
    alt: 'A terminal running lexicon normalize --diff on two dictated sentences, each replacement listed above the corrected line it produced.',
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
