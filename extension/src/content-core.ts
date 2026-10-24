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
  deepActiveElement,
  eventOrigin,
  findComposer,
  findSendButton,
  isTextField,
  sendButtonFromTarget,
} from './adapters.js';
import type { SiteAdapter } from './adapters.js';
import { applyCorrections, caretOffset, codeRanges, composerTooLarge, invertCorrections, maskCode, performEnterDefault, readText, setCaret, snapshot } from './editable.js';
import { incompleteNotice, LIVE_DEBOUNCE_MS, PRECHECK_DEBOUNCE_MS } from './shared.js';
import type { Correction, NormalizeReply, Request } from './shared.js';
import { removeToast, showToast } from './toast.js';

/** The toast line when a known site took neither the replayed Enter nor a send-button click. */
export const NOT_SENT_NOTICE = 'Not sent: this site ignored the replayed Enter and its send button was not found. Press Enter again to send.';

/** The toast line when Enter or the send button is pressed on a composer over MAX_COMPOSER_CHARS. */
export const TOO_LARGE_NOTICE = 'Not checked: this message is over the 1 MB a lexicon check takes, so it was left as typed.';

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
  /** True between compositionstart and compositionend: an IME owns the text being typed. */
  let composing = false;
  /**
   * Whether this page acts on a script-dispatched Enter in the composer:
   * `works` once one was cancelled (taken by the page) or the page cancelled
   * a real Enter the guard let through, `fails` once one was not taken while
   * no send button matched. A known site whose button selector no longer
   * matches is sent to only through that Enter, so until it is known to
   * work there the guard lets the user's own Enter through rather than
   * swallow a send it may not be able to replay.
   */
  let enterReplay: 'unknown' | 'works' | 'fails' = 'unknown';

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
   * `normalizeText` for the text of `composer`, leaving its code alone: the
   * characters inside `<pre>`, `<code>` or a code editor (codeRanges) go to
   * the engine masked (maskCode), so the prose around them is still
   * corrected, no code word is matched or counted as a hit, and the reply's
   * `output` is rebuilt from `text` itself. `text` must be what `composer`
   * held when this is called, or a prefix of it.
   */
  async function normalizeComposer(composer: HTMLElement, text: string, dryRun: boolean, codeAt?: Array<[number, number]>): Promise<NormalizeReply> {
    const ranges = (codeAt ?? codeRanges(composer)).filter(([start]) => start < text.length);
    if (ranges.length === 0) return normalizeText(text, dryRun);
    const reply = await normalizeText(maskCode(text, ranges), dryRun);
    if (!reply.ok) return reply;
    const replacements = reply.replacements.filter((r) => !ranges.some(([start, end]) => r.start < end && r.end > start));
    let output = text;
    for (const r of [...replacements].sort((a, b) => b.start - a.start)) output = output.slice(0, r.start) + r.replacement + output.slice(r.end);
    return { ...reply, input: text, output, replacements, changed: reply.changed && replacements.length > 0 };
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

  /** `offset` in the text after `corrections`: moved by each one wholly before it, to the end of one it falls inside. */
  function shiftOffset(offset: number, corrections: readonly Correction[]): number {
    let shift = 0;
    for (const c of [...corrections].sort((a, b) => a.start - b.start)) {
      if (c.end <= offset) shift += c.replacement.length - (c.end - c.start);
      else if (c.start < offset) return c.start + shift + c.replacement.length;
    }
    return offset + shift;
  }

  /** Normalize the composer, rewrite it when needed, then run `resend`. */
  async function correctThen(composer: HTMLElement, text: string, resend: () => void, codeAt?: Array<[number, number]>): Promise<void> {
    const reply = await normalizeComposer(composer, text, false, codeAt);
    if (reply.ok && reply.changed && reply.replacements.length > 0) {
      // The composer may have moved on while we waited (fast typist, voice
      // input still streaming). Only rewrite when it still holds `text`.
      if (readText(composer) === text) {
        // A rich text box keeps the selection where the last (first in the
        // text) replacement left it, so the line break a generic site's Enter
        // then inserts landed mid-text. Put the caret back where it was,
        // shifted by the corrections before it. A text field keeps its own.
        const active = deepActiveElement(doc);
        const focused = !isTextField(composer) && (composer === active || composer.contains(active));
        const caret = focused ? caretOffset(doc, composer) : undefined;
        await applyCorrections(doc, composer, reply.replacements, reply.output);
        if (caret !== undefined) setCaret(doc, composer, shiftOffset(caret, reply.replacements));
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

  /** Says, without holding the send, that a composer over MAX_COMPOSER_CHARS was not checked. */
  function tooLargeNotice(): void {
    showToast(doc, [], { durationMs: deps.toastMs, notice: TOO_LARGE_NOTICE });
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
    const composer = composerFromTarget(eventOrigin(ev), adapter);
    if (!composer) return;
    if (composerTooLarge(composer)) {
      tooLargeNotice();
      return;
    }
    const { text, ranges } = snapshot(doc, composer);
    // A press that goes on as typed: if the page takes it (cancels it, as a
    // composer that sends on Enter does), a replayed Enter is likely to be
    // taken too. Checked a task later, once every listener has run.
    const learnFromPress = (): void => {
      if (!adapter.send || enterReplay !== 'unknown') return;
      setTimer(() => {
        if (ev.defaultPrevented && enterReplay === 'unknown') enterReplay = 'works';
      }, 0);
    };
    if (shouldSkip(text)) {
      learnFromPress();
      return;
    }
    if (adapter.send && enterReplay !== 'works' && !findSendButton(doc, adapter, composer)) {
      // Nothing to click, and a synthetic Enter is not known to send here:
      // the original press goes on as typed rather than being swallowed.
      learnFromPress();
      return;
    }

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
          if (!composer.dispatchEvent(new KeyboardEvent('keydown', init))) {
            enterReplay = 'works';
            return;
          }
          // Nobody consumed the synthetic Enter; fall back to the button.
          const button = findSendButton(doc, adapter, composer);
          if (button) {
            button.click();
            return;
          }
          if (adapter.send) {
            // The page ignored the replay and its button is gone too: the
            // message is corrected but not sent. Say so, and let the next
            // Enter through as typed (the precheck now holds the text).
            enterReplay = 'fails';
            showToast(doc, [], { durationMs: deps.toastMs, notice: NOT_SENT_NOTICE });
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
      }, ranges),
    );
  }

  function onClick(ev: MouseEvent): void {
    if (passthrough || !settings.enabled) return;
    const button = sendButtonFromTarget(eventOrigin(ev), adapter);
    if (!button) return;
    const composer = findComposer(doc, adapter);
    if (!composer) return;
    if (composerTooLarge(composer)) {
      tooLargeNotice();
      return;
    }
    const { text, ranges } = snapshot(doc, composer);
    if (shouldSkip(text)) return;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    guard(() =>
      correctThen(
        composer,
        text,
        () => {
          withPassthrough(() => button.click());
        },
        ranges,
      ),
    );
  }

  // ---- typing: precheck cache and live mode -------------------------------

  function schedulePrecheck(composer: HTMLElement): void {
    clearTimer(precheckTimer);
    precheckTimer = setTimer(() => {
      if (composerTooLarge(composer)) return;
      const { text, ranges } = snapshot(doc, composer);
      if (!text.trim()) return;
      void normalizeComposer(composer, text, true, ranges).then((reply) => {
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
      // Mid-composition the IME owns the text: a rewrite there cancels or
      // garbles the word being composed. compositionend schedules it again.
      if (liveInFlight || composing || composerTooLarge(composer)) return;
      const { text: full, caret, ranges } = snapshot(doc, composer);
      const prefix = full.slice(0, caret);
      if (!prefix.trim()) return;
      liveInFlight = true;
      void normalizeComposer(composer, prefix, false, ranges)
        .then(async (reply) => {
          if (!reply.ok || !reply.changed || reply.replacements.length === 0) return;
          if (readText(composer) !== full || composing) return;
          const output = reply.output + full.slice(caret);
          await applyCorrections(doc, composer, reply.replacements, output);
          // Put the caret back where the user was typing, shifted by what
          // the corrections changed before it.
          const active = deepActiveElement(doc);
          if (composer === active || composer.contains(active)) setCaret(doc, composer, reply.output.length);
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
    const composer = composerFromTarget(eventOrigin(ev), adapter);
    if (!composer) return;
    precheck = null;
    if (composerTooLarge(composer)) return;
    schedulePrecheck(composer);
    // An input event inside a composition (IME, some dictation) is not a
    // finished word: live mode waits for compositionend.
    if (settings.live && !composing && (ev as InputEvent).isComposing !== true) scheduleLive(composer);
  }

  function onCompositionStart(): void {
    composing = true;
    clearTimer(liveTimer);
  }

  function onCompositionEnd(ev: Event): void {
    composing = false;
    if (passthrough || restoring || !settings.enabled || !settings.live) return;
    const composer = composerFromTarget(eventOrigin(ev), adapter);
    if (composer) scheduleLive(composer);
  }

  doc.addEventListener('keydown', onKeydown, true);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('input', onInput, true);
  doc.addEventListener('compositionstart', onCompositionStart, true);
  doc.addEventListener('compositionend', onCompositionEnd, true);

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
      doc.removeEventListener('compositionstart', onCompositionStart, true);
      doc.removeEventListener('compositionend', onCompositionEnd, true);
      clearTimer(precheckTimer);
      clearTimer(liveTimer);
      removeToast(doc);
    },
  };
}
