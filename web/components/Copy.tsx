'use client';

import { useEffect, useRef, useState } from 'react';

type State = 'idle' | 'copied' | 'manual';

/**
 * Copy with two fallbacks, because a copy button that silently does nothing is
 * worse than no button: the async Clipboard API first, then a hidden textarea
 * and execCommand, and if a permissions policy blocks both, the command text is
 * selected in place and the button says which keys to press. Some browsers and
 * embedded webviews refuse programmatic clipboard writes outright.
 */
export function CopyButton({
  value,
  target,
}: {
  value: string;
  /** Selected in place when the clipboard is unavailable, so ⌘C still works. */
  target?: React.RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState<State>('idle');
  const [mac, setMac] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    return () => clearTimeout(timer.current);
  }, []);

  const flash = (next: State) => {
    setState(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2400);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      flash('copied');
      return;
    } catch {
      /* fall through */
    }

    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', '');
    el.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
    document.body.appendChild(el);
    el.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    el.remove();
    if (ok) {
      flash('copied');
      return;
    }

    // Both routes refused. Select the command where it sits so the keyboard works.
    const node = target?.current;
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    flash('manual');
  };

  const label =
    state === 'copied' ? 'Copied' : state === 'manual' ? `Press ${mac ? '⌘C' : 'Ctrl+C'}` : 'Copy';

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy: ${value}`}
      className="micro flex-none whitespace-nowrap rounded border border-rule px-2 py-1 transition-colors hover:border-blue-dim hover:text-blue"
    >
      <span aria-live="polite">{label}</span>
    </button>
  );
}

export function CommandLine({ command, note }: { command: string; note?: string }) {
  const code = useRef<HTMLElement>(null);
  return (
    <div>
      <div className="flex items-center gap-2 rounded-md border border-rule bg-ink-3 py-2.5 pl-4 pr-2.5">
        <span aria-hidden="true" className="select-none font-mono text-[0.82rem] text-paper-3 sm:text-[0.86rem]">
          $
        </span>
        <code
          ref={code}
          className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[0.82rem] leading-relaxed text-paper [overflow-wrap:anywhere] sm:text-[0.86rem]"
        >
          {command}
        </code>
        <CopyButton value={command} target={code} />
      </div>
      {note ? <p className="mt-2.5 text-[0.82rem] leading-relaxed text-paper-3">{note}</p> : null}
    </div>
  );
}
