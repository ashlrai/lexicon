# Brand marks on the "works with" wall: sourcing and permissions

This directory exists to hold third-party brand assets and the record of where
each one came from. **It currently holds no downloaded assets**, and the reason
is recorded below: for almost every brand we wanted a mark for, the trademark
owner's own published terms forbid a third party reproducing the logo to signal
compatibility.

The thirteen marks already on the page come from **simple-icons** (CC0) and are
inlined as paths in `web/lib/generated/brand-icons.json`, not stored here.

Researched 2026-09-20 by reading each owner's live brand/legal page.

---

## Verdicts

| Brand | Owner's page | Official asset? | Verdict |
|---|---|---|---|
| OpenAI / ChatGPT | `https://openai.com/brand/` | Yes, `cdn.openai.com/brand/OpenAI-Logos-2025.zip` | **Forbidden.** A developer's own product name, logo, description and screenshots must be free of OpenAI's brands and logos. The mark permission is non-transferable and revocable. Truthful *text* naming is permitted. |
| OpenAI Codex | same, navigation only | none | **Unclear.** Codex is not addressed in the guidelines body; covered only by the catch-all "other OpenAI trademarks". Treated as forbidden by default. |
| Whisper | not mentioned | none | **Unclear.** Absent from the brand page entirely. Treated as forbidden by default. |
| Microsoft Copilot | `https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks` | No | **Forbidden.** Microsoft logos, icons and designs need an express licence. Wordmarks in text to state compatibility are permitted, and Microsoft's own examples are exactly that. |
| VS Code | `https://code.visualstudio.com/docs/supporting/faq`, `LICENSE.txt` | No | **Forbidden.** The repo is MIT but that covers source; the shipped product adds Microsoft proprietary assets "such as icons", so the product icon is not MIT. |
| Azure Speech | `https://learn.microsoft.com/en-us/azure/architecture/icons/` | Yes, service-icon pack | **Forbidden for this use.** The pack's licence permits architecture diagrams, training material and documentation only. A marketing compatibility wall is none of the three. |
| Windows | Windows Trademark Guidelines (Feb 2026), linked from the Microsoft trademarks page | No public download | **Forbidden, explicitly.** A licence is required for any Windows logo, and the guidelines state the logo is not for showing compatibility for other software products. This is the sharpest case of the set. |
| Grok (xAI) | `https://x.ai/legal/brand-guidelines` | Yes, `data.x.ai/logos/SpaceXAI_Grok_Assets.zip` | **Permitted, conditionally.** Accurate referential use, no implied endorsement. But the mark must be used **exactly as provided, unaltered**, which rules out the monochrome treatment every other mark on this page gets. Kept as a wordmark so the wall stays one system; available in colour if we decide the exception is worth it. |
| Superwhisper | `https://superwhisper.com/assets`, `https://superwhisper.com/terms` | Yes, `superwhisper-logo.svg` | **Forbidden without written permission.** The press kit reads as an invitation but the ToS separately gates trademark use behind written permission, and the ToS is the binding document. |
| Wispr Flow | `https://wisprflow.ai/media-kit` | Logo kit ZIP, format unverified | **Silent.** Colour guidance only, no grant and no prohibition. No affirmative permission, so wordmark. |
| AssemblyAI | `https://www.assemblyai.com/media` | Yes, `primary-light.svg` / `primary-dark.svg` | **Silent, leaning permissive.** A real media kit aimed at "press, partners and analysts", with visual rules (clear space, no recolouring) but no legal grant either way. Wordmark for now; this is the safest candidate if we want to add one. |
| espanso | none published | Logo SVG in the MIT-licensed `espanso/website` repo | **Silent.** No trademark or logo policy exists. MIT covers copyright, not trademark. Low practical risk, but no stated permission, so wordmark. A note to the maintainer would settle it. |
| macOS Text Replacement | Apple Identity Guidelines | none | **Forbidden.** Apple explicitly forbids using the Apple logo to indicate compatibility. Set as a word in our own type. No Apple mark appears anywhere on this page. |
| Linux (word mark) | `https://www.linuxfoundation.org/legal/trademark-usage` | none | **Permitted, referentially.** "compatible with Linux(R)" is a sanctioned phrasing. Adjective only, never standalone or before our own product name, and carry the (R) on first use. No sublicence needed for referential use. |
| Tux (Linux mascot) | `https://commons.wikimedia.org/wiki/File:Tux.svg`, `https://github.com/garrett/Tux` | Yes | **Permitted with attribution.** Larry Ewing grants use and modification on condition of credit. Required line: "Larry Ewing, lewing@isc.tamu.edu, created with The GIMP". Ewing's original page at `isc.tamu.edu/~lewing/linux/` now 404s; cite Commons or `garrett/Tux` instead. Note the image permission and the "Linux" word mark are two separate permissions. |

---

## Correction to a claim in the code

`web/components/WorksWith.tsx` stated that OpenAI, Microsoft and xAI each asked
simple-icons to remove their marks. Only one third of that is true:

- **Microsoft, confirmed.** simple-icons issue #11236 records a notification
  from Microsoft's legal team; Microsoft, including Visual Studio, is now on the
  project's Forbidden Brands list.
- **OpenAI, refuted.** The icon shipped from 2021 until PR #13944 removed it in
  Nov 2025. No removal request was made; the maintainers dropped it because
  OpenAI's usage terms are non-transferable, so simple-icons cannot relicense it
  onward. Request #14748 is open and labelled "permissions in review".
- **xAI / Grok, refuted.** It was never in the repo. Five separate "add xAI
  icon" PRs were closed unmerged because xAI's no-alteration rule conflicts with
  simple-icons normalising every icon to a common format.

The conclusion the comment drew is still right for Microsoft and still the safe
default for the others, but the stated reason was wrong and has been corrected
in place.

---

## Where this leaves the wall

Ten of the thirteen brands asked for cannot carry a mark. Sourcing therefore
cannot make the wall uniform: adding the two or three that are available would
leave it more patchy, not less. The two options that actually produce one system
are (a) a wholly typographic wall, dropping the CC0 marks too, or (b) keeping the
current mixed wall and making the treatment consistent enough that the absence of
a mark reads as deliberate. That is a design decision, not a licensing one.
