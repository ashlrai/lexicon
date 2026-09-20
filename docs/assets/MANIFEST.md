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
| Dimensions | **776 × 1016** px (388 × 508 pt @2x Retina) |
| Size | **103,245 B** (101 KB) |

The full LexiconBar status-bar menu, open: Push to talk (⌃⌥Space), Fix clipboard
now (⌃⌥V), Fix everywhere (✓) with **Fix everywhere in TextEdit** (✓), Undo last
fix (⌃⌥Z), Show the correction bubble (✓), Watch clipboard, the Local API row,
Last correction, Set up Lexicon…, Open lexicon file, Stats…, Run doctor, Start at
login, Preferences…, Quit.

**Two things to know before you place this:**

1. It is the **menu panel only** — the macOS menu bar strip above it is *not*
   included, because the LexiconBar status icon does not currently render in the
   menu bar on this machine (see Known issues). Frame it as "the LexiconBar menu",
   not "the icon in your menu bar".
2. The background is flat neutral grey (a window-buffer capture, so the menu's
   usual translucency is not composited). That reads fine on a dark panel, but it
   will not blend with a coloured background.

No private data is visible: `Last correction` is a collapsed submenu, and
`Show API URL and token…` was never opened.

**Alt text:** "The LexiconBar menu bar menu, showing Push to talk, Fix clipboard
now, Fix everywhere enabled for TextEdit, the correction bubble toggle, and the
local API running at login."

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

1. **The LexiconBar status icon does not render in the menu bar.** The item is
   live and reachable — Accessibility reports it at 33 × 24 pt and clicking it
   opens the menu correctly — but nothing is drawn at that position, and it is
   absent from the menu bar in a full-width capture (both displays checked). This
   is why `menubar.png` is the menu panel alone. Worth investigating in
   `AppDelegate`'s status-item setup (the icon is the SF Symbol `waveform`,
   `isTemplate = true`) before launch, since it also means users cannot find the
   app.
2. **Version skew.** `menubar.png` reads **Quit LexiconBar 0.4.0** because the
   built app at `apps/macos/build/LexiconBar.app` is 0.4.0, while the source and
   the CLI are 0.5.1. Rebuild the app and re-shoot `menubar.png` if the launch
   page claims 0.5.1.
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
