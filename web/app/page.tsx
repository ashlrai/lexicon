import { CorrectionProof } from '@/components/CorrectionProof';
import { Install } from '@/components/Install';
import { LiveDemo } from '@/components/LiveDemo';
import { WorksWith } from '@/components/WorksWith';

export const revalidate = 3600;

const REPO = 'https://github.com/ashlrai/lexicon';
const BENCHMARK = `${REPO}/blob/main/docs/BENCHMARK.md`;

/** Star count, refreshed hourly. A rate limit or an outage just drops the number. */
async function stars(): Promise<number | null> {
  try {
    const res = await fetch('https://api.github.com/repos/ashlrai/lexicon', {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const n = (data as { stargazers_count?: unknown }).stargazers_count;
    // A genuine 0 is hidden the same way a rate limit is: a lonely "0" next to a
    // GitHub link reads as a broken widget, not as information.
    return typeof n === 'number' && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export default async function Page() {
  const starCount = await stars();

  return (
    <>
      <a
        href="#demo"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-blue focus:px-3 focus:py-2 focus:text-sm focus:text-ink"
      >
        Skip to the live demo
      </a>

      <Header stars={starCount} />

      <main>
        <Hero stars={starCount} />
        <Problem />
        <Demo />
        <Coverage />
        <Surfaces />
        <Numbers />
        <InstallSection />
        <OpenSource />
      </main>

      <Footer />
    </>
  );
}

/* ------------------------------------------------------------------- header */

function Header({ stars }: { stars: number | null }) {
  return (
    <header className="sticky top-0 z-40 border-b border-rule-soft bg-ink/85 backdrop-blur-md">
      <div className="shell flex h-14 items-center justify-between gap-4">
        <a href="#top" className="flex items-baseline gap-2.5">
          <span className="display text-[1.35rem] leading-none">Lexicon</span>
          <span className="respell hidden text-[0.8rem] leading-none sm:inline">
            \LEK-si-kon\
          </span>
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a href="#demo" className="micro px-2 py-1 transition-colors hover:text-paper">
            Demo
          </a>
          <a href="#numbers" className="micro hidden px-2 py-1 transition-colors hover:text-paper sm:inline">
            Numbers
          </a>
          <a href="#install" className="micro px-2 py-1 transition-colors hover:text-paper">
            Install
          </a>
          <a
            href={REPO}
            className="micro ml-1 rounded border border-rule px-2.5 py-1 transition-colors hover:border-blue-dim hover:text-blue"
          >
            GitHub{stars !== null ? ` ${stars}` : ''}
          </a>
        </nav>
      </div>
    </header>
  );
}

/* --------------------------------------------------------------------- hero */

function Hero({ stars }: { stars: number | null }) {
  return (
    <section id="top" className="shell pb-16 pt-14 sm:pb-24 sm:pt-24">
      <h1 className="display max-w-[16ch] text-[clamp(2.6rem,1.4rem+4.6vw,5rem)]">
        Dictation gets English right and your vocabulary wrong.
      </h1>

      <p className="lede mt-7 max-w-[46ch]">
        Lexicon is one YAML file of the words you actually say — brands, people, products,
        acronyms — applied to every transcript before an agent reads it. It is not a dictation
        app. It sits between the one you already use and whatever you are talking to.
      </p>

      <div className="mt-9 flex flex-wrap items-center gap-3">
        <a href="#install" className="btn btn-primary">
          Get started
        </a>
        <a href={REPO} className="btn btn-ghost">
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub
          {stars !== null ? (
            <span className="ml-0.5 border-l border-rule pl-2 font-mono text-[0.8rem] tabular-nums text-paper-2">
              {stars.toLocaleString('en-US')}
            </span>
          ) : null}
        </a>
      </div>

      <div className="mt-14 sm:mt-16">
        <CorrectionProof />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ problem */

const MISHEARD: [said: string, wrote: string, meaning: string][] = [
  ['Ashlr.AI', 'ashler', 'a masonry block, not your company'],
  ['Kubernetes', 'cuban eats', 'no referent at all'],
  ['Anthropic', 'and tropic', 'two words, neither of them right'],
  ['Supabase', 'superbase', 'a different product'],
  ['Vercel', 'versal', 'not a word'],
  ['PostgreSQL', 'postgre sequel', 'half a name and a TV term'],
];

function Problem() {
  return (
    <section className="border-t border-rule-soft bg-ink-2/40">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">the problem</span>
        <h2 className="h2 max-w-[20ch]">
          Recognizers have never heard the word.
        </h2>
        <p className="lede mt-6">
          Every spelling below is an alias shipped in Lexicon’s starter packs, because every one of
          them is a transcription somebody actually got.
        </p>

        <div className="mt-10 overflow-hidden rounded-lg border border-rule">
          <div className="hidden grid-cols-[1fr_1fr_1.25fr] gap-4 border-b border-rule bg-ink-2 px-5 py-2.5 sm:grid">
            <span className="micro">what you said</span>
            <span className="micro">what it wrote</span>
            <span className="micro">what your agent read</span>
          </div>
          <ul>
            {MISHEARD.map(([said, wrote, meaning]) => (
              <li
                key={said}
                className="grid gap-x-4 gap-y-1 border-b border-rule-soft px-5 py-3.5 last:border-b-0 sm:grid-cols-[1fr_1fr_1.25fr] sm:items-baseline"
              >
                <span className="font-mono text-[0.9rem] font-medium">{said}</span>
                <span className="font-mono text-[0.9rem] text-paper-2">
                  <span className="tok-flagged">{wrote}</span>
                </span>
                <span className="text-[0.88rem] text-paper-3">{meaning}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="lede mt-9 max-w-[52ch]">
          None of this is the recognizer’s fault. Every dictation app keeps a private dictionary to
          patch it, and none of those dictionaries help when the transcript is produced somewhere
          else — which is exactly what happens when you talk to an agent.
        </p>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------------- demo */

function Demo() {
  return (
    <section id="demo" className="border-t border-rule-soft scroll-mt-14">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">try it</span>
        <div className="mb-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <h2 className="h2 max-w-[18ch]">The real matcher, in your browser.</h2>
          <p className="max-w-[46ch] text-[0.95rem] leading-relaxed text-paper-2">
            This is not a mock-up. The page compiles Lexicon’s{' '}
            <code className="font-mono text-[0.88em] text-paper">src/core</code> to a browser
            bundle, loads the 155 curated starter terms, and runs the same matcher the CLI runs.
            Type anything. Nothing you write is sent anywhere.
          </p>
        </div>
        <LiveDemo />
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- coverage */

function Coverage() {
  return (
    <section className="border-t border-rule-soft bg-ink-2/40">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">coverage</span>
        <h2 className="h2 mb-12 max-w-[22ch]">Works wherever you talk to an agent.</h2>
        <WorksWith />
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- surfaces */

function Surfaces() {
  return (
    <section className="border-t border-rule-soft">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">surfaces</span>
        <h2 className="h2 max-w-[24ch]">One file. Three places it gets applied.</h2>
        <p className="lede mt-6">
          The lexicon lives at <code className="font-mono text-[0.9em]">~/.config/lexicon/lexicon.yaml</code>,
          with an optional per-project file at the repo root. Everything below reads the same file.
        </p>

        <div className="mt-12 grid gap-4 lg:grid-cols-3 lg:gap-5">
          <Surface
            label="agents"
            title="Before the prompt is read"
            body="An MCP server with nineteen tools, plus a Claude Code plugin whose SessionStart and UserPromptSubmit hooks correct the prompt on its way in. Your agent never sees the wrong spelling."
          >
            <Flow
              rows={[
                ['you say', 'add a field to the cuban eats manifest'],
                ['hook', 'UserPromptSubmit → normalize_transcript'],
                ['claude reads', 'add a field to the Kubernetes manifest', true],
              ]}
            />
          </Surface>

          <Surface
            label="browser chats"
            title="Before you press send"
            body="A browser extension that rewrites the composer in place on ChatGPT, Claude, Gemini, Grok, Perplexity, Copilot and Poe — and on any other site you switch it on for."
          >
            <Composer />
          </Surface>

          <Surface
            label="any mac app"
            title="Wherever the cursor is"
            body="A menu bar app that watches the focused text field through the Accessibility API and rewrites dictated text in place — in your editor, your mail client, your notes. Local push-to-talk with whisper.cpp is built in, and so is a loopback HTTP API if you would rather call it yourself."
          >
            <Flow
              rows={[
                ['focus', 'any text field, any application'],
                ['you dictate', 'versal deploy failed again'],
                ['field becomes', 'Vercel deploy failed again', true],
              ]}
            />
          </Surface>
        </div>
      </div>
    </section>
  );
}

function Surface({
  label,
  title,
  body,
  children,
}: {
  label: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="panel flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="micro">{label}</span>
      </div>
      <div className="flex flex-1 flex-col p-5">
        <h3 className="display mb-2.5 text-[1.35rem]">{title}</h3>
        <p className="mb-6 text-[0.88rem] leading-relaxed text-paper-2">{body}</p>
        <div className="mt-auto">{children}</div>
      </div>
    </div>
  );
}

function Flow({ rows }: { rows: [string, string, boolean?][] }) {
  return (
    <div className="rounded-md border border-rule-soft bg-ink-3 p-3.5">
      <dl className="flex flex-col gap-2.5">
        {rows.map(([k, v, fixed]) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="micro text-[0.62rem]">{k}</dt>
            <dd
              className={`font-mono text-[0.78rem] leading-snug ${
                fixed ? 'text-blue' : 'text-paper-2'
              }`}
            >
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Composer() {
  return (
    <div className="rounded-md border border-rule-soft bg-ink-3 p-3.5">
      <div className="mb-2.5 rounded border border-rule bg-ink-2 px-3 py-2.5 font-mono text-[0.78rem] leading-snug text-blue">
        does <span className="font-medium">Pydantic</span> validate this{' '}
        <span className="font-medium">JSON</span> schema
      </div>
      <div className="flex items-center justify-between">
        <span className="micro text-[0.62rem]">2 terms fixed</span>
        <span className="rounded bg-blue px-2 py-0.5 text-[0.68rem] font-semibold text-ink">
          Send
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ numbers */

const STATS: { before: string; after: string; label: string }[] = [
  { before: '41.9%', after: '86.4%', label: 'proper-noun recall, whisper.cpp base.en' },
  { before: '76.0%', after: '95.7%', label: 'small.en, lexicon passed as a Whisper prompt' },
];

function Numbers() {
  return (
    <section id="numbers" className="border-t border-rule-soft bg-ink-2/40 scroll-mt-14">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">measurements</span>
        <h2 className="h2 max-w-[20ch]">Measured, with the caveats attached.</h2>

        <div className="mt-11 grid gap-px overflow-hidden rounded-lg border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="bg-ink px-5 py-7">
              <p className="flex items-baseline gap-2 font-mono tabular-nums">
                <span className="text-[1.15rem] text-paper-3">{s.before}</span>
                <span className="text-paper-3">→</span>
                <span className="text-[1.9rem] font-medium leading-none text-blue">{s.after}</span>
              </p>
              <p className="mt-3.5 text-[0.82rem] leading-relaxed text-paper-2">{s.label}</p>
            </div>
          ))}
          <div className="bg-ink px-5 py-7">
            <p className="font-mono text-[1.9rem] font-medium leading-none tabular-nums text-paper">
              0<span className="text-[1.15rem] text-paper-3"> / 72</span>
            </p>
            <p className="mt-3.5 text-[0.82rem] leading-relaxed text-paper-2">
              ordinary prose sentences changed
            </p>
          </div>
          <div className="bg-ink px-5 py-7">
            <p className="font-mono text-[1.9rem] font-medium leading-none tabular-nums text-paper">
              0.3<span className="text-[1.15rem] text-paper-3"> ms</span>
            </p>
            <p className="mt-3.5 text-[0.82rem] leading-relaxed text-paper-2">
              to normalize one sentence
            </p>
          </div>
        </div>

        <div className="mt-8 grid max-w-[78ch] gap-4 text-[0.85rem] leading-relaxed text-paper-3">
          <p>
            <span className="text-paper-2">How the audio rows were produced.</span> macOS
            text-to-speech, three voices, 110 sentences each, read into whisper.cpp. That is far
            cleaner than a phone microphone — no room, no disfluency, no accent variation — so
            expect lower raw recall on real speech. The “0 of 72” row counts ordinary prose only;
            six sentences in the corpus are deliberately adversarial and are excluded.
          </p>
          <p>
            <span className="text-paper-2">And the synthetic corpus.</span> On 398 cases sampled
            from known speech-to-text failures, term recall goes 5.1% to 96.5% with 0 of 95 clean
            sentences changed. The 5.1% baseline is low by construction — the corpus is built from
            failures — so it is not a general accuracy figure for any recognizer.
          </p>
          <p>
            <a className="link-accent" href={`${BENCHMARK}#method`}>
              Read the method
            </a>{' '}
            or{' '}
            <a className="link-accent" href={BENCHMARK}>
              the whole benchmark
            </a>
            , including what still fails.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ install */

function InstallSection() {
  return (
    <section id="install" className="border-t border-rule-soft scroll-mt-14">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">install</span>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,31rem)] lg:gap-14">
          <div>
            <h2 className="h2 max-w-[16ch]">Install once. Say it once.</h2>
            <p className="lede mt-6">
              The setup wizard writes your lexicon, offers to harvest candidate terms from the repo
              you are standing in, and registers the MCP server with every agent client it finds.
            </p>
            <div className="mt-8 flex flex-col gap-3 text-[0.88rem] text-paper-2">
              <p>
                <span className="font-mono text-paper">lexicon setup</span> — first run, start to
                finish.
              </p>
              <p>
                <span className="font-mono text-paper">lexicon pack add developer</span> — 155
                curated terms across four packs.
              </p>
              <p>
                <span className="font-mono text-paper">lexicon export wispr</span> — push the same
                words into the dictation app you already use.
              </p>
            </div>
          </div>
          <Install />
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- open source */

function OpenSource() {
  return (
    <section className="border-t border-rule-soft bg-ink-2/40">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">license</span>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start lg:gap-16">
          <div>
            <h2 className="h2 max-w-[16ch]">MIT, and honest about the edges.</h2>
            <p className="lede mt-6">
              The matcher, the MCP server, the CLI, the extension and the macOS app are all in one
              repository. Your lexicon is a plain YAML file you own — no account, no sync, no audio
              ever leaves your machine.
            </p>

            <div className="mt-9 border-t border-rule-soft pt-7">
              <span className="micro mb-3.5 block">not done yet</span>
              <ul className="flex max-w-[52ch] flex-col gap-2 text-[0.88rem] leading-relaxed text-paper-2">
                <li>
                  The extension installs from the release zip. It is not in the Chrome Web Store or
                  on Firefox Add-ons yet.
                </li>
                <li>The macOS app is ad-hoc signed, not notarized.</li>
                <li>Windows and Linux have the CLI and the MCP server, but no tray app.</li>
                <li>
                  Voice modes that never produce a text box — ChatGPT Voice, Gemini Live — are out
                  of reach. Lexicon reads text, not audio.
                </li>
              </ul>
            </div>

            <div className="mt-9 flex flex-wrap gap-3">
              <a href={REPO} className="btn btn-ghost">
                Read the source
              </a>
              <a href={`${REPO}/blob/main/docs/QUICKSTART.md`} className="btn btn-ghost">
                Quickstart
              </a>
            </div>
          </div>

          <LexiconFile />
        </div>
      </div>
    </section>
  );
}

/*
 * The file itself. The page's whole claim is "one YAML file of your words", and
 * until you have seen one that claim is abstract. Every line below is copied
 * from examples/lexicon.example.yaml, including the aliases, which are real
 * transcriptions.
 */
function LexiconFile() {
  return (
    <figure className="panel m-0 overflow-hidden">
      <figcaption className="panel-head">
        <span className="micro">~/.config/lexicon/lexicon.yaml</span>
        <span className="micro">yaml</span>
      </figcaption>
      <pre className="overflow-x-auto px-5 py-5 font-mono text-[0.76rem] leading-[1.75] sm:text-[0.82rem]">
        <code>
          <Y k="version">1</Y>
          {'\n'}
          <span className="text-paper-3">terms:</span>
          {'\n  - '}
          <Y k="canonical">Ashlr.AI</Y>
          {'\n    '}
          <span className="text-paper-3">aliases:</span>
          {'\n      - '}
          <span className="tok-flagged text-paper-2">Ashler</span>
          {'\n      - '}
          <span className="tok-flagged text-paper-2">Ashlar</span>
          {'\n      - '}
          <span className="tok-flagged text-paper-2">Ashley our AI</span>
          {'\n    '}
          <Y k="phonetic">ASH-ler</Y>
          {'\n    '}
          <Y k="category">brand</Y>
          {'\n    '}
          <span className="text-paper-3">notes: </span>
          <span className="text-paper-2">
            My company. Never write &quot;Ashlar&quot;.
          </span>
          {'\n\n  - '}
          <Y k="canonical">SaaS</Y>
          {'\n    '}
          <span className="text-paper-3">aliases: </span>
          <span className="text-paper-2">[</span>
          <span className="tok-flagged text-paper-2">sass</span>
          <span className="text-paper-2">]</span>
          {'\n    '}
          <Y k="category">acronym</Y>
          {'\n    '}
          <span className="text-paper-3">never: </span>
          <span className="text-paper-2">[sauce]</span>
          <span className="text-paper-3">{'   # a real word. leave it alone.'}</span>
        </code>
      </pre>
    </figure>
  );
}

function Y({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-paper-3">{k}: </span>
      <span className="font-medium text-blue">{children}</span>
    </>
  );
}

/* ------------------------------------------------------------------- footer */

function Footer() {
  return (
    <footer className="border-t border-rule-soft">
      <div className="shell flex flex-col gap-8 py-12">
        <div className="flex flex-wrap items-baseline justify-between gap-6">
          <div className="flex items-baseline gap-2.5">
            <span className="display text-[1.2rem]">Lexicon</span>
            <span className="respell text-[0.75rem]">\LEK-si-kon\</span>
          </div>
          <nav className="flex flex-wrap gap-x-5 gap-y-2 text-[0.85rem]">
            <a className="link-quiet" href={REPO}>
              GitHub
            </a>
            <a className="link-quiet" href={`${REPO}/blob/main/docs/QUICKSTART.md`}>
              Quickstart
            </a>
            <a className="link-quiet" href={`${REPO}/blob/main/docs/CLI.md`}>
              CLI
            </a>
            <a className="link-quiet" href={`${REPO}/blob/main/docs/ARCHITECTURE.md`}>
              Architecture
            </a>
            <a className="link-quiet" href={BENCHMARK}>
              Benchmark
            </a>
            <a className="link-quiet" href={`${REPO}/blob/main/LICENSE`}>
              MIT
            </a>
            <a className="link-quiet" href="https://ashlr.ai">
              Ashlr.AI
            </a>
          </nav>
        </div>

        <p className="max-w-[80ch] text-[0.78rem] leading-relaxed text-paper-3">
          All product names, logos and brands are the property of their respective owners. Their use
          here indicates compatibility only, and does not imply endorsement, sponsorship or
          affiliation. Lexicon is an independent open-source project from Ashlr.AI.
        </p>
      </div>
    </footer>
  );
}
