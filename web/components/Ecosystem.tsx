import { REPO } from '@/lib/site';

/*
 * Mirrors the README's "Part of the Ashlr.AI ecosystem" section and the
 * ECOSYSTEM block in lib/llms.ts, so the page, the repo and /llms.txt tell the
 * same story. Only Locus and ashlr-md are linked: they are the companions
 * `lexicon doctor` actually reads (DOCTOR_COMPANIONS in src/cli/companions.ts).
 */
const REPOS: { name: string; href?: string; role: string; self?: boolean }[] = [
  { name: 'Phantom', role: 'The agent-run software factory the rest of the ecosystem serves.' },
  {
    name: 'phantom-secrets',
    role: 'phantom exec gives an agent phm_ placeholders instead of real provider keys. Lexicon needs no key and runs unchanged under it.',
  },
  { name: 'ashlr-plugin', role: 'The Claude Code plugin for agent tooling.' },
  { name: 'Locus', href: 'https://github.com/ashlrai/locus', role: 'Identity and tenant pinning for agents.' },
  {
    name: 'lexicon',
    href: REPO,
    role: 'This project: canonical spellings for what speech-to-text writes, fixed before an agent reads it.',
    self: true,
  },
  { name: 'ashlr-md', href: 'https://github.com/ashlrai/ashlr-md', role: 'Ships mdopener-mcp.' },
  { name: 'ashlr-stack', role: 'The stack CLI; it owns the shared handshake contract.' },
];

export function Ecosystem() {
  return (
    <section id="ecosystem" className="scroll-mt-14 border-t border-rule-soft">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">ecosystem</span>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:items-start lg:gap-16">
          <div>
            <h2 className="h2 max-w-[20ch]">The voice layer of an agent-run software factory.</h2>
            <p className="lede mt-6">
              Phantom and its ecosystem form a fully autonomous, code-first, agent-native software
              factory, run by agents with the human as a passive board member, chasing open source
              RSI (recursive self improvement). Lexicon makes sure the names that human dictates
              reach those agents spelled right.
            </p>
            <p className="mt-6 max-w-[56ch] text-[0.92rem] leading-relaxed text-paper-2">
              Lexicon runs without any of the others.{' '}
              <span className="font-mono text-paper">lexicon doctor</span> asks{' '}
              <span className="font-mono text-paper">locus</span> and{' '}
              <span className="font-mono text-paper">mdopener-mcp</span> for{' '}
              <span className="font-mono text-paper">--ashlr-handshake --json</span> and reports one
              info line for each; a missing companion is not an error.
            </p>
            <p className="mt-6 max-w-[56ch] text-[0.92rem] leading-relaxed text-paper-2">
              Agents write and ship this code. To change it, read{' '}
              <a className="link-accent" href={`${REPO}/blob/main/AGENTS.md`}>
                AGENTS.md
              </a>
              , then{' '}
              <a className="link-accent" href={`${REPO}/blob/main/CLAUDE.md`}>
                CLAUDE.md
              </a>
              . Contributors and their agents follow the same path:{' '}
              <a className="link-accent" href={`${REPO}/blob/main/CONTRIBUTING.md#contribute-with-an-agent`}>
                contribute with an agent
              </a>
              .
            </p>
          </div>

          <dl className="panel m-0 flex flex-col divide-y divide-rule-soft">
            {REPOS.map((r) => (
              <div key={r.name} className="px-5 py-4">
                <dt className={`font-mono text-[0.9rem] ${r.self ? 'text-blue' : 'text-paper'}`}>
                  {r.href ? (
                    <a className={r.self ? 'link-accent' : 'link-quiet'} href={r.href}>
                      {r.name}
                    </a>
                  ) : (
                    r.name
                  )}
                </dt>
                <dd className="mt-1 text-[0.85rem] leading-relaxed text-paper-2">{r.role}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
