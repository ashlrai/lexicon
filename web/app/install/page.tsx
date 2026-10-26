import type { Metadata } from 'next';
import { CommandLine } from '@/components/Copy';
import { Install } from '@/components/Install';
import {
  AGENT_ENDPOINTS,
  ALTERNATE_TYPES,
  CLIENTS,
  DOC,
  DOWNLOADS,
  INSTALL_COMMANDS,
  INSTALL_DESCRIPTION,
  MCP_PROMPTS,
  MCP_RESOURCES,
  MCP_TOOLS,
  PRIMARY_COMMAND,
  PRIMARY_RESULT,
  REPO,
  SITE_URL,
  VERSION,
} from '@/lib/site';

export const revalidate = 3600;

/*
 * `alternates` merges shallowly, so setting this page's canonical here means
 * re-declaring the llms.txt/mcp.json alternates as well; ALTERNATE_TYPES is the
 * same object the layout uses, so the two can never disagree.
 */
export const metadata: Metadata = {
  title: 'Install and capabilities',
  description: INSTALL_DESCRIPTION,
  alternates: {
    canonical: '/install',
    types: ALTERNATE_TYPES,
  },
  openGraph: {
    title: 'Install Lexicon',
    description: INSTALL_DESCRIPTION,
    url: `${SITE_URL}/install`,
    siteName: 'Lexicon',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Install Lexicon',
    description: INSTALL_DESCRIPTION,
  },
};

const PAGE_URL = `${SITE_URL}/install`;

/*
 * This page's own JSON-LD. The home page carries the SoftwareApplication
 * graph; here the markup says "this is the install page for that application":
 * a WebPage about /#software, the breadcrumb that got here, and a HowTo whose
 * steps are the same commands the page shows, so an answer engine can quote
 * them without scraping the markup.
 */
const JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebPage',
      '@id': `${PAGE_URL}#webpage`,
      url: PAGE_URL,
      name: `Install Lexicon ${VERSION}`,
      description: INSTALL_DESCRIPTION,
      isPartOf: { '@id': `${SITE_URL}/#website` },
      about: { '@id': `${SITE_URL}/#software` },
      breadcrumb: { '@id': `${PAGE_URL}#breadcrumb` },
      inLanguage: 'en-US',
    },
    {
      '@type': 'BreadcrumbList',
      '@id': `${PAGE_URL}#breadcrumb`,
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Lexicon', item: SITE_URL },
        { '@type': 'ListItem', position: 2, name: 'Install and capabilities', item: PAGE_URL },
      ],
    },
    {
      '@type': 'HowTo',
      '@id': `${PAGE_URL}#howto`,
      name: 'Install Lexicon and connect it to your agent clients',
      description:
        'Install the Lexicon CLI, let the setup wizard write your lexicon and register the MCP server with your agent clients, then verify the correction works.',
      step: [
        {
          '@type': 'HowToStep',
          position: 1,
          name: 'Install',
          text: `Run: ${PRIMARY_COMMAND}. Alternatives: ${INSTALL_COMMANDS.npx}, ${INSTALL_COMMANDS.brew}, or ${INSTALL_COMMANDS.npm}.`,
          url: `${PAGE_URL}#methods`,
        },
        {
          '@type': 'HowToStep',
          position: 2,
          name: 'Set up',
          text: 'lexicon setup writes ~/.config/lexicon/lexicon.yaml, asks how your names should be spelled, and registers the MCP server with every agent client it finds.',
          url: `${PAGE_URL}#setup`,
        },
        {
          '@type': 'HowToStep',
          position: 3,
          name: 'Verify',
          text: 'lexicon normalize "tell Ashler to ship it" prints "tell Ashlr.AI to ship it"; lexicon doctor checks the files, hooks and registrations.',
          url: `${PAGE_URL}#verify`,
        },
      ],
      tool: { '@id': `${SITE_URL}/#software` },
    },
  ],
});

export default function InstallPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON_LD.replace(/</g, '\\u003c') }}
      />

      <header className="border-b border-rule-soft">
        <div className="shell flex h-14 items-center justify-between gap-4">
          <a href="/" className="flex items-baseline gap-2.5">
            <span className="display text-[1.35rem] leading-none">Lexicon</span>
            <span className="respell hidden text-[0.8rem] leading-none sm:inline">
              \LEK-si-kon\
            </span>
          </a>
          <nav className="flex items-center gap-1 sm:gap-2">
            <a href="/#demo" className="micro px-2 py-1 transition-colors hover:text-paper">
              Demo
            </a>
            <a href="/#faq" className="micro hidden px-2 py-1 transition-colors hover:text-paper sm:inline">
              FAQ
            </a>
            <a
              href={REPO}
              className="micro ml-1 rounded border border-rule px-2.5 py-1 transition-colors hover:border-blue-dim hover:text-blue"
            >
              GitHub
            </a>
          </nav>
        </div>
      </header>

      <main>
        <section className="shell pb-10 pt-14 sm:pt-20">
          <span className="entry-label">install</span>
          <h1 className="display max-w-[18ch] text-[clamp(2.2rem,1.4rem+3.4vw,3.8rem)]">
            Install once. Say it once.
          </h1>
          <p className="lede mt-7 max-w-[52ch]">
            {INSTALL_DESCRIPTION} Lexicon {VERSION} is free, MIT-licensed and local:
            no account, no telemetry, nothing to stand up.
          </p>
        </section>

        <section id="methods" className="border-t border-rule-soft scroll-mt-14">
          <div className="shell py-14 sm:py-20">
            <span className="entry-label">the command</span>
            <h2 className="h2 max-w-[24ch]">One paste on macOS or Linux.</h2>
            <p className="lede mt-6 max-w-[56ch]">{PRIMARY_RESULT}</p>
            <div className="mt-9 max-w-[42rem]">
              <CommandLine command={PRIMARY_COMMAND} />
            </div>
            <div className="mt-10 max-w-[42rem]">
              <Install />
            </div>
          </div>
        </section>

        <section id="setup" className="border-t border-rule-soft bg-ink-2/40 scroll-mt-14">
          <div className="shell py-14 sm:py-20">
            <span className="entry-label">what setup writes</span>
            <h2 className="h2 max-w-[24ch]">Everything it writes is a file you own.</h2>
            <ol className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[
                ['the lexicon', '~/.config/lexicon/lexicon.yaml, a plain YAML file you own'],
                ['your names', 'your own name and company, plus the misspellings a recognizer is likely to produce'],
                ['starter packs', '176 curated terms across developer, ai, business and voice-tools, opt-in'],
                ['your repo', 'proper nouns harvested from the repository you are standing in, opt-in'],
                ['your clients', 'the MCP server registered in every agent client it detects, hooks included for Claude Code'],
                ['your dictation app', 'optional export into Wispr Flow, Superwhisper or macOS Text Replacement'],
              ].map(([label, body]) => (
                <li key={label} className="panel m-0 p-5">
                  <span className="micro">{label}</span>
                  <p className="mt-2.5 text-[0.88rem] leading-relaxed text-paper-2">{body}</p>
                </li>
              ))}
            </ol>
            <p className="mt-8 max-w-[56ch] text-[0.88rem] leading-relaxed text-paper-3">
              Every step is safe to rerun and nothing is duplicated. Non-interactive:
              {' '}<code className="font-mono text-paper-2">lexicon setup --yes</code> with
              {' '}<code className="font-mono text-paper-2">--dry-run</code> to see the plan first.
              The full walkthrough is{' '}
              <a className="link-accent" href={DOC('docs/QUICKSTART.md')}>docs/QUICKSTART.md</a>.
            </p>
          </div>
        </section>

        <section id="capabilities" className="border-t border-rule-soft scroll-mt-14">
          <div className="shell py-14 sm:py-20">
            <span className="entry-label">capabilities</span>
            <h2 className="h2 max-w-[24ch]">What an install gives you.</h2>
            <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              <Capability
                label="mcp server"
                title={`${MCP_TOOLS.length} tools, ${MCP_RESOURCES.length} resources, ${MCP_PROMPTS.length} prompts`}
                body="stdio server named lexicon. Normalizes transcripts, adds terms, learns corrections, runs setup and doctor over MCP."
                href={DOC('docs/MCP.md')}
              />
              <Capability
                label="agent clients"
                title={`${CLIENTS.length} clients auto-configured`}
                body={`lexicon install <client> --apply writes each client's own config file: ${CLIENTS.join(', ')}.`}
                href={DOC('docs/CLIENTS.md')}
              />
              <Capability
                label="browser"
                title="Seven chat sites, any site opt-in"
                body="The extension rewrites the composer in place on ChatGPT, Claude, Gemini, Grok, Perplexity, Copilot and Poe."
                href={DOC('docs/EXTENSION.md')}
              />
              <Capability
                label="macos"
                title="Any focused text field"
                body="The menu bar app rewrites dictated text wherever the cursor is, through the Accessibility API."
                href={DOC('docs/MACOS-APP.md')}
              />
              <Capability
                label="loopback api"
                title="127.0.0.1:41733"
                body="A local HTTP API for your own scripts and shortcuts, bearer-token gated, off by default."
                href={DOC('docs/LOCAL-API.md')}
              />
              <Capability
                label="cli"
                title="The same matcher in a terminal"
                body="normalize, add, learn, doctor, stats, export, import, setup. Everything the surfaces do is a command."
                href={DOC('docs/CLI.md')}
              />
            </div>

            <div className="mt-12 border-t border-rule-soft pt-10">
              <h3 className="display text-[1.35rem]">Downloads</h3>
              <ul className="mt-5 flex max-w-[60ch] flex-col gap-2.5 text-[0.88rem] leading-relaxed text-paper-2">
                {DOWNLOADS.map((d) => (
                  <li key={d.href}>
                    <a className="link-accent font-medium" href={d.href}>{d.label}</a>
                    <span className="text-paper-3"> {d.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section id="endpoints" className="border-t border-rule-soft bg-ink-2/40 scroll-mt-14">
          <div className="shell py-14 sm:py-20">
            <span className="entry-label">for machines</span>
            <h2 className="h2 max-w-[24ch]">Everything above, machine-readable.</h2>
            <p className="lede mt-6 max-w-[52ch]">
              If you are an agent, you do not need this page rendered. Fetch any of these
              instead; they are static JSON or text, CORS-open and built from the same
              source constants as the page.
            </p>
            <dl className="mt-9 grid gap-6 md:grid-cols-2">
              {AGENT_ENDPOINTS.filter((e) => e.path !== '/install').map((e) => (
                <div key={e.path}>
                  <dt>
                    <a className="link-accent font-mono text-[0.95rem]" href={e.path}>
                      {e.title}
                    </a>
                  </dt>
                  <dd className="mt-1.5 max-w-[54ch] text-[0.88rem] leading-relaxed text-paper-2">
                    {e.blurb}
                  </dd>
                </div>
              ))}
              <div>
                <dt>
                  <a className="link-accent font-mono text-[0.95rem]" href="/.well-known/mcp/server.json">
                    /.well-known/mcp/server.json
                  </a>
                </dt>
                <dd className="mt-1.5 max-w-[54ch] text-[0.88rem] leading-relaxed text-paper-2">
                  The same registry manifest at its well-known address.
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section id="verify" className="border-t border-rule-soft scroll-mt-14">
          <div className="shell py-14 sm:py-20">
            <span className="entry-label">verify</span>
            <h2 className="h2 max-w-[24ch]">Do not trust the install. Check it.</h2>
            <div className="mt-9 grid gap-4 lg:grid-cols-2">
              <div className="panel m-0 overflow-hidden">
                <div className="panel-head"><span className="micro">the one-line proof</span></div>
                <div className="p-5">
                  <CommandLine
                    command='lexicon normalize "tell Ashler to ship it"'
                    note='Expected output: "tell Ashlr.AI to ship it".'
                  />
                </div>
              </div>
              <div className="panel m-0 overflow-hidden">
                <div className="panel-head"><span className="micro">the full check</span></div>
                <div className="flex flex-col gap-3 p-5">
                  <CommandLine command="lexicon doctor" note="Files, hooks, MCP registration, clipboard, whisper." />
                  <p className="text-[0.85rem] leading-relaxed text-paper-3">
                    Something off? <code className="font-mono text-paper-2">lexicon doctor --fix</code>{' '}
                    repairs the common cases; over MCP the same check is{' '}
                    <code className="font-mono text-paper-2">lexicon_doctor</code>.
                  </p>
                </div>
              </div>
            </div>
            <p className="mt-9 text-[0.9rem]">
              <a className="link-accent" href="/">
                Back to lexicon.ashlr.ai
              </a>
            </p>
          </div>
        </section>
      </main>
    </>
  );
}

function Capability({
  label,
  title,
  body,
  href,
}: {
  label: string;
  title: string;
  body: string;
  href: string;
}) {
  return (
    <a href={href} className="panel group m-0 flex flex-col p-5 transition-colors hover:border-blue-dim">
      <span className="micro">{label}</span>
      <h3 className="display mt-2.5 text-[1.2rem] leading-snug group-hover:text-blue">{title}</h3>
      <p className="mt-2.5 text-[0.88rem] leading-relaxed text-paper-2">{body}</p>
    </a>
  );
}
