'use client';

import { useEffect, useRef, useState } from 'react';

/*
 * The signature element.
 *
 * A dictated line arrives word by word with the spellings speech-to-text
 * actually produces, picks up a spell-check squiggle under each wrong span,
 * then snaps to the canonical forms under a wash of non-photo blue -- the
 * colour a reproduction camera cannot see. The marks fade, and what is left is
 * the clean line the agent receives. That is the whole product in one gesture.
 *
 * Every spelling below is real. "ashler", "cuban eats" and "versal" are aliases
 * shipped in packs/developer.yaml and examples/lexicon.example.yaml, and
 * scripts/build-demo-bundle.mjs fails the build if the real matcher stops
 * turning this exact sentence into this exact output.
 *
 * With `prefers-reduced-motion: reduce` -- and before hydration, and with
 * JavaScript off -- the same content renders as a static before/after.
 */

type Word = {
  raw: string;
  fix?: string;
  /** Pronunciation respelling, taken verbatim from the shipped lexicon. */
  respell?: string;
};

const LINE: Word[] = [
  { raw: 'ping' },
  { raw: 'ashler', fix: 'Ashlr.AI', respell: 'ASH-ler' },
  { raw: 'about' },
  { raw: 'the' },
  { raw: 'cuban eats', fix: 'Kubernetes', respell: 'koo-ber-NET-eez' },
  { raw: 'rollout' },
  { raw: 'on' },
  { raw: 'versal', fix: 'Vercel' },
];

const FIXES = LINE.reduce<number[]>((acc, w, i) => (w.fix ? [...acc, i] : acc), []);

type Phase = 'typing' | 'flagged' | 'fixing' | 'clean';

const WORD_MS = 95;
const AFTER_TYPING_MS = 620;
const AFTER_FLAG_MS = 1000;
const FIX_STEP_MS = 320;
const AFTER_FIX_MS = 1500;
const HOLD_MS = 3800;

const STATUS: Record<Phase, string> = {
  typing: 'transcribing',
  flagged: `${FIXES.length} terms flagged`,
  fixing: 'applying lexicon',
  clean: 'delivered to agent',
};

export function CorrectionProof() {
  const [animating, setAnimating] = useState(false);
  const [phase, setPhase] = useState<Phase>('typing');
  const [shown, setShown] = useState(0);
  const [fixed, setFixed] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (query.matches) return;

    let cancelled = false;
    const at = (ms: number, fn: () => void) => {
      timers.current.push(setTimeout(() => !cancelled && fn(), ms));
    };

    const run = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      setPhase('typing');
      setShown(0);
      setFixed(0);

      LINE.forEach((_, i) => at(WORD_MS * (i + 1), () => setShown(i + 1)));
      const typed = WORD_MS * LINE.length;

      at(typed + AFTER_TYPING_MS, () => setPhase('flagged'));
      const flagged = typed + AFTER_TYPING_MS + AFTER_FLAG_MS;

      at(flagged, () => setPhase('fixing'));
      FIXES.forEach((_, i) => at(flagged + FIX_STEP_MS * i, () => setFixed(i + 1)));
      const done = flagged + FIX_STEP_MS * FIXES.length;

      at(done + AFTER_FIX_MS, () => setPhase('clean'));
      at(done + AFTER_FIX_MS + HOLD_MS, run);
    };

    setAnimating(true);
    run();
    return () => {
      cancelled = true;
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

  if (!animating) return <StaticProof />;

  const marksVisible = phase === 'fixing';

  return (
    <figure className="panel m-0 overflow-hidden">
      <figcaption className="panel-head">
        <span className="micro">dictated · 2.4s of audio</span>
        <span className="micro flex items-center gap-2 text-right">
          <Pulse live={phase !== 'clean'} />
          {STATUS[phase]}
        </span>
      </figcaption>

      <div className="flex min-h-[9.5rem] items-center px-5 py-8 sm:min-h-[10.5rem] sm:px-8">
        <p
          aria-live="off"
          className="font-mono text-[clamp(1rem,0.62rem+1.7vw,1.5rem)] leading-[2.15] tracking-[-0.01em]"
        >
          {LINE.map((word, i) => {
            const visible = i < shown;
            const order = FIXES.indexOf(i);
            const isFixed = order > -1 && order < fixed;
            const flagged = !!word.fix && !isFixed && (phase === 'flagged' || phase === 'fixing');

            return (
              <span key={i}>
                <span
                  className={`tok ${visible ? 'word-in' : 'invisible'}`}
                  style={{ animationDelay: '0ms' }}
                >
                  {word.fix ? (
                    <>
                      <span className="tok-swap">
                        <span
                          className={`tok-raw ${flagged ? 'tok-flagged' : ''}`}
                          style={{ opacity: isFixed ? 0 : 1 }}
                        >
                          {word.raw}
                        </span>
                        <span className="tok-fix" style={{ opacity: isFixed ? 1 : 0 }}>
                          {word.fix}
                        </span>
                      </span>
                      {isFixed && marksVisible ? <span className="tok-wash tok-wash-on" /> : null}
                      {word.respell ? (
                        <span
                          className={`tok-annot ${isFixed && marksVisible ? 'tok-annot-on' : ''}`}
                          aria-hidden="true"
                        >
                          \{word.respell}\
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-paper-2">{word.raw}</span>
                  )}
                </span>
                {i < LINE.length - 1 ? ' ' : ''}
              </span>
            );
          })}
        </p>
      </div>

      <div className="border-t border-rule-soft px-5 py-3 sm:px-8">
        <span className="micro">
          {phase === 'clean' ? 'what your agent receives' : 'what the microphone produced'}
        </span>
      </div>
    </figure>
  );
}

/** The before/after, for reduced motion, for no JavaScript, and for first paint. */
function StaticProof() {
  return (
    <figure className="panel m-0 overflow-hidden">
      <figcaption className="panel-head">
        <span className="micro">dictated · 2.4s of audio</span>
        <span className="micro">3 terms flagged</span>
      </figcaption>

      <div className="flex min-h-[9.5rem] flex-col justify-center gap-6 px-5 py-8 sm:min-h-[10.5rem] sm:px-8">
        <div>
          <span className="micro mb-2 block">what the microphone produced</span>
          <p className="font-mono text-[clamp(0.9rem,0.6rem+1.3vw,1.2rem)] leading-relaxed text-paper-2">
            ping <span className="tok-flagged">ashler</span> about the{' '}
            <span className="tok-flagged">cuban eats</span> rollout on{' '}
            <span className="tok-flagged">versal</span>
          </p>
        </div>
        <div>
          <span className="micro mb-2 block">what your agent receives</span>
          <p className="font-mono text-[clamp(0.9rem,0.6rem+1.3vw,1.2rem)] leading-relaxed">
            ping <b className="font-medium">Ashlr.AI</b> about the{' '}
            <b className="font-medium">Kubernetes</b> rollout on{' '}
            <b className="font-medium">Vercel</b>
          </p>
        </div>
      </div>
    </figure>
  );
}

function Pulse({ live }: { live: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-1.5 rounded-full transition-colors duration-300"
      style={{ background: live ? 'var(--color-blue-deep)' : 'var(--color-paper-3)' }}
    />
  );
}
