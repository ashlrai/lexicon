'use client';

import { useEffect, useRef } from 'react';
import type { Shot as ShotData } from '@/lib/media';
import { Shot } from './Shot';

/*
 * A screen recording.
 *
 * The mp4 plays: it is a fraction of the GIF's weight and it is the only one of
 * the two that can be stopped. The GIF stays inside the element as the fallback
 * for anything that will not play it.
 *
 * `prefers-reduced-motion: reduce` gets the first frame and nothing else. CSS
 * cannot stop a video, so this is done here, on mount and again whenever the
 * preference changes, rather than by shipping a different element and hoping
 * the guess was right at hydration.
 */
export function Clip({
  mp4,
  gif,
  width,
  height,
  alt,
  sizes,
  priority,
}: {
  mp4: string | null;
  gif: ShotData | null;
  width: number;
  height: number;
  alt: string;
  sizes: string;
  priority?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      if (query.matches) {
        video.loop = false;
        video.pause();
        // Land on the opening frame: the still, rather than wherever autoplay
        // happened to reach before this ran.
        try {
          video.currentTime = 0;
        } catch {
          /* not seekable yet; the loadeddata pass below catches it */
        }
      } else {
        video.loop = true;
        void video.play().catch(() => {
          /* a browser that refuses autoplay shows the first frame, which is fine */
        });
      }
    };

    apply();
    video.addEventListener('loadeddata', apply);
    query.addEventListener('change', apply);
    return () => {
      video.removeEventListener('loadeddata', apply);
      query.removeEventListener('change', apply);
    };
  }, []);

  // No mp4 in this deployment: the GIF is the whole asset.
  if (!mp4) {
    return gif ? <Shot shot={gif} sizes={sizes} priority={priority} /> : null;
  }

  return (
    <video
      ref={ref}
      width={width}
      height={height}
      autoPlay
      muted
      loop
      playsInline
      preload="metadata"
      // A silent loop is a picture, not a film: it gets a name, not a transcript.
      role="img"
      aria-label={alt}
      className="block h-auto w-full"
    >
      <source src={mp4} type="video/mp4" />
      {/*
        * No <img> fallback inside the element. Browsers fetch and decode
        * fallback content in a <video> even when they are playing the video --
        * measured: the 90 KB GIF was downloaded alongside the mp4 on a browser
        * that never showed it -- which spends the whole saving the mp4 exists
        * for. H.264 in an mp4 has no meaningful gap in support left, and a
        * deployment with only the GIF still renders it: `clip()` returns no
        * mp4 and the branch above hands it to <Shot> instead.
        */}
    </video>
  );
}
