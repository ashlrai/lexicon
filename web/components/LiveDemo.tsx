'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addTerm,
  loadCore,
  makeTerm,
  segment,
  type Core,
  type Lexicon,
  type NormalizeResult,
} from '@/lib/demo';

const PREFILL = 'ping ashler about the cuban eats rollout on versal';

const EXAMPLES = [
  'ping ashler about the cuban eats rollout on versal',
  'ask and tropic whether clawed code can read the superbase schema',
  'the pie dantic models need a new post gress migration before we ship',
];

export function LiveDemo() {
  const [core, setCore] = useState<Core | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState(PREFILL);
  const [extra, setExtra] = useState<Lexicon | null>(null);
  const host = useRef<HTMLDivElement>(null);

  /* Load the matcher only once the demo is close to the viewport. */
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let done = false;
    const start = () => {
      if (done) return;
      done = true;
      loadCore().then(setCore, () => setFailed(true));
    };
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && start(),
      { rootMargin: '400px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const lexicon = extra ?? core?.lexicon ?? null;
  const result: NormalizeResult | null = useMemo(() => {
    if (!core || !lexicon) return null;
    try {
      return core.normalize(text, lexicon);
    } catch {
      return null;
    }
  }, [core, lexicon, text]);

  return (
    <div ref={host} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start lg:gap-5">
      <div className="panel overflow-hidden">
        <div className="panel-head">
          <label htmlFor="demo-input" className="micro">
            what speech-to-text wrote
          </label>
          <div className="flex gap-1.5">
            {EXAMPLES.map((ex, i) => (
              <button
                key={ex}
                type="button"
                onClick={() => setText(ex)}
                aria-label={`Load example ${i + 1}`}
                className="micro rounded border border-rule px-2 py-0.5 transition-colors hover:border-blue-dim hover:text-blue"
              >
                {i + 1}
              </button>
            ))}
          </div>
        </div>

        <textarea
          id="demo-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={3}
          placeholder="Dictate or paste a sentence…"
          className="block w-full resize-y bg-ink-3 px-5 py-4 font-mono text-[0.95rem] leading-relaxed text-paper outline-none placeholder:text-paper-3 sm:text-base"
        />

        <div className="border-t border-rule px-5 py-4">
          <span className="micro mb-2.5 block">what your agent receives</span>
          <p className="min-h-[3.25rem] font-mono text-[0.95rem] leading-[1.9] sm:text-base">
            {!core && !failed ? (
              <span className="text-paper-3">Loading the matcher…</span>
            ) : failed ? (
              <span className="text-paper-2">
                The demo bundle did not load. The same matcher runs offline.{' '}
                <a className="link-accent" href="#install">
                  install the CLI
                </a>{' '}
                and try <code>lexicon fix</code>.
              </span>
            ) : result && result.replacements.length > 0 ? (
              segment(result).map((seg, i) =>
                seg.kind === 'text' ? (
                  <span key={i} className="text-paper-2">
                    {seg.text}
                  </span>
                ) : (
                  <mark
                    key={i}
                    className="rounded-[3px] bg-blue-dim px-[0.2em] py-[0.08em] font-medium text-blue"
                  >
                    {seg.text}
                  </mark>
                ),
              )
            ) : (
              <span className="text-paper-2">{text || ' '}</span>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:gap-5">
        <Replacements core={core} result={result} />
        <OwnName core={core} onAdd={(lex) => setExtra(lex)} />
      </div>
    </div>
  );
}

function Replacements({ core, result }: { core: Core | null; result: NormalizeResult | null }) {
  const rows = result?.replacements ?? [];
  return (
    <div className="panel overflow-hidden">
      <div className="panel-head">
        <span className="micro">replacements</span>
        <span className="micro">{core ? `${core.lexicon.terms.length} terms loaded` : '—'}</span>
      </div>
      <div className="px-4 py-3">
        {rows.length === 0 ? (
          <p className="py-2 text-sm text-paper-3">
            {result ? 'Nothing matched. Ordinary prose is left alone.' : 'Waiting for input.'}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-rule-soft">
            {rows.map((r, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2 first:pt-0.5">
                <span className="min-w-0 font-mono text-[0.8rem]">
                  <span className="text-paper-3 line-through decoration-flag/60">{r.original}</span>
                  <span className="mx-1.5 text-paper-3">→</span>
                  <span className="font-medium text-paper">{r.replacement}</span>
                </span>
                <span className="micro flex-none tabular-nums" title="match reason and confidence">
                  {r.reason} {r.confidence.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="border-t border-rule px-4 py-2.5 text-[0.7rem] leading-relaxed text-paper-3">
        Runs entirely in your browser. The matcher is compiled from the same{' '}
        <code className="font-mono">src/core</code> the CLI uses; nothing you type leaves the page.
        {core ? ` Confidence floor ${core.minConfidence.toFixed(2)}.` : ''}
      </p>
    </div>
  );
}

function OwnName({ core, onAdd }: { core: Core | null; onAdd: (lex: Lexicon) => void }) {
  const [name, setName] = useState('');
  const aliases = useMemo(() => {
    if (!core || name.trim().length < 2) return [];
    return core.suggestAliases(name.trim());
  }, [core, name]);
  const [added, setAdded] = useState<string | null>(null);

  return (
    <div className="panel overflow-hidden">
      <div className="panel-head">
        <label htmlFor="own-name" className="micro">
          try your own name
        </label>
      </div>
      <div className="px-4 py-4">
        <input
          id="own-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setAdded(null);
          }}
          placeholder="Ashlr.AI"
          spellCheck={false}
          autoComplete="off"
          className="mb-3 block w-full rounded-md border border-rule bg-ink-3 px-3 py-2 font-mono text-[0.85rem] text-paper outline-none transition-colors placeholder:text-paper-3 focus:border-blue-dim"
        />
        {aliases.length > 0 ? (
          <>
            <p className="micro mb-2">spellings to expect</p>
            <ul className="mb-3 flex flex-wrap gap-1.5">
              {aliases.map((a) => (
                <li
                  key={a}
                  className="rounded border border-rule bg-ink-3 px-1.5 py-0.5 font-mono text-[0.75rem] text-paper-2"
                >
                  {a}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-ghost h-9 w-full text-[0.85rem]"
              onClick={() => {
                if (!core) return;
                onAdd(addTerm(core.lexicon, makeTerm(name, aliases)));
                setAdded(name.trim());
              }}
            >
              {added === name.trim() ? 'Added to the demo lexicon' : 'Add to the demo lexicon'}
            </button>
          </>
        ) : (
          <p className="text-[0.78rem] leading-relaxed text-paper-3">
            {name.trim().length > 0 && core
              ? 'No likely mis-spellings for that one; speech-to-text probably gets it right already.'
              : 'Type a brand, product or surname. Lexicon guesses the spellings a recognizer will produce, then you add it once.'}
          </p>
        )}
      </div>
    </div>
  );
}
