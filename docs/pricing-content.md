# Landing page: pricing content spec

**For the agent that owns `web/`.** This file is copy and structure, not
implementation. It does not prescribe components, layout or styling; the
design direction in [LANDING.md](LANDING.md#design-notes) governs those.
Nothing in `web/` was edited to produce this.

The reasoning behind every number is in [COMMERCIAL.md](COMMERCIAL.md).

---

## Read this before writing any of it

**Two things in this spec are hard requirements, not preferences.**

**1. Nothing here may be published in the present tense except what is
shipped.** The Team and Enterprise tiers do not exist. Not partially, not in
beta, not a line of code. Every tier below carries a `SHIPPED` or `PLANNED`
marker. A `PLANNED` item may never appear on the page as a feature bullet
without a visible "not yet built" treatment. If the marker is inconvenient for
the layout, change the layout.

**2. Ship Phase A now. Do not ship Phase B until the product exists.** Phase A
is a contact block with no prices. Phase B is the full table. They are
described separately below. Publishing Phase B today would put prices on a
product that has not been started.

---

## Phase A: ship this now

A single short section, reachable from the nav as **Teams**, placed after the
FAQ. No price table, no tier cards, no feature matrix, no waitlist form that
implies a launch date.

### Section label

`for teams`

(Lowercase section labels, matching `the problem`, `try it`, `measurements`.)

### Headline

> **Lexicon is free, and stays free.**

### Body

> Everything on this page is MIT-licensed and yours: the matcher, the CLI, the
> MCP server, the Claude Code plugin, the browser extension, the macOS app and
> the local API. There is no paid tier, no account and no telemetry. That does
> not change. Nothing that is free today becomes paid later.
>
> Teams can already share a vocabulary: commit `.lexicon.yaml` to a repository
> and each person approves it once. That works now, costs nothing, and will
> keep working.
>
> We are looking at whether a hosted shared lexicon is worth building: one
> list your whole company pulls, including the people who never clone a
> repository. It does not exist yet. If you are trying to do this across a
> team, we would rather hear how you are handling it today than sell you
> something.

### Call to action

A plain mailto link, not a form:

> **[mason@ashlr.ai](mailto:mason@ashlr.ai)**. Tell us how many people, which
> agents and dictation tools they use, and what breaks.

**No waitlist.** A waitlist implies a launch. A mailto implies a conversation,
which is the thing actually being asked for.

### What Phase A must not contain

- Any price, including "starting at" or "from".
- The words "coming soon", "beta", "early access" or "waitlist".
- Any tier name.
- A feature list for anything unbuilt.

### Changes to existing content in Phase A

**None.** The FAQ answers and the README stay exactly as they are, because they
are still true. Hedging them now, before there is anything to sell, is itself
a bait-and-switch signal, and a reader who noticed would be right to.

---

## Phase B: only when Team is running in production

Publish this when an org can sign up, pay, invite someone and have terms land
on their machine. Not when it is nearly done.

### Page

A dedicated route, `/pricing`, linked from the nav. Not the home page; the home
page's job is still the demo.

### Headline

> **Free forever. Paid only for what we run for you.**

### Subhead

> Lexicon is MIT-licensed and complete. Ashlr.AI sells one thing on top of it:
> a shared lexicon we host for your whole organization, so nobody curates the
> same twenty words twice.

### Tier cards

Three cards. Free is on the left and is the visual default, not a stub next to
two bigger cards. It is the product.

---

#### Card 1: Free

**Price:** `$0` · *forever, MIT*

**One line:** `Everything Lexicon does, on your own machines.`

**Bullets.** Every one of these is `SHIPPED` unless marked:

- Unlimited terms, unlimited machines, unlimited people
- The `lexicon` CLI for macOS, Linux and Windows
- The MCP server: nineteen tools, two resources, two prompts
- Claude Code plugin, with `SessionStart` and `UserPromptSubmit` hooks
- Browser extension for ChatGPT, Claude.ai, Gemini, Grok, Perplexity, Copilot and Poe (not in the Chrome or Firefox stores yet; unpacked install)
- macOS menu bar app for any text field (ad-hoc signed, not notarized)
- Loopback HTTP API, and the matcher as a library
- Fifteen export formats and seven importers, including Wispr Flow and Superwhisper
- Four starter packs, 155 terms
- Share a lexicon by committing `.lexicon.yaml` to a repository
- **`PLANNED`** Pull a shared lexicon from any URL you host yourself (unlimited)

**Footnote under the card:**

> No account. No telemetry. No network request beyond loopback.

**CTA:** the install command, matching the existing install block.

---

#### Card 2: Team

**Price:** `$6` per user / month · *billed annually. $8 month-to-month.*

**Badge:** `Free for the first 5 people`

**One line:** `One vocabulary for the whole company, hosted by us.`

**Bullets:**

- A shared lexicon every member's machine pulls automatically
- Your own file always wins; an admin can never overwrite what you typed
- Roles: owner, admin, editor, member
- Members propose terms; admins approve. Your agent can propose one it just learned
- Audit trail of every change, 90 days
- SSO: SAML and OIDC, included, not an upsell
- Email support

**CTA:** `Start a team` → self-serve signup.

---

#### Card 3: Enterprise

**Price:** `Talk to us`. No number on the page.

**One line:** `Fleet deployment, self-hosting, and a contract behind it.`

**Bullets:**

- Everything in Team
- Signed and notarized installers, a configuration profile and a managed policy file for MDM
- Self-hosted or on-premise sync, so nothing leaves your network
- SCIM provisioning
- Long audit retention and export
- Support with a written SLA and a named contact
- IP indemnification

**CTA:** `mason@ashlr.ai`

---

### The honest note under the table

Not a footnote. Full width, legible, directly below the cards:

> **What is built, and what is not.** Everything in Free is shipped today
> except pulling from a URL, which is marked. Team and Enterprise are new
> products. We will tell you on the first call exactly which pieces are
> running and which are in progress, and we will not describe a roadmap in the
> present tense. The whole plan, including what it costs us to run, is public:
> [COMMERCIAL.md](https://github.com/ashlrai/lexicon/blob/main/docs/COMMERCIAL.md).

Keep this even after everything ships. It is the page's most persuasive
paragraph, and it costs nothing once it is true.

---

## FAQ entries

These go in the `FAQ` array in `web/lib/site.ts`, which also generates
`docs/FAQ.md`, `/llms.txt`, `/llms-full.txt` and the `FAQPage` JSON-LD. House
style applies: each answer must stand alone when quoted, must not open with
"it", and must state something checkable against the repository.

### Rewrite in Phase B: *"What does Lexicon cost?"*

The current answer says `no paid tier`. It becomes false the day Team ships.
Replace it then, and not before:

> Lexicon itself costs nothing and is MIT-licensed: the matcher, the CLI, the
> MCP server, the Claude Code plugin, the browser extension and the macOS menu
> bar app are all in one public repository at github.com/ashlrai/lexicon, with
> no seat limit, no term limit and no telemetry. Nothing that is free today
> becomes paid later. Ashlr.AI separately runs a hosted shared lexicon for
> organizations, at $6 per user per month with the first five people free,
> which is a service we operate rather than a part of Lexicon held back from
> you; a team that would rather host the same thing itself can point every
> machine at a lexicon file at any URL it controls, for nothing.

### Rewrite in Phase B: *"Is my text sent anywhere?"*

The current answer says `no account, no sync`. The first clause stays true for
the free tool; the second does not survive Team. The rewrite must keep the
strong claim where it is still strong:

> No. Your lexicon is a plain YAML file at `~/.config/lexicon/lexicon.yaml`,
> and the CLI, the hooks, the MCP server, the local API and the browser
> extension make no network request beyond the loopback interface. The only
> outbound request anywhere in the codebase is `lexicon voice` downloading a
> whisper.cpp model the first time you use local push-to-talk; audio itself
> never leaves the machine. A team on a paid plan syncs its shared word list to
> Ashlr.AI, and that is the word list only: no transcript, no audio and no
> text you dictate is transmitted on any plan, because there is no code path
> that could. The full threat model is in SECURITY.md.

The load-bearing sentence is **"that is the word list only"**. Do not soften
it, and do not drop the clause explaining why. A reader who has been told
"nothing is sent" once will read any hedge as the retraction.

### New in Phase B: *"What do I get for paying, if the code is free?"*

> A service, not a licence. Lexicon is MIT-licensed, so any company may deploy
> it on ten thousand machines commercially, for nothing, forever, and that
> grant cannot be withdrawn from any version already published. What Ashlr.AI
> sells is the part a licence cannot cover: a hosted shared lexicon with
> identity, roles and an audit trail, support with an obligation behind it,
> and (on Enterprise) indemnification, which the MIT licence explicitly
> disclaims. If you would rather run it yourself, Lexicon can pull a shared
> lexicon from any URL you host, and that path is free and unlimited.

### New in Phase B: *"Can my company just self-host this?"*

> Yes, and Lexicon is built so that you can. Point every machine at a lexicon
> file at any URL you control (a raw GitHub file, an S3 object, an internal
> file server), and your whole team shares one vocabulary with no account and
> no seat limit. What the paid plans add is the part self-hosting does not give
> you: who changed what and when, roles and approvals, SSO, and someone to
> call. Enterprise can also run the full sync service inside your own network.

### New in Phase B: *"What happens to my terms if Ashlr.AI disappears?"*

> You keep them. Your vocabulary is a YAML file on your own disk, the engine is
> MIT-licensed, and every version already published stays MIT and cannot
> practically be withdrawn. A team on a paid plan can export the shared lexicon at any time in
> the same plain YAML format the free tool reads, so the exit is a download and
> a file path, not a migration.

### Leave alone

Every other FAQ entry is unaffected. Do not re-word the security answers to
make room for a sales message.

---

## Nav, metadata and the machine-readable surfaces

- **Phase A:** add `Teams` to the nav, pointing at the on-page section. Nothing
  else changes. `llms.txt`, `llms-full.txt`, `mcp.json` and the JSON-LD need no
  edit, because no fact changed.
- **Phase B:** add `Pricing` to the nav pointing at `/pricing`; add the route
  to `sitemap.ts`; regenerate `docs/FAQ.md` from `site.ts`; re-run
  `node scripts/check-facts.mjs` (docs, `web/app`, `web/components` and
  `web/lib` are all scanned, so a wrong tool or format count on the pricing
  page fails the build).
- Do **not** add `Offer` or `Product` JSON-LD in Phase A. In Phase B, add it
  only for tiers with a published price, never for Enterprise, which has none.
- The existing `DESCRIPTION` and `TAGLINE` stay as they are. Lexicon's
  one-line pitch is not "team vocabulary management", and the day it becomes
  that is the day the free tool stops being the point.

---

## Licensing communication

The recommendation asked for in the brief, in full. **No file in this spec's
scope was edited; `README.md` and `LICENSE` belong to other owners.**

### `LICENSE` stays exactly as it is

Yes. Unchanged, unannotated, not dual-licensed. Do not add a commercial
exception, a "portions of this software" clause, or a pointer to a paid
product. The file's value is that it is the plain, unmodified MIT text that a
scanner, a registry and a lawyer all recognise in under a second. Every
sentence added to it costs more than it earns.

### Do **not** add `COMMERCIAL-LICENSE.md`

Not now, and probably not ever in this repository. Every line of code here is
MIT. A second licence file sitting beside `LICENSE` makes a reader stop and
hunt for the carve-out, and there is no carve-out, so they are hunting for
something that does not exist, which is a worse first impression than saying
nothing.

PostHog's approach is the one to copy *if* a carve-out ever becomes necessary:
an MIT root with an explicit sentence naming a single directory
(`"All content that resides under the 'ee/' directory of this repository … is
licensed under the license defined in 'ee/LICENSE'"`) and the proprietary seat
licence living in that directory. But the plan in
[TEAM-SYNC.md](TEAM-SYNC.md#what-goes-in-the-mit-repo-and-what-does-not) does
not need it: the paid client ships as a **separate package**,
`@ashlr/lexicon-team`, carrying its own licence. A commercial licence belongs
in the commercial artifact, not in the free one.

### Do **not** add a `NOTICE` file

`NOTICE` has a specific meaning in Apache-2.0 practice: attribution that
redistributors must carry. In an MIT project it is decoration, and tooling that
looks for it will draw wrong conclusions.

### Where the commercial story goes instead

Three places, in priority order:

1. **`docs/COMMERCIAL.md`** exists now. The complete reasoning, public on
   purpose. A prospective customer reading the pricing rationale, the risks and
   the competitor table is a *good* outcome.
2. **`docs/ENTERPRISE.md`**: exists now. The buyer-facing version.
3. **One paragraph in the README's License section**, added only in Phase B.
   Suggested text, for whoever owns `README.md`:

   ```markdown
   ## License

   MIT. Copyright 2026 Ashlr.AI.

   Everything in this repository is MIT-licensed and stays that way. Nothing
   here is time-limited, seat-limited or waiting behind a plan, and no
   capability that is free today will be moved behind one. Ashlr.AI separately
   operates a hosted shared lexicon for organizations
   ([docs/COMMERCIAL.md](docs/COMMERCIAL.md)); that is a service we run, not a
   part of this tool that was taken out of it.
   ```

### The three statements that must change together

These are currently true and become false the moment anything is sold. They
must be updated in **one change, at the moment of launch**, not softened in
advance, and not left stale afterwards.

| Where | Current text | Why it breaks |
| --- | --- | --- |
| `README.md`, *Roadmap and non-goals* | "this is not a dictation app, and there are no hosted accounts and no sync service. It is a file." | Directly contradicts a hosted sync product. This is the sentence someone will screenshot. |
| `web/lib/site.ts` → FAQ, *"What does Lexicon cost?"* | "Nothing. Lexicon is free and MIT-licensed, with no paid tier…" | "No paid tier" becomes false. |
| `web/lib/site.ts` → FAQ, *"Is my text sent anywhere?"* | "there is no account, no sync and no telemetry" | "No sync" becomes false. "No telemetry" and "no text is sent" stay true and must be preserved loudly. |

Replacement text for the first one, for the README owner:

> Non-goals: this is not a dictation app, and the tool itself has no accounts
> and makes no network request beyond loopback. It is a file. Ashlr.AI
> separately runs an optional hosted service for organizations that want one
> shared lexicon across every employee's machine; the tool works completely
> without it, and always will.

### How to phrase "free and open source, with paid team features"

One rule does most of the work: **say what will never be taken away, in
specific terms, before mentioning anything that costs money.** A reader
deciding whether this is a bait and switch has already decided by the end of
the first sentence.

Four phrasings to use:

- "a service we operate, not a part of this tool we took away"
- "nothing that is free today becomes paid later"
- "every version already published stays MIT, and that grant cannot be
  withdrawn"
- "a team that would rather host the same thing itself can, for nothing" is
  **the strongest one available**, and it is only available because
  `lexicon remote` ships free. It converts the whole question from "what are
  they holding back?" to "which do you prefer?". Protect it: the moment
  self-hosting is crippled to drive upgrades, every other sentence on this list
  stops being believable.

Four phrasings to avoid:

- "open core": accurate as a category, and it primes a reader to look for the
  removed parts.
- "free tier" implies the free thing is a sample of the paid thing. It is not;
  it is the whole product.
- "upgrade to unlock". Nothing is locked. Nothing may ever be locked.
- "community edition" signals a deliberately lesser version, which is exactly
  what [Cal.com's `cal.diy`](https://cal.com/blog/cal-diy-open-source-to-closed-source)
  turned out to be, and readers in this space now recognise the pattern.

---

## See also

- [COMMERCIAL.md](COMMERCIAL.md) has the reasoning, the comparables and the risks.
- [ENTERPRISE.md](ENTERPRISE.md) is the buyer-facing document this page links to.
- [TEAM-SYNC.md](TEAM-SYNC.md) lists what has to exist before Phase B may ship.
- [LANDING.md](LANDING.md) carries the design direction and the rules about what may be published as a number.

Back to [the docs index](README.md).
