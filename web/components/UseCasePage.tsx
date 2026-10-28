import { DOC } from '@/lib/site';
import { useCases, useCasePath, type Claim, type UseCase } from '@/lib/use-cases';

function ClaimBlock({ claim, lead = false }: { claim: Claim; lead?: boolean }) {
  return (
    <div data-claim className="space-y-4">
      <p className={lead ? 'lede max-w-[58ch]' : 'max-w-[68ch] leading-relaxed text-paper-2'}>
        {claim.text}
      </p>
      {claim.code ? (
        <pre className="panel max-w-full overflow-x-auto p-5 font-mono text-[0.82rem] leading-7 text-paper sm:text-[0.9rem]">
          <code>{claim.code}</code>
        </pre>
      ) : null}
      <ul aria-label="Sources" className="flex flex-wrap gap-x-5 gap-y-2 text-xs text-paper-2">
        {claim.sources.map((source) => (
          <li key={source.path}>
            <a data-source className="link-accent" href={DOC(source.path)}>
              {source.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function UseCasePage({ guide }: { guide: UseCase }) {
  return (
    <>
      <a href="#guide" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-blue focus:p-3 focus:text-ink">
        Skip to guide
      </a>
      <header className="border-b border-rule-soft">
        <div className="shell flex min-h-16 flex-wrap items-center justify-between gap-4 py-3">
          <a href="/" className="display text-2xl">Lexicon</a>
          <nav aria-label="Main navigation" className="flex flex-wrap items-center gap-5 text-sm">
            <a className="link-quiet" href="/#use-cases">Guides</a>
            <a className="link-quiet" href={DOC('docs/README.md')}>Docs</a>
            <a className="link-accent" href="/#install">Install</a>
          </nav>
        </div>
      </header>

      <main id="guide" className="shell py-12 sm:py-20">
        <div className="max-w-[54rem]">
          <a href="/#use-cases" className="entry-label">Practical guides</a>
          <h1 className="display mb-7 max-w-[21ch] text-[clamp(2.6rem,1.5rem+4vw,4.5rem)]">
            {guide.title}
          </h1>
          <ClaimBlock claim={guide.intro} lead />
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="/#install" className="btn btn-primary">Install Lexicon</a>
            <a href="/#demo" className="btn btn-ghost">Try the demo</a>
          </div>
        </div>

        <div className="mt-14 grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_15rem] lg:gap-16">
          <article className="min-w-0 space-y-12" aria-label={guide.title}>
            {guide.sections.map((section, index) => (
              <section id={section.id} key={section.id} className="scroll-mt-8 border-t border-rule pt-8">
                <span aria-hidden="true" className="micro">{String(index + 1).padStart(2, '0')}</span>
                <h2 className="display mb-6 mt-3 text-[1.9rem] leading-tight sm:text-[2.2rem]">
                  {section.title}
                </h2>
                <div className="space-y-7">
                  {section.blocks.map((block, blockIndex) => <ClaimBlock key={blockIndex} claim={block} />)}
                </div>
              </section>
            ))}
          </article>

          <aside className="space-y-9 lg:sticky lg:top-8">
            <nav aria-label="On this page">
              <h2 className="micro mb-4">On this page</h2>
              <ul className="space-y-3 text-sm">
                {guide.sections.map((section) => (
                  <li key={section.id}><a className="link-quiet" href={`#${section.id}`}>{section.title}</a></li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Documentation">
              <h2 className="micro mb-4">Reference docs</h2>
              <ul className="space-y-3 text-sm">
                {guide.docs.map((source) => (
                  <li key={source.path}><a className="link-accent" href={DOC(source.path)}>{source.label}</a></li>
                ))}
              </ul>
            </nav>
          </aside>
        </div>

        <nav aria-label="Related guides" className="mt-16 border-t border-rule pt-10">
          <h2 className="display text-3xl">Keep going</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {useCases.filter((other) => other.slug !== guide.slug).map((other) => (
              <a key={other.slug} href={useCasePath(other.slug)} className="panel p-6 transition-colors hover:border-blue-dim">
                <span className="display text-2xl text-blue">{other.title}</span>
                <p className="mt-3 text-sm leading-relaxed text-paper-2">{other.description}</p>
              </a>
            ))}
          </div>
        </nav>
      </main>

      <footer className="border-t border-rule-soft">
        <nav aria-label="Footer" className="shell flex flex-wrap gap-6 py-8 text-sm">
          <a className="link-quiet" href="/">Lexicon home</a>
          <a className="link-quiet" href={DOC('docs/QUICKSTART.md')}>Quickstart</a>
          <a className="link-accent" href="/#install">Install Lexicon</a>
        </nav>
      </footer>
    </>
  );
}
