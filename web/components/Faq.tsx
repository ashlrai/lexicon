import { DOC, FAQ } from '@/lib/site';

/**
 * `code` spans in the answer text are written as backticks in lib/site.ts, so
 * the same string can be a plain-text answer in llms-full.txt and docs/FAQ.md
 * and a marked-up one here. Odd-indexed pieces are the code.
 */
function withCode(text: string) {
  return text.split('`').map((piece, i) =>
    i % 2 === 1 ? (
      <code key={i} className="font-mono text-[0.9em] text-paper [overflow-wrap:anywhere]">
        {piece}
      </code>
    ) : (
      <span key={i}>{piece}</span>
    ),
  );
}

/*
 * A real FAQ, not a keyword farm. Every answer is self-contained (it names
 * Lexicon rather than opening with "it") because the most likely way anyone
 * reads one of these is quoted on its own, stripped of the question above it and
 * of this page around it.
 */
export function Faq() {
  return (
    <section id="faq" className="border-t border-rule-soft scroll-mt-14">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">questions</span>
        <h2 className="h2 max-w-[20ch]">What people ask before they install it.</h2>

        <dl className="mt-11 grid gap-px overflow-hidden rounded-lg border border-rule bg-rule md:grid-cols-2">
          {FAQ.map((item) => (
            // `min-w-0`: a grid item defaults to min-width:auto, so one long
            // unbreakable command in an answer would widen the column past the
            // viewport. On a phone that overflow is invisible, because the body
            // hides it, and the text simply gets clipped at the right edge.
            <div key={item.q} className="flex min-w-0 flex-col bg-ink px-5 py-7 sm:px-7">
              <dt className="display mb-3 text-[1.25rem] leading-snug text-paper">
                <h3>{item.q}</h3>
              </dt>
              <dd className="text-[0.92rem] leading-relaxed text-paper-2 [overflow-wrap:break-word]">
                {withCode(item.a)}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-8 text-[0.88rem] leading-relaxed text-paper-3">
          The same answers live in{' '}
          <a className="link-accent" href={DOC('docs/FAQ.md')}>
            docs/FAQ.md
          </a>{' '}
          in the repository, and in{' '}
          <a className="link-accent" href="/llms-full.txt">
            /llms-full.txt
          </a>{' '}
          for anything reading this site with a model.
        </p>
      </div>
    </section>
  );
}
