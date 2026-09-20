'use client';

import { useId, useState } from 'react';
import { CommandLine } from './Copy';

type Method = {
  id: string;
  label: string;
  command: string;
  note: string;
};

const METHODS: Method[] = [
  {
    id: 'script',
    label: 'Script',
    command: 'curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh',
    note: 'Installs the CLI and runs the setup wizard, which writes your first lexicon and registers the MCP server with whichever agent clients it finds.',
  },
  {
    id: 'brew',
    label: 'Homebrew',
    command: 'brew install ashlrai/tap/lexicon',
    note: 'macOS and Linux. Then run lexicon setup to create the lexicon file and connect your agents.',
  },
  {
    id: 'npm',
    label: 'npm',
    command: 'npm i -g @ashlr/lexicon',
    note: 'Node 20 or newer. Then run lexicon setup. The same package is importable as a library if you want to call normalize() yourself.',
  },
];

export function Install() {
  const [active, setActive] = useState(METHODS[0].id);
  const group = useId();
  const method = METHODS.find((m) => m.id === active) ?? METHODS[0];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Installation method"
        className="mb-4 inline-flex rounded-lg border border-rule bg-ink-2 p-1"
      >
        {METHODS.map((m) => {
          const selected = m.id === active;
          return (
            <button
              key={m.id}
              role="tab"
              id={`${group}-${m.id}`}
              aria-selected={selected}
              aria-controls={`${group}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(m.id)}
              onKeyDown={(e) => {
                const i = METHODS.findIndex((x) => x.id === active);
                const next =
                  e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
                if (next === null) return;
                e.preventDefault();
                const target = METHODS[(next + METHODS.length) % METHODS.length];
                setActive(target.id);
                document.getElementById(`${group}-${target.id}`)?.focus();
              }}
              className={`rounded-md px-3.5 py-1.5 text-[0.85rem] font-medium transition-colors ${
                selected ? 'bg-blue text-ink' : 'text-paper-2 hover:text-paper'
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      <div id={`${group}-panel`} role="tabpanel" aria-labelledby={`${group}-${method.id}`}>
        <CommandLine command={method.command} note={method.note} />
      </div>

      <div className="mt-7 border-t border-rule-soft pt-6">
        <p className="micro mb-3">inside claude code</p>
        <div className="flex flex-col gap-2">
          <CommandLine command="claude plugin marketplace add ashlrai/lexicon" />
          <CommandLine
            command="claude plugin install lexicon@ashlrai"
            note="Brings the MCP server, the SessionStart and UserPromptSubmit hooks, the lexicon skill and the /lexicon command. No build step."
          />
        </div>
      </div>
    </div>
  );
}
