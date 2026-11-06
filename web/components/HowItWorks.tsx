'use client';

import { useState } from 'react';

/**
 * The three matchers, as buttons. Each example is a span the CLI actually
 * corrects against the built-in sample: alias at 1.00, phonetic at 0.88 on
 * stderr, fuzzy at 0.91. Clicking one shows that pair. Nothing is fetched.
 */
const TIERS = [
  {
    id: 'alias',
    label: 'Alias',
    detail: 'The spelling is one you listed.',
    heard: 'ashler',
    fix: 'Ashlr.AI',
    note: 'alias, 1.00',
  },
  {
    id: 'phonetic',
    label: 'Phonetic',
    detail: 'It sounds the same, even if you never wrote this mistake down.',
    heard: 'kuber netties',
    fix: 'Kubernetes',
    note: 'phonetic, 0.88',
  },
  {
    id: 'fuzzy',
    label: 'Fuzzy',
    detail: 'It is spelled almost the same, above the confidence floor.',
    heard: 'kubernetees',
    fix: 'Kubernetes',
    note: 'fuzzy, 0.91',
  },
] as const;

type TierId = (typeof TIERS)[number]['id'];

const STEPS = ['You speak', 'Speech-to-text writes', 'Lexicon rewrites', 'The agent reads'] as const;

export function HowItWorks() {
  const [active, setActive] = useState<TierId>('alias');
  const tier = TIERS.find((item) => item.id === active) ?? TIERS[0];

  return (
    <section id="how" className="scroll-mt-14 border-t border-rule-soft">
      <div className="shell py-16 sm:py-24">
        <span className="entry-label">how it works</span>
        <h2 className="h2 max-w-[22ch]">It sits between the transcript and the agent.</h2>
        <ol className="mt-8 grid gap-3 sm:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step} className="panel px-4 py-4">
              <span className="micro">{index + 1}</span>
              <p className="mt-2 text-sm text-paper">{step}</p>
            </li>
          ))}
        </ol>

        <div className="mt-8 flex flex-wrap gap-2" role="group" aria-label="Matcher tiers">
          {TIERS.map((item) => {
            const on = item.id === tier.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={on}
                onClick={() => setActive(item.id)}
                className={on ? 'btn btn-primary' : 'btn btn-ghost'}
              >
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="panel mt-4 px-5 py-6 sm:px-7">
          <p className="text-sm text-paper-2">{tier.detail}</p>
          <p className="mt-4 font-mono text-lg leading-relaxed">
            <span className="tok-flagged">{tier.heard}</span>
            <span className="text-paper-3"> becomes </span>
            <span className="text-blue">{tier.fix}</span>
          </p>
          <p className="mt-3 font-mono text-xs text-paper-3">{tier.note}</p>
        </div>
      </div>
    </section>
  );
}
