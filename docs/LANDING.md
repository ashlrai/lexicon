# The landing page (`web/`)

`web/` is the marketing site for Lexicon, deployed at
**<https://lexicon.ashlr.ai>**. It is a Next.js App Router app, TypeScript,
Tailwind v4, and nothing else. The dependency list is deliberately short.

It is a separate npm package from the root project. Nothing in `web/` is
published to npm, and the root `package.json` does not reference it.

---

## Run it locally

```sh
cd web
npm install
npm run dev          # http://localhost:3000
```

`predev` and `prebuild` both run `scripts/build-demo-bundle.mjs` first, so the
demo bundle is always current. Other scripts:

```sh
npm run build        # production build (regenerates the demo bundle first)
npm start            # serve the production build
npm run lint         # tsc --noEmit
```

The page reads `../src/core`, `../packs` and `../examples`. It has to be run
from inside a checkout of the Lexicon repository.

---

## Where the demo bundle comes from

The live demo on the page is not a mock-up. It runs Lexicon's real matcher,
compiled for the browser. `web/scripts/build-demo-bundle.mjs` writes four files
into `web/lib/generated/` (gitignored, rebuilt on every build):

| File | What it is |
| --- | --- |
| `lexicon-core.js` | `lib/demo-entry.ts` bundled by esbuild: `normalize`, `suggestAliases` and `DEFAULT_MIN_CONFIDENCE` straight out of `src/core`. 41 KB. |
| `lexicon-core.d.ts` | Hand-written types for the above, so the app type-checks. |
| `demo-lexicon.json` | The four starter packs (155 terms) plus the `Ashlr.AI` entry from `examples/lexicon.example.yaml`, parsed from the same YAML the CLI ships. |
| `brand-icons.json` | Monochrome SVG paths from `simple-icons` for the "works with" wall. |

This mirrors `scripts/build-site.mjs` at the repo root, which does the same job
for the GitHub Pages demo. Three things are worth knowing:

**`schema.js` is deliberately excluded.** Importing it pulls in zod, which took
the browser bundle from 41 KB to 486 KB, which is 445 KB to validate one fixed file. The
build script now validates `demo-lexicon.json` on the server, with the project's
real `parseLexicon`, and ships plain JSON. A pack that stops matching the schema
still fails the build.

**No Node builtins may survive.** `store`, `harvest` and `trust` reach for
`node:fs`. The script greps the output bundle for `node:` and throws if it finds
any, so a stray import cannot ship a broken page.

**The headline demo sentence is asserted.** The page promises that
`ping ashler about the cuban eats rollout on versal` becomes
`ping Ashlr.AI about the Kubernetes rollout on Vercel`. The build runs that
through the real matcher and fails if the output changes, so editing an alias in
`packs/developer.yaml` breaks the build instead of quietly making the page lie.

The matcher is loaded with a dynamic `import()` triggered by an
`IntersectionObserver` 400 px before the demo scrolls into view, so it never
sits in the critical path. Everything runs client-side; no transcript a visitor
types is sent anywhere.

---

## Deploy

Vercel scope **`evero`**, project **`lexicon`**.

```sh
cd "<repo root>"
npm --prefix web run build      # regenerate lib/generated from source
vercel deploy --cwd web --prod
```

### Why the build artifacts are uploaded

`vercel --cwd web` uploads `web/` only, but the build reads `../src/core`,
`../packs` and `../examples`. Two things make this work:

1. `web/.vercelignore` does **not** exclude `lib/generated`. Vercel uses
   `.vercelignore` instead of `.gitignore` when choosing what to upload, so the
   locally generated artifacts ship with the deploy.
2. `scripts/build-demo-bundle.mjs` detects that `../src/core` is absent, finds
   the prebuilt artifacts, and keeps them. If neither is present it throws
   rather than serving a page whose demo cannot work.

**So always run `npm run build` in `web/` before deploying.** Otherwise you ship
whatever `lib/generated` held last.

`lib/demo-entry.ts` is listed in `tsconfig.json`'s `exclude` for the same
reason: its `../../src/core/*` imports do not resolve in an upload of `web/`
alone, and Next type-checks the whole project.

### Switching to git-triggered deploys

The project is currently **not** connected to a git repository, so `vercel link`
connects one automatically, and it was disconnected on purpose, because a push
would otherwise build from the repository root, where there is no Next app.

To deploy from git instead, set both of these in the Vercel dashboard under
Settings → Build and Deployment:

- **Root Directory** → `web`
- **Include files outside of the Root Directory in the Build Step** → on

With those set, `../src/core` is available during the build, the prebuild script
regenerates everything from source, and `lib/generated` can stay gitignored.
Then run `vercel git connect --cwd web`.

---

## Domain and DNS

`lexicon.ashlr.ai` was added with `vercel domains add lexicon.ashlr.ai lexicon`
and is already live. **No DNS record was needed**: `ashlr.ai` is served by
Cloudflare nameservers (`elisabeth.ns.cloudflare.com`,
`tanner.ns.cloudflare.com`) and already carries a wildcard `*.ashlr.ai` CNAME
pointing at Vercel, plus a wildcard TLS certificate.

If that wildcard is ever removed, the record to recreate is:

| Type | Name | Value | Proxy |
| --- | --- | --- | --- |
| `CNAME` | `lexicon` | `bb58f57d4850e5d5.vercel-dns-016.com.` | **off** (DNS only) |

`cname.vercel-dns.com.` also works as the value. The Cloudflare proxy must stay
off: Vercel returns `disableProxy: true` for this record, and an orange-cloud
proxy breaks certificate issuance.

Verify with:

```sh
vercel domains verify lexicon.ashlr.ai --cwd web   # expects configured_correctly
dig +short lexicon.ashlr.ai
curl -sI https://lexicon.ashlr.ai | head -1
```

---

## Trademark policy

The "works with" wall is nominative use: it states what Lexicon is compatible
with. It is never framed as endorsement. The section headings say "Lexicon
corrects what you dictate into" and "Works wherever you talk to an agent",
never "Trusted by" or "Partners", which would be false.

The rules applied, in `web/components/WorksWith.tsx`:

**No Apple logo, anywhere on the page.** Apple's Identity Guidelines forbid
using the Apple logo to indicate compatibility. "macOS" and "macOS Text
Replacement" are set as words in the page's own type. The same rule would apply
to Mac and iPhone.

**Where `simple-icons` ships a CC0 path, the mark is used monochrome.** The SVG
path data is CC0; the trademarks are not. Marks are rendered in the page's
neutral foreground (`--color-paper-2`), never in the accent colour, never sized
to dominate the section, and never locked up with a Lexicon mark as if it were
a partnership. Currently: Claude Code, Claude, Cursor, Windsurf, Gemini,
Perplexity, Poe, Deepgram, Google Cloud, Chrome, Firefox, GitHub, Anthropic.

**Where `simple-icons` does not ship a path, the product name is set as text.**
This is not a workaround. `simple-icons` removes marks when the owner asks, so
its absence is a signal not to reproduce the mark. Set as words for this reason:
ChatGPT, OpenAI Codex, Microsoft Copilot, VS Code, Azure Speech, Grok. Also set
as words because `simple-icons` simply has no entry: Wispr Flow, Superwhisper,
Whisper, AssemblyAI, espanso.

**Only shipped integrations are listed.** Every entry was verified against the
repository: `extension/manifest.json` and `extension/src/adapters.ts` for the
chat sites, `INSTALL_CLIENTS` in `src/cli/cmd-install.ts` for the agent clients,
`src/core/exporters/` for the speech vendors. Ollama and Slack appear in the
starter packs as *vocabulary terms* and are not integrations, so neither is on
the wall.

**Footer line.** "All product names, logos and brands are the property of their
respective owners. Their use here indicates compatibility only, and does not
imply endorsement, sponsorship or affiliation."

The speech-vendor row is captioned honestly: Lexicon writes the dictionary,
keyword list or prompt each of those services accepts, and never calls their
APIs.

---

## What may be published as a number

Everything on the page traces to `docs/BENCHMARK.md`. Two rules:

**Always attach the audio caveat.** The real-audio rows come from macOS
text-to-speech, three voices, 110 sentences each, read into whisper.cpp. That is
much cleaner than a phone microphone. The page says so directly under the stat
band.

**Never drop the "ordinary prose" qualifier.** The false-positive rows are
`0/72` (audio) and `0/95` (synthetic) *excluding* the corpus's deliberately
adversarial `expected-hard` sentences. Including them the rate is not zero.

Two figures are **not** publishable and are not on the page:

- *"About 30 ms for in-place correction in a Mac app."* No such measurement
  exists anywhere in the repository. `docs/MACOS-APP.md` describes a deliberate
  700 ms settle delay and a 500 ms focus poll, so the real end-to-end figure is
  closer to a second. Use the matcher latency (0.3 ms per sentence) instead.
- *Term precision 94.1% and prose FP 15.0%.* The Headline table in
  `docs/BENCHMARK.md` is one revision behind `bench/results.json`, which the doc
  itself notes. Neither number is on the page.

---

## Design notes

The direction is called *non-photo blue*. Copy editors and animators marked up
artwork in a pale cyan the reproduction camera could not see, so the marks did
their job and vanished from the final print. That is what Lexicon does to a
transcript, and it is the page's one accent (`#a4dded`). Red appears in exactly
one role, a spell-check squiggle under a word the matcher has flagged, and
never as a fill.

Type has three jobs, borrowed from the structure of a dictionary entry:
Newsreader for headwords and prose (and its italic for the `\ASH-ler\`
pronunciation respellings), Instrument Sans for interface, IBM Plex Mono for
transcripts and YAML. All three are self-hosted by `next/font` with
`display: swap` and preloaded, so nothing blocks first paint and there is no
third-party font request.

Sections carry labels (`the problem`, `try it`, `measurements`) rather than
numbers, because a dictionary is a labelled reference and nothing on the page is
a sequence you follow in order.

The page is dark only, declared with `color-scheme: dark`. That is a choice, not
an omission: the accent is a mark made on ink, and a light theme would not carry
the idea.

The hero animation degrades to a static before/after under
`prefers-reduced-motion: reduce`. That same markup is what the server renders,
so it is also the no-JavaScript and pre-hydration state.

## See also

- [DISTRIBUTION.md](DISTRIBUTION.md) covers the directories that link to this site.
- [CONTRIBUTING.md](../CONTRIBUTING.md) covers running and changing `web/` locally.

Back to [the docs index](README.md).
