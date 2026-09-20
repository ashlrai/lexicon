import Image from 'next/image';
import type { Shot as ShotData } from '@/lib/media';

/**
 * A product screenshot.
 *
 * Fluid width with the file's true pixel dimensions declared, so the browser
 * reserves the right box before the bytes arrive and nothing on the page moves
 * when they do. Animated GIFs skip the optimizer, which would otherwise hand
 * back a single frame in a smaller format.
 */
export function Shot({
  shot,
  sizes,
  priority,
  className,
}: {
  shot: ShotData;
  /** The rendered width at each breakpoint, so the right file is fetched. */
  sizes: string;
  priority?: boolean;
  className?: string;
}) {
  return (
    <Image
      src={shot.src}
      alt={shot.alt}
      width={shot.width}
      height={shot.height}
      sizes={sizes}
      unoptimized={shot.unoptimized}
      {...(priority ? { priority: true } : { loading: 'lazy' as const })}
      className={`block h-auto w-full ${className ?? ''}`}
    />
  );
}

/** The frame a shot sits in, everywhere it appears on the page. */
export function Frame({
  children,
  label,
  className,
}: {
  children: React.ReactNode;
  /** The caption strip, which says what the reader is looking at. */
  label?: string;
  className?: string;
}) {
  return (
    <figure className={`panel m-0 overflow-hidden ${className ?? ''}`}>
      <div className="bg-ink-3">{children}</div>
      {label ? (
        <figcaption className="border-t border-rule px-4 py-2.5">
          <span className="micro">{label}</span>
        </figcaption>
      ) : null}
    </figure>
  );
}
