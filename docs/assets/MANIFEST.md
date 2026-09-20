# Lexicon product imagery — manifest

Captured on this Mac on 2026-09-20 against the real install: LexiconBar **0.4.0**
(running build, Accessibility trusted), `lexicon serve` **0.4.0** on 127.0.0.1:41733,
CLI **0.5.1** (repo `dist/`), and the user's real 134-term lexicon.

Every asset below is a genuine capture. Nothing is mocked, composited, or retouched.

Each file exists at **two identical paths** so either surface can use it without
reaching across directories:

- `docs/assets/<name>` — for `README.md` / `docs/**`
- `web/public/media/<name>` — for the landing page (reference as `/media/<name>`)

Sizes and dimensions below are identical for both copies.

---

## Assets

### `fix-in-place.mp4` — **the headline asset, prefer this over the GIF**

| | |
|---|---|
| Paths | `docs/assets/fix-in-place.mp4`, `web/public/media/fix-in-place.mp4` |
| Dimensions | **1920 × 920** px (960 × 460 pt @2x Retina) |
| Size | **125,459 B** (123 KB) |
| Duration | 6.15 s, H.264, no audio, `+faststart` |

Dictated text landing in a real TextEdit document and being corrected in place,
with the correction bubble appearing beside the caret. The arc: empty note →
`ashler is shipping cuban eats support on versal next week` pasted → 0.9 s later
the text rewrites itself to `Ashlr.AI is shipping Kubernetes support on Vercel
next week` and the bubble fades in → bubble dismisses after 4 s.

Suggested markup (video first, GIF as fallback):

```html
<video src="/media/fix-in-place.mp4" poster="/media/bubble.png"
       autoplay loop muted playsinline
       width="960" aria-label="Lexicon correcting dictated text in place in TextEdit"></video>
```

**Alt text:** "A TextEdit note where the dictated line 'ashler is shipping cuban eats
support on versal next week' rewrites itself in place to 'Ashlr.AI is shipping
Kubernetes support on Vercel next week', with a small bubble listing the three fixes."

### `fix-in-place.gif` — fallback for the above

| | |
|---|---|
| Paths | `docs/assets/fix-in-place.gif`, `web/public/media/fix-in-place.gif` |
| Dimensions | **960 × 460** px (1x) |
| Size | **90,710 B** (89 KB) |
| Duration | 6.13 s, 15 fps, loops forever |

Same take as the MP4, rendered at 1x with `gifski --quality 85`. Loops on a hard
cut (it ends holding the corrected line for ~0.7 s, then restarts from the empty
note) — there is no crossfade. Use it in `README.md`, where video will not play.

**Alt text:** same as `fix-in-place.mp4`.

### `bubble.png`

| | |
|---|---|
| Paths | `docs/assets/bubble.png`, `web/public/media/bubble.png` |
| Dimensions | **900 × 400** px (450 × 200 pt @2x Retina) |
| Size | **34,061 B** (33 KB) |

Close crop of the real correction bubble next to the text caret, reading
**Fixed 3 words** / `ashler → Ashlr.AI` / `cuban eats → Kubernetes` /
`versal → Vercel`, with the **Undo** and **Never** buttons. Background is the
white TextEdit page — it is not transparent, so give it a light card or a rounded
white panel rather than dropping it straight onto the dark background.

Note: there is no **Add** button in this shot. That button only appears when at
least one match is phonetic or fuzzy; all three fixes here are exact alias hits,
so a two-button bubble is the correct, honest result.

**Alt text:** "Lexicon's correction bubble reading 'Fixed 3 words', listing ashler
corrected to Ashlr.AI, cuban eats to Kubernetes and versal to Vercel, with Undo and
Never buttons."

### `menubar.png`

| | |
|---|---|
| Paths | `docs/assets/menubar.png`, `web/public/media/menubar.png` |
| Dimensions | **388 × 539** px (388 × 539 pt @1x) |
| Size | **127,313 B** (124 KB) |

The LexiconBar menu bar icon and its menu, open. The 31 px strip along the top is
the real macOS menu bar, with the LexiconBar `waveform` icon at the left in its
selected state; below it the full menu: Push to talk (⌃⌥Space), Fix clipboard now
(⌃⌥V), Fix everywhere (✓) with **Fix everywhere in Claude** (✓), Undo last fix
(⌃⌥Z), Show the correction bubble (✓), Watch clipboard, the Local API row, Last
correction, Set up Lexicon…, Open lexicon file, Stats…, Run doctor, Start at
login, Preferences…, **Quit LexiconBar 0.5.1**.

Reshot after the status icon was fixed, so this now shows what the previous
version of this file could not: the icon actually in the menu bar. It replaces a
776 × 1016 @2x capture of the menu panel alone.

**Three things to know before you place this:**

1. It is **@1x, not @2x**. The menu bar that carries the status item is on this
   machine's main display, a 1920 × 1080 external monitor with a backing scale of
   1.0, so no 2x capture of it exists to take. The built-in Retina display shows a
   second menu bar, but it drops the leftmost status items and LexiconBar is among
   them, so the icon cannot be shot there at all. Place it at its natural size and
   do not upscale it. To reshoot at @2x, run the app on a Mac whose **main**
   display is Retina.
2. The top strip also shows **other apps' status icons** to the right of ours.
   LexiconBar sits at the left end of a row of about fifteen menu bar apps, and
   the menu is wider than one icon, so a rectangle containing both our icon and
   our menu necessarily contains its neighbours. No app menu titles (File, Edit,
   View…) are included.
3. The menu is **translucent**, so faint page content shows through it. What
   shows through is the Lexicon marketing site itself.

No private data is visible: `Last correction` is a collapsed submenu, and
`Show API URL and token…` was never opened. The bleed-through carries no personal
content.

**Alt text:** "The LexiconBar waveform icon in the macOS menu bar with its menu
open, showing Push to talk, Fix clipboard now, Fix everywhere enabled for Claude,
the correction bubble toggle, the local API running at login, and Quit LexiconBar
0.5.1."

### `onboarding-words.png`

| | |
|---|---|
| Paths | `docs/assets/onboarding-words.png`, `web/public/media/onboarding-words.png` |
| Dimensions | **1280 × 1120** px (640 × 560 pt @2x Retina) |
| Size | **147,094 B** (144 KB) |

Onboarding step 2, **"Your words"**, with real alias suggestions returned live by
`GET /aliases`: the term `Mason Wyatt` with the suggestion chips **Mason Wiatt**
and **Mason Wyat**, both switched on, plus a second empty row and the **Try it**
box pre-filled with `ping Mason Wyatt about the cooper netties rollout on versel`.

Shows the user's real name (Mason Wyatt) — intended, it is the product's own
example term.

**Alt text:** "Lexicon's setup step 'Your words', showing the name Mason Wyatt with
suggested misspellings Mason Wiatt and Mason Wyat that dictation is likely to
produce, each switched on."

### `onboarding-packs.png`

| | |
|---|---|
| Paths | `docs/assets/onboarding-packs.png`, `web/public/media/onboarding-packs.png` |
| Dimensions | **1280 × 1120** px (640 × 560 pt @2x Retina) |
| Size | **230,774 B** (225 KB) |

Onboarding step 3, **"Starter packs"**, with all four real pack cards and their
live counts: AI models and tools (36 terms, 86 spellings, on), Business and startup
vocabulary (35 terms, 58 spellings, off), Developer tools (70 terms, 184 spellings,
on), Voice and dictation tools (14 terms, 21 spellings, on).

**Alt text:** "Lexicon's starter pack picker with four cards — AI models and tools,
Business and startup vocabulary, Developer tools, and Voice and dictation tools —
each with a term count and an on/off switch."

### `cli-setup.gif`

| | |
|---|---|
| Paths | `docs/assets/cli-setup.gif`, `web/public/media/cli-setup.gif` |
| Dimensions | **1842 × 2142** px (render it at ~921 CSS px wide for a 2x result) |
| Size | **196,331 B** (192 KB) |
| Duration | 7.10 s, loops forever |

`lexicon setup` typed at a prompt and running to completion — all seven steps, ending
in the **step 7 correction demo** (`you dictate:` / `your agent sees:` / `fixed:`) and
the `Done.` + `Next:` card. Dark terminal (`agg --theme github-dark`), so it sits
directly on the dark page with no card needed.

This is a **real, complete run** of the 0.5.1 CLI, executed against a throwaway
`$HOME` in the session scratchpad. It seeded terms, installed all three default
packs, and wrote all five agent client configs — inside the sandbox. Nothing on
this Mac was modified.

**Alt text:** "A terminal running `lexicon setup` through seven steps — seeding the
lexicon, installing starter packs, wiring up five agent clients, exporting for
dictation — and finishing by showing a dictated sentence corrected from 'Mason
Wiatt' and 'Ashler' to 'Mason Wyatt' and 'Ashlr.AI'."

### `cli-setup.cast`

| | |
|---|---|
| Paths | `docs/assets/cli-setup.cast`, `web/public/media/cli-setup.cast` |
| Size | **3,298 B** |
| Format | asciicast **v3**, 100 × 50, 2.5 s of events |

The asciinema recording the GIF was rendered from. Use it with asciinema-player for
a selectable-text, ~3 KB alternative to the 192 KB GIF:

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/asciinema-player@3/dist/bundle/asciinema-player.css">
<div id="setup-cast"></div>
<script src="https://cdn.jsdelivr.net/npm/asciinema-player@3/dist/bundle/asciinema-player.min.js"></script>
<script>AsciinemaPlayer.create('/media/cli-setup.cast', document.getElementById('setup-cast'),
  { cols: 100, rows: 50, autoPlay: true, loop: true, theme: 'monokai' });</script>
```

Verify your player build reads asciicast **v3** — asciinema-player 3.x expects v2 in
some releases. If it refuses the file, keep the GIF and drop the player.

### `cli-normalize.png`

| | |
|---|---|
| Paths | `docs/assets/cli-normalize.png`, `web/public/media/cli-normalize.png` |
| Dimensions | **1842 × 470** px (render at ~921 CSS px wide for a 2x result) |
| Size | **82,530 B** (81 KB) |

A dark terminal running `lexicon normalize --diff` twice against the user's real
134-term lexicon, showing the replacement lines and the corrected output:

```
$ lexicon normalize --diff "ping ashler about the cuban eats rollout on versal"
"ashler" -> "Ashlr.AI" (alias, 1.00)
"cuban eats" -> "Kubernetes" (alias, 1.00)
"versal" -> "Vercel" (alias, 1.00)
ping Ashlr.AI about the Kubernetes rollout on Vercel

$ lexicon normalize --diff "we moved the superbase migrations to head sner"
"superbase" -> "Supabase" (alias, 1.00)
"head sner" -> "Hetzner" (alias, 1.00)
we moved the Supabase migrations to Hetzner
```

Same dark theme as `cli-setup.gif`; no card needed.

**Alt text:** "A terminal running `lexicon normalize --diff`, listing each
replacement — ashler to Ashlr.AI, cuban eats to Kubernetes, versal to Vercel — above
the fully corrected sentence."

---

## Not captured

### `extension.png` — **missing**

The browser-extension screenshot could not be produced. The extension itself is
fine and fully built at `extension/dist` (v0.5.1); the blocker is Chrome.

Loading an unpacked extension from the command line no longer works: Chrome 137+
removed the `--load-extension` switch, and relaunching with
`--disable-features=DisableLoadExtensionCommandLineSwitch` did not restore it
(verified twice — `chrome://extensions` in the throwaway profile listed nothing).
The only remaining route is the GUI: toggle **Developer mode**, click **Load
unpacked**, and drive the file picker. Synthetic clicks were landing off-target on
this two-display setup, so that was abandoned rather than guessed at.

Two further constraints worth recording for whoever retries:

- The extension corrects **on Enter** or **on send-button click**, both of which
  submit the composer. Shooting it on a real site therefore means submitting text
  to that site. The clean alternative is the **Live** toggle on the extension's
  options page (off by default), which corrects 400 ms after you stop typing and
  shows the same toast with no submit at all — confirmed in
  `extension/src/content-core.ts:216-238`, which calls `toastFor(...)` directly.
- No pairing is needed. With no token the worker falls back to the bundled
  `examples/lexicon.example.yaml`, and the toast badge reads `embedded` rather than
  `local API`.

**Recommended retry:** load `extension/dist` unpacked by hand in a throwaway Chrome
profile, turn on **Live** in the options page, open `https://chatgpt.com` or
`https://claude.ai`, type `ping ashler about cooper netties`, wait 400 ms, hover the
toast to freeze its 3 s timer, and capture. The toast is bottom-right, `#14201f` on
`#0f766e` — it is hardcoded dark, so shoot it over a dark page.

---

## Known issues found while capturing

1. ~~**The LexiconBar status icon does not render in the menu bar.**~~
   **Not a bug in the app.** The icon draws correctly; the capture conditions
   hid it, in two independent ways. First, the machine's main display had a
   fullscreen window on it, so its menu bar was slid out of view: every status
   item on the Mac, LexiconBar's and fifteen other apps', reported a y of −59,
   i.e. off the top of the screen. A brand-new status item built from scratch
   with nothing but a plain text title was equally invisible under the same
   conditions, which is what rules the app out. Second, the *other* display's
   menu bar is narrower and drops its leftmost status items, and LexiconBar is
   the leftmost one, so it is absent there too. Park the pointer against the top
   edge of the main display to slide the menu bar down and the icon is plainly
   there. `menubar.png` now shows it.

   The app was hardened anyway, since an invisible menu bar app is worse than a
   crashed one: `updateStatusIcon` now falls back from the SF Symbol to a
   hand-drawn waveform and then to the text title `LB`, treats a zero-sized
   image as a failure, and logs which path it took on every launch. Read it back
   with `log show --predicate 'subsystem == "ai.ashlr.lexiconbar"' --last 5m`.
2. ~~**Version skew.**~~ **Fixed.** The app takes its version from the root
   `package.json` via `scripts/build-macos-app.sh`, which was always correct; the
   0.4.0 reading came from a *running process* that predated the last repackage.
   Rebuilt and relaunched, and `menubar.png` now reads **Quit LexiconBar 0.5.1**.
3. **`remind` is fuzzy-matched to `Rewind` at 0.83.** Found while choosing demo
   copy: `lexicon normalize "remind mason white that ashler ships…"` turns *remind*
   into *Rewind*. A false positive on a very common English word — avoid "remind"
   in any launch copy, and consider it a matching bug.
4. **Everything is light mode.** macOS is set to Light on this Mac and the app
   correctly follows the system (nothing is hard-coded — verified across
   `apps/macos/LexiconBar/Sources`). System appearance was not changed, since that
   is the user's own setting. The four app screenshots are therefore light-on-dark
   when placed. The two terminal assets are dark and need no treatment. If dark app
   screenshots are wanted, flip System Settings ▸ Appearance ▸ Dark and re-run the
   captures — the app will render dark with no code changes.
