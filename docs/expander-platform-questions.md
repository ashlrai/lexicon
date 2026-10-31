# Expander platform questions

[Issue #220](https://github.com/ashlrai/lexicon/issues/220) proposes a
resident, system-wide text expander: a process that watches a focused text
field in any application and applies corrections without an agent in the loop.
The pieces that exist (the pure expansion core and the opt-in socket server
behind `lexicon daemon --expander`) answer a small number of questions
already; the platform client that would feed keystrokes to that core and
apply its actions does not exist. This page is the discovery list for that
client, organized per platform because each operating system answers these
questions differently.

It is a list of questions, not a plan or a spec, and it is discovery work
rather than requirements attributed to the issue. Two marks label every line:

- **Decided.** Behavior that exists in the repository today, named with where
  it is proved. A decided line still constrains the questions around it: a
  client that speaks the socket protocol inherits them.
- **Undecided.** Genuinely open. Neither the issue nor any code answers it.
  Undecided here means undecided, not a decision waiting to be announced.

For the scope of the proposed surface see
[resident-expander-scope.md](resident-expander-scope.md); for the boundary
between the existing server and a future client see
[CONTRACT.md](CONTRACT.md#separate-process-boundary-issue-220); for the
protocol a client would speak see
[DAEMON.md](DAEMON.md#resident-expander-opt-in).

## What the existing code already decides

- **Decided.** Only whitespace finishes a word. Punctuation does not, so
  `ashler.com` and `foo@ashler.io` are left alone until a space arrives.
  (`src/daemon/expander.ts`, `tests/daemon/expander.test.ts`)
- **Decided.** Only exact aliases match while typing: no phonetic or fuzzy
  guesses in a live rewrite.
- **Decided.** An action is press Backspace `backspaces` times, counted in
  grapheme clusters, then type `insert`. Backspace straight after an
  expansion is the undo gesture and settles the word permanently.
- **Decided.** Enter, Tab, Escape, Delete, the navigation keys and `reset`
  forget the buffer instead of expanding.
- **Decided.** Transport is newline-delimited JSON over a Unix socket
  (mode 0600 in a 0700 directory, only the owner can connect) or a per-user
  named pipe on Windows. One connection is one keyboard source with its own
  buffer; requests on a connection are answered in order.
- **Decided.** Nothing starts the server but the flag, nothing installs a
  client, and typed text is never logged server-side, since a key source
  sees passwords too.
- **Decided.** The espanso figures quoted in the issue are context, not a
  target. [BENCH-DAEMON.md](BENCH-DAEMON.md) measures the resident server on
  its own terms, and neither the issue nor the protocol establishes a
  latency or memory guarantee.

## Questions every platform has to answer

- **Undecided.** The input source: keystroke-level capture (the `type`,
  `key`, `reset` stream the core consumes) or field-level observation (the
  value-change events an accessibility API reports, which is what both tray
  apps already use). A field-diff model may need a snapshot op the protocol
  does not have.
- **Undecided.** How the client recognizes the key events it injected
  itself, so an expansion's own backspaces and replacement text are not fed
  back to the core as fresh typing.
- **Undecided.** Whether expansion is suppressed while an IME composition or
  marked-text session is open, and how composition events even appear in the
  chosen input stream.
- **Undecided.** Where the sensitive-field gate sits. Both apps refuse a
  field on metadata before its text is ever read; a keystroke client sees
  the keys before it has identified the field, so gating after the fact
  means the buffer already held a password.
- **Undecided.** What the client does when the platform cannot tell whether
  a field is sensitive: refuse and silently stop expanding, or proceed.
- **Undecided.** What the client logs. The apps log decisions only, never
  field text; whether that rule binds a client whose input is a raw key
  stream is a per-platform decision.
- **Undecided.** Whether one injected Backspace deletes exactly one grapheme
  cluster in each field's own editing model. The core counts clusters; some
  fields delete code points or whole emoji sequences instead.
- **Undecided.** The undo surface: the core's espanso-style Backspace undo,
  or the bubble and hotkey model both shipped apps already expose.
- **Undecided.** Partial edits: what happens when only some of an action's
  key events land. Both apps carry partial-write recovery logic; the
  expander protocol has no equivalent and the client owns the gap.
- **Undecided.** Who starts, supervises and stops the client and the server;
  how the client discovers the socket, survives a crash, reconnects, and
  behaves when the server answers an older protocol or nothing at all.
- **Undecided.** Whether the per-app exclusion lists the apps keep
  (terminals, credential stores, remote sessions) transfer to a keystroke
  client, and how per-app exclusion is expressed where the signal is a key
  event rather than a focused element.
- **Undecided.** Performance targets for interactive expansion and how they
  are measured: an expansion has to land between keystrokes without ever
  delaying one, which neither espanso's `list` figure nor the daemon
  benchmark measures.

## macOS

The questions here are informed by LexiconBar, which already corrects
dictated bursts through the Accessibility API ([MACOS-APP.md](MACOS-APP.md)).
That is field-level observation of a different shape than the keystroke
stream the expander core wants.

- **Decided.** The Accessibility API can observe focus and read and write
  field values; LexiconBar's three-strategy write ladder
  (`AXSelectedText`, unicode key events over a selection, whole `AXValue`)
  is the worked example, verified by hand in a handful of apps.
- **Undecided.** The input source: `CGEvent` taps (which need Input
  Monitoring, a second and more alarming-looking permission) versus
  `AXObserver` focus and value notifications (which see text changes, not
  keys, and cannot report a bare Backspace). Neither alone carries the
  `type`/`key`/`reset` stream cleanly.
- **Undecided.** How actions are applied: synthesizing real `CGEvent`
  backspaces and keypresses (which land in whatever the app does with real
  keys) versus the AX write ladder (which can splice a range but is not a
  backspace). The action contract is written in keystrokes.
- **Undecided.** Which permission the client asks for, and how it survives
  the TCC trap: the Accessibility grant is bound to a code signature and
  dies on every ad-hoc rebuild, which already plagues LexiconBar's
  development loop ([MACOS-APP.md](MACOS-APP.md#signing-and-why-the-accessibility-grant-kept-disappearing)).
- **Undecided.** Whether the secure-field check (the field's subrole plus
  role description) covers every sensitive field a keystroke client would
  see, given that capture happens before the field is identified.
- **Undecided.** What marked text looks like in the chosen stream: an
  open composition (CJK input, accent menus, dictation's own sessions)
  reports provisional text through accessibility while key taps see the
  keys behind it.
- **Undecided.** Apps with no accessibility tree at all (VS Code and Cursor
  build one only when their own setting is on): silently never expand, or
  fall back to key-level capture without a field to read.
- **Undecided.** Whether the client lives inside LexiconBar, which already
  holds the grant, the gate and the exclusion lists, or is a separate
  process beside it.

## Windows

The tray app ([WINDOWS-APP.md](WINDOWS-APP.md)) is the reference for what
UI Automation can and cannot see; its UIA half has never executed on real
Windows, so every item it answers is decided logic over unproven platform
behavior.

- **Decided.** The socket side already exists: the server listens on a
  per-user named pipe under Windows, and the Scheduled Task route
  (`lexicon serve --install`) proves a user-scoped login service works.
- **Undecided.** The input source: a low-level keyboard hook
  (`WH_KEYBOARD_LL`, sees every key but no field), UIA focus and
  `Text_TextChanged` events (sees the field but not the keys), or a mix.
  The hook is the only route that observes a bare Backspace.
- **Undecided.** Whether actions reuse the tray app's write ladder
  (select the span, `SendInput` `KEYEVENTF_UNICODE`, value write, narrow
  backspace-and-retype) or send raw injected keystrokes, and which of
  those the expander action maps to.
- **Undecided.** Behavior in elevated windows. UIPI silently blocks a
  non-elevated client from reading or typing into them; whether the
  client pauses visibly, fails silently, or refuses to run elevated at
  all is open.
- **Undecided.** Where the secret gate sits when the raw input is a key
  stream: `IsPassword` and the label heuristic decide before a field is
  read, but a keyboard hook has already seen the keystrokes before UIA
  resolves the focused element.
- **Undecided.** Which app families expose a usable `TextPattern` (Win32,
  WinForms, WPF, Chromium, Electron, packaged apps, terminals) and what
  `TextUnit_Character` maps to in each, the gap the tray app already
  flags as most likely to fail in Chrome.
- **Undecided.** How IME input arrives through Text Services Framework
  and whether composition events must suppress expansion.
- **Undecided.** The undo model: the core's Backspace undo versus the
  tray app's Ctrl+Alt+Z ledger, and whether the two can coexist.

## Linux

Linux is the platform where [PLATFORMS.md](PLATFORMS.md) says there is
nothing: no tray app exists, X11 and Wayland share no accessibility story,
and every compositor answers differently. The first question is therefore
which subset, if any, counts as the supported target.

### X11

- **Undecided.** Key observation: `XRecord`, `XInput2` raw events, or an
  AT-SPI2 registry listener, and whether any of them reports keys and
  focus reliably enough to drive the core.
- **Undecided.** Key injection: `XTest` fake input versus `XSendEvent`,
  and which applications honor synthetic Backspace events.
- **Undecided.** Whether AT-SPI gives a workable focused-element and
  caret story on the desktops where it is enabled, and whether it can
  identify sensitive fields at all.
- **Undecided.** Whether an X11 client is worth building at all given
  where distributions are heading, or whether the clipboard daemon stays
  the X11 answer.

### Wayland

- **Undecided.** Whether any global observation is possible at all:
  Wayland deliberately has no equivalent of a global focus or input
  observer, so each compositor family is separate work, and AT-SPI under
  Wayland has no single global focus observer either.
- **Undecided.** Which compositor route, if any, a first client would
  target: wlroots' `virtual-keyboard` and `input-method` protocols, the
  KDE and GNOME specific mechanisms, or the XDG portal surfaces, none of
  which is common to all three.
- **Undecided.** Where the injection boundary is: compositor input-method
  protocols can commit strings but may not expose the focused field's
  full text, so the core's backspace-and-insert action may not be
  expressible the same way it is elsewhere.
- **Undecided.** What "supports Wayland" would mean in a support matrix:
  one named compositor, one desktop environment, or the union of the
  routes above.

### Either way on Linux

- **Undecided.** A sensitive-field signal: there is no uniform password
  flag across toolkits, and each AT-SPI text attribute story differs.
- **Undecided.** IBus and Fcitx input-method interaction with injected
  key events.
- **Undecided.** What the interim answer is while none of this exists:
  today it is the clipboard daemon on a hotkey
  ([DAEMON.md](DAEMON.md#linux-gnome-custom-shortcut)), and whether the
  expander surface ever supersedes that on Linux is its own question.

## What would count as supported

- **Undecided.** The application matrix a platform must pass before the
  client can be described as working there: which editors, browsers,
  chat apps, terminals and credential prompts it is tried against.
- **Undecided.** The acceptance tests. CI cannot drive a real desktop
  session (the Windows app documents why a runner has no focused
  element, foreground window or caret), so each platform needs a manual
  script in the style of
  [WINDOWS-APP.md](WINDOWS-APP.md#manual-test-script), and what its
  steps assert has not been written.
- **Undecided.** The failure policy a client must prove: that a wrong
  expansion is always undoable, that a half-applied action never leaves
  text it cannot restore, and that a field it cannot identify is left
  alone.
- **Undecided.** The measurements that close the issue's gap honestly:
  per-keystroke latency and resident memory on each platform, against a
  stated method, rather than the espanso `list` figure the issue cites
  as context.

## See also

- [resident-expander-scope.md](resident-expander-scope.md): the requested
  surface, the existing pieces and the boundary this list digs into.
- [daemon-surface-questions.md](daemon-surface-questions.md): the daemon half
  of the question list, for the resident server a client would talk to.
- [DAEMON.md](DAEMON.md#resident-expander-opt-in): the server a client
  would talk to, its protocol and its access rules.
- [PLATFORMS.md](PLATFORMS.md): what is tested, untested and absent per
  platform today.
- [MACOS-APP.md](MACOS-APP.md) and [WINDOWS-APP.md](WINDOWS-APP.md): the
  two field-level implementations whose verified and unverified halves
  the questions above draw on.
- [BENCH-DAEMON.md](BENCH-DAEMON.md): the resident server's measured
  latency and memory, and why the issue's espanso figures are context.

Back to [the docs index](README.md).
