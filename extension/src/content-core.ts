/**
 * The composer guard. Pure DOM + an injected `send` channel, so tests drive
 * it with jsdom and a fake background.
 *
 * Send path: Enter (no Shift) in the composer or a click on the send button
 * is intercepted in the capture phase, the text is normalized by the
 * background, corrections are written back, a toast lists them, then the
 * original action is re-dispatched. Text the background already vetted as
 * unchanged (precheck cache, refreshed on input) passes through untouched.
 */
import {
  adapterFor,
  composerFromTarget,
  findComposer,
  findSendButton,
  sendButtonFromTarget,
} from './adapters.js';
import type { SiteAdapter } from './adapters.js';
import { applyCorrections, caretOffset, invertCorrections, performEnterDefault, readText, setCaret } from './editable.js';
import { incompleteNotice, LIVE_DEBOUNCE_MS, PRECHECK_DEBOUNCE_MS } from './shared.js';
import type { Correction, NormalizeReply, Request } from './shared.js';
import { removeToast, showToast } from './toast.js';

export interface ContentSettings {
  enabled: boolean;
  live: boolean;
}

export interface ContentDeps {
  doc: Document;
  hostname: string;
  send(req: Request): Promise<NormalizeReply>;
  settings: ContentSettings;
  /** Optional: overrides for tests. */
  liveDebounceMs?: number;
  precheckDebounceMs?: number;
  toastMs?: number;
  adapter?: SiteAdapter;
}

export interface ContentHandle {
  adapter: SiteAdapter;
  settings: ContentSettings;
  update(patch: Partial<ContentSettings>): void;
  /** Resolves when the in-flight send (if any) has finished. */
  idle(): Promise<void>;
  destroy(): void;
}

interface Precheck {
  text: string;
  changed: boolean;
}

export function installContent(deps: ContentDeps): ContentHandle {
  const { doc } = deps;
  const win = doc.defaultView;
  const adapter = deps.adapter ?? adapterFor(deps.hostname);
  const settings: ContentSettings = { ...deps.settings };
  const liveMs = deps.liveDebounceMs ?? LIVE_DEBOUNCE_MS;
  const precheckMs = deps.precheckDebounceMs ?? PRECHECK_DEBOUNCE_MS;

  let passthrough = false;
  let busy: Promise<void> | null = null;
  let precheck: Precheck | null = null;
  let precheckTimer: number | undefined;
  let liveTimer: number | undefined;
  let liveInFlight = false;
  /** True while Undo writes the original wording back: its own input events are not the user typing. */
  let restoring = false;

  const setTimer = (fn: () => void, ms: number): number | undefined => win?.setTimeout(fn, ms);
  const clearTimer = (id: number | undefined): void => {
    if (id !== undefined) win?.clearTimeout(id);
  };

  // ---- normalization -----------------------------------------------------

  async function normalizeText(text: string, dryRun: boolean): Promise<NormalizeReply> {
    try {
      return await deps.send({ type: 'normalize', text, dryRun });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * `rewritten` is what the composer held right after the rewrite: the reply's
   * output on send, but in live mode the corrected prefix plus the untouched
   * text after the caret. Comparing with `reply.output` alone made Undo do
   * nothing after a live rewrite that had text after the caret.
   */
  function toastFor(composer: HTMLElement, original: string, corrections: Correction[], reply: NormalizeReply, rewritten?: string): void {
    if (!reply.ok) return;
    const expected = rewritten ?? reply.output;
    showToast(doc, corrections, {
      mode: reply.mode,
      durationMs: deps.toastMs,
      ...(reply.incomplete ? { notice: incompleteNotice(reply.incomplete) } : {}),
      ...(reply.fallback ? { fallback: reply.fallback } : {}),
      onUndo: () => {
        const current = readText(composer);
        let restore: readonly Correction[];
        if (current === expected) {
          restore = invertCorrections(corrections);
        } else if (current.trim() === '') {
          // Already sent: put the original wording back so the user can
          // resend it as dictated.
          restore = [];
        } else {
          // The composer now holds something else (an edit, or the next
          // message): restoring the old text would destroy it.
          return;
        }
        // The restore fires input events. Taken as typing, they cleared the
        // precheck and scheduled a new check, so live mode corrected the
        // restored text straight back and the next Enter corrected it again.
        clearTimer(precheckTimer);
        clearTimer(liveTimer);
        restoring = true;
        precheck = { text: original, changed: false };
        void applyCorrections(doc, composer, restore, original).finally(() => {
          restoring = false;
          precheck = { text: readText(composer), changed: false };
        });
      },
    });
  }

  /** Normalize the composer, rewrite it when needed, then run `resend`. */
  async function correctThen(composer: HTMLElement, text: string, resend: () => void): Promise<void> {
    const reply = await normalizeText(text, false);
    if (reply.ok && reply.changed && reply.replacements.length > 0) {
      // The composer may have moved on while we waited (fast typist, voice
      // input still streaming). Only rewrite when it still holds `text`.
      if (readText(composer) === text) {
        await applyCorrections(doc, composer, reply.replacements, reply.output);
        precheck = { text: reply.output, changed: false };
        toastFor(composer, text, reply.replacements, reply);
      }
    } else if (reply.ok) {
      precheck = { text, changed: false };
      // Nothing to fix in the part that was checked, but the rest was not
      // looked at: say so rather than let it pass as clean.
      if (reply.incomplete) showToast(doc, [], { mode: reply.mode, durationMs: deps.toastMs, notice: incompleteNotice(reply.incomplete), ...(reply.fallback ? { fallback: reply.fallback } : {}) });
    }
    resend();
  }

  function withPassthrough(fn: () => void): void {
    passthrough = true;
    try {
      fn();
    } finally {
      passthrough = false;
    }
  }

  function guard(run: () => Promise<void>): void {
    const p: Promise<void> = run()
      .catch(() => undefined)
      .then(() => {
        if (busy === p) busy = null;
      });
    busy = p;
  }

  // ---- send interception -------------------------------------------------

  function shouldSkip(text: string): boolean {
    if (!text.trim()) return true;
    return precheck !== null && precheck.text === text && !precheck.changed;
  }

  function onKeydown(ev: KeyboardEvent): void {
    if (passthrough || !settings.enabled) return;
    if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing || ev.keyCode === 229) return;
    if (ev.defaultPrevented) return;
    const composer = composerFromTarget(ev.target, adapter);
    if (!composer) return;
    const text = readText(composer);
    if (shouldSkip(text)) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    const init: KeyboardEventInit = {
      key: ev.key,
      code: ev.code || 'Enter',
      keyCode: 13,
      which: 13,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      altKey: ev.altKey,
      shiftKey: false,
      bubbles: true,
      cancelable: true,
      composed: true,
    } as KeyboardEventInit;

    guard(() =>
      correctThen(composer, text, () => {
        withPassthrough(() => {
          if (!composer.dispatchEvent(new KeyboardEvent('keydown', init))) return;
          // Nobody consumed the synthetic Enter; fall back to the button.
          const button = findSendButton(doc, adapter, composer);
          if (button) {
            button.click();
            return;
          }
          // A known site sends through its button only; anywhere else the
          // press is ours to finish. A script-dispatched keydown has no
          // default action, so without this a textarea lost its newline and
          // a search box never submitted. Sites that listen for keypress
          // get that first, as they would from a real Enter.
          if (adapter.send || ev.ctrlKey || ev.metaKey || ev.altKey) return;
          if (!composer.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: 13 } as KeyboardEventInit))) return;
          performEnterDefault(doc, composer);
        });
      }),
    );
  }

  function onClick(ev: MouseEvent): void {
    if (passthrough || !settings.enabled) return;
    const button = sendButtonFromTarget(ev.target, adapter);
    if (!button) return;
    const composer = findComposer(doc, adapter);
    if (!composer) return;
    const text = readText(composer);
    if (shouldSkip(text)) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    guard(() =>
      correctThen(composer, text, () => {
        withPassthrough(() => button.click());
      }),
    );
  }

  // ---- typing: precheck cache and live mode -------------------------------

  function schedulePrecheck(composer: HTMLElement): void {
    clearTimer(precheckTimer);
    precheckTimer = setTimer(() => {
      const text = readText(composer);
      if (!text.trim()) return;
      void normalizeText(text, true).then((reply) => {
        // A dry run reports `changed: false` by design (nothing was applied),
        // so the replacements list is what says whether Enter must be intercepted.
        // A check that stopped early is intercepted too, so the send can say so.
        if (reply.ok && readText(composer) === text) {
          precheck = { text, changed: reply.changed || reply.replacements.length > 0 || reply.incomplete !== undefined };
        }
      });
    }, precheckMs);
  }

  function scheduleLive(composer: HTMLElement): void {
    clearTimer(liveTimer);
    liveTimer = setTimer(() => {
      if (liveInFlight) return;
      const full = readText(composer);
      const caret = caretOffset(doc, composer);
      const prefix = full.slice(0, caret);
      if (!prefix.trim()) return;
      liveInFlight = true;
      void normalizeText(prefix, false)
        .then(async (reply) => {
          if (!reply.ok || !reply.changed || reply.replacements.length === 0) return;
          if (readText(composer) !== full) return;
          const output = reply.output + full.slice(caret);
          await applyCorrections(doc, composer, reply.replacements, output);
          // Put the caret back where the user was typing, shifted by what
          // the corrections changed before it.
          if (composer === doc.activeElement || composer.contains(doc.activeElement)) setCaret(doc, composer, reply.output.length);
          precheck = null;
          toastFor(composer, full, reply.replacements, reply, output);
        })
        .finally(() => {
          liveInFlight = false;
        });
    }, liveMs);
  }

  function onInput(ev: Event): void {
    if (passthrough || restoring || !settings.enabled) return;
    const composer = composerFromTarget(ev.target, adapter);
    if (!composer) return;
    precheck = null;
    schedulePrecheck(composer);
    if (settings.live) scheduleLive(composer);
  }

  doc.addEventListener('keydown', onKeydown, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('input', onInput, true);

  return {
    adapter,
    settings,
    update(patch) {
      Object.assign(settings, patch);
      if (!settings.enabled) removeToast(doc);
    },
    idle: async () => {
      while (busy) await busy;
    },
    destroy() {
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('input', onInput, true);
      clearTimer(precheckTimer);
      clearTimer(liveTimer);
      removeToast(doc);
    },
  };
}
