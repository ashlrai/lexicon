# The commercial model

How Lexicon makes money without taking anything away from the people who
already have it. Written for Ashlr.AI, not for a customer; the buyer-facing
version is [ENTERPRISE.md](ENTERPRISE.md).

Prices researched 2026-09-20 against vendors' own pricing pages. Verify before
quoting externally; this category re-prices often, and the secondary sources
about it are unusually wrong.

---

## Recommendation: do not sell yet

The rest of this document designs a commercial model that is, I believe,
correct. This section says when to switch it on, and the answer is not today.

**The facts as of 2026-09-20:**

| | |
| --- | --- |
| Repository created | 2026-09-19 |
| First npm publish | 2026-09-20, about six hours ago |
| GitHub stars / forks | 1 / 0 |
| npm downloads | none recorded yet; the downloads API has no data for this package |
| Telemetry | none, by design, so there is no other signal |
| Known organizations using it | zero |
| Conversations with a team of ten or more about a shared lexicon | zero |

Publishing a price list for a Team product that does not exist, on a project
that is a day old and has never been deployed by anyone, would be selling a
roadmap. It would also spend the one asset the project actually has right now,
which is credibility with the small number of people who might try it first.

**The order to do this in:**

1. **Ship `lexicon remote` under MIT.** Week 1 of
   [TEAM-SYNC.md](TEAM-SYNC.md#build-order). A lexicon layer pulled from any
   URL, free and unlimited. It makes free team sharing genuinely good, it is
   one week of work, and it is the honest foundation for charging later: you
   cannot be accused of holding sharing hostage when sharing ships free.
2. **Put up a contact line, not a price list.** One short section on the site:
   *"Using this across a team? Tell us what you need."* No tiers, no numbers,
   no feature promises. This costs nothing, breaks no promise, and produces the
   only input that matters.
3. **Have five real conversations** with organizations of ten or more people
   who dictate. Not "would you pay?" but *"show me how your team handles this
   today."* If fewer than three of the five have independently hacked together
   a way to share a word list, the Team product is a solution to a problem
   nobody has, and the right answer is to keep Lexicon free and get it adopted.
4. **Only then build**, and only then publish prices.

**What would change this answer:** an inbound request from a company. One
unsolicited "can we deploy this across our team and pay you for it" is worth
more than everything in this document, and it flips step 3 from research to a
design partnership. Until that arrives, the numbers below are a plan, not a
price list.

The rest of this document assumes the answer eventually becomes yes.

---

## What MIT gives away, permanently

The code is published under MIT. Every version already released, 0.1.0 through
0.5.1, carries that grant, and the grant is not coming back.

**What any company may do today, forever, without paying and without asking:**

- Install it on ten thousand machines.
- Use it commercially, including inside a product they sell.
- Modify it, rebrand it, and ship the result.
- Fork it and maintain a competing version.
- Never tell us any of the above happened.

This is not a loophole. It is what we offered, and it is the reason the tool
gets recommended by agents, listed in registries and installed without a
conversation. Treat it as the distribution strategy it is.

**Is that grant actually irrevocable?** In practice yes, and the best
written analysis is Kyle Mitchell's *[Two Kinds of
Relicensing](https://writing.kemitchell.com/2023/09/23/Two-Kinds-Relicensing)*:
going-forward relicensing changes only new releases, and *"prior versions with
MIT or Apache 2 or MPLv2 or what have you in the LICENSE file remain available
to use, share, and change under those terms."* He also makes the practical
point that it is *"probably just impossible to run down all copies of a
software project floating around the Web with the old license terms."*

One honest caveat worth knowing: MIT, unlike Apache-2.0, does not contain the
word "irrevocable". The gap is real enough that an explicitly irrevocable MIT
variant was proposed to the OSI in July 2025. The consensus reading is that
open-source licences function as contracts and cannot simply be withdrawn, but
it is a reading rather than settled law. It does not change the recommendation;
it is just a thing to know before repeating "irrevocable" in a sales call.

---

## What MIT does not give away

This is where the revenue is, and there are exactly five things on the list.

| | Why MIT cannot cover it |
| --- | --- |
| **A service we operate** | MIT licenses code. It does not oblige us to run a server, hold anyone's data, or keep anything online. A hosted shared lexicon is an operation. |
| **Our trademarks** | MIT grants no rights to the Lexicon or Ashlr.AI names. A fork may take the code; it may not take the name. |
| **A warranty and indemnification** | MIT disclaims both, in capital letters. A separate commercial agreement can add them. This is the single item with no free substitute anywhere. |
| **Support with an obligation attached** | An issue tracker is a courtesy. An SLA is a contract. |
| **Compliance artifacts** | A DPA, a sub-processor list, a security questionnaire answered by a named human, eventually an audit. These are company capabilities, not code. |

Everything we charge for has to come from that list. Anything else is a feature
that lives in a binary a customer can legally modify, which means the paywall
is theatre.

---

## Why relicensing is rejected

Relicensing future versions is **legally available to us right now, and more
cheaply than it ever will be again.** It is worth stating plainly rather than
waving it away:

- There are 30 commits by one author. Ashlr.AI holds copyright in 100% of the
  code. There is no contributor licence agreement gap to close and nobody to
  ask.
- There is no community to fork yet: one star, no forks, no downstream
  packagers.
- The credible target would be the **Functional Source License** (FSL), which
  Sentry wrote after finding BUSL's four-year term too long and its variable
  Additional Use Grant too hard for compliance departments to approve. FSL
  converts to MIT or Apache-2.0 after **two years, per version**, and forbids
  only use that competes with the producer.

So the question is not "can we", it is "should we". The answer is no, for four
reasons, in order of weight:

**1. The licence is the distribution.** Lexicon reaches people through the MCP
registry, Glama, the Anthropic plugin directory, awesome-lists, Homebrew and
npm, and most importantly through an agent reading a registry entry and
recommending it. Several of those channels are open-source-only by policy, and
all of them are cheaper than any sales motion we could run.
[DISTRIBUTION.md](DISTRIBUTION.md) lists eleven of them and nine are not yet
executed. We have not yet collected the value MIT was supposed to buy us.

**2. There is nothing to protect.** FSL and BUSL defend against a competitor
hosting your software as a service. We have no hosted service. Relicensing now
would pay the full cost of a source-available licence to protect an asset that
does not exist.

**3. It contradicts the project's own thesis.**
[RESEARCH.md](RESEARCH.md#verdict) concludes: *"Do not raise on it. It is a
utility, and its best outcome may be that platforms adopt the idea."* A
source-available licence makes platform adoption impossible. If we no longer
believe that thesis, change the thesis on purpose and in writing; do not
change it accidentally by changing the licence.

**4. Cal.com is a fresh cautionary tale about where the boundary goes.**
Cal.com ran an AGPL-core-plus-enterprise-directory model for about four and a
half years and abandoned it in April 2026: the production codebase moved to a
private repository, and the public repo was renamed to `cal.diy` with
Organizations, SSO, workflows and audit logging stripped out and a README
warning that it is *"strictly recommended for personal, non-production use"*
([their own write-up](https://cal.com/blog/cal-diy-open-source-to-closed-source)).
The lesson is not "open core fails"; it is that a boundary drawn at **features
inside one binary** collapses under pressure, while a boundary drawn at a
**hosted service** does not. Tailscale has kept its Linux and Android clients
open for years while the coordination server, the actual business, stays
closed, and has publicly committed to
[supporting Headscale](https://tailscale.com/blog/opensource), the open-source
reimplementation of that server, as a complementary project.

**Draw the boundary where Tailscale drew it.**

**The one condition to revisit:** a funded competitor ships a hosted team
lexicon that is recognisably a port of this codebase, *and* we have paying
customers to protect. Even then the move is to license the **server**, which
was never MIT, rather than to claw back the client.

A related question, since it comes up: should future versions ship under
**Apache-2.0** instead, for its explicit irrevocability and patent grant? It
would be a technically better licence. It is not worth doing now: the
practical risk it removes is near zero, and editing the LICENSE file is exactly
the signal we are trying not to send. Keep it on the list for a future
deliberate licence event, if there ever is one.

---

## The comparables

### Dictation and voice, the direct category

All read from the vendors' own pricing pages on 2026-09-20.

| Vendor | Free tier | Paid | Shared/team dictionary | SSO |
| --- | --- | --- | --- | --- |
| [Wispr Flow](https://wisprflow.ai/pricing) | 2,000 words/week desktop, 1,000/week mobile | Pro **$15/mo**, **$12/seat/mo annual**; Growth $23 / **$18 annual**; Growth + Notetaker $33 / $26; Enterprise custom, annual only | **Yes, at Pro ($12)**: "shared dictionary and snippets" | **Growth, $18/seat** |
| [superwhisper](https://superwhisper.com/#pricing) | Permanent, local Whisper models only, 2 modes; 3,000 words of Pro to start | Pro **$8.49/mo**, **$84.99/yr**, **$249.99 lifetime**; Enterprise seat-based, price unpublished | No team dictionary at all; custom vocabulary is on the *free* tier | Not published |
| [Aqua Voice](https://aquavoice.com/pricing) | 1,000 words, one-time, not recurring | Pro **$8/seat/mo annual** ($10 monthly); Max $24 / $30; **Team (2-9 seats) $12/seat/mo annual** ($15 monthly); Business (10+) custom | **"Team-wide Dictionaries" is Business only** (10+ seats, custom price), *not* in the $12 Team plan | Business, custom, 10+ seats |
| [Otter.ai](https://otter.ai/pricing) | 300 min/month; **custom vocabulary capped at 5 terms** | Pro $16.99 / **$8.33 annual**; Business $24 / **$19.99 annual**; Enterprise by demo | 800 names + 800 terms at Business ($19.99) | Enterprise, **100-seat minimum** |
| [Talon Voice](https://talonvoice.com/) | The whole app, free | Optional Patreon: **$5 / $25 / $100 per month** | n/a | n/a |
| Dragon / Nuance | n/a | **No longer purchasable per-seat.** Every consumer and professional Dragon URL now 404s or redirects to Microsoft's health-solutions pages, which publish no prices. It is an enterprise healthcare contract now. | n/a | n/a |

Four things fall out of that table:

- **$12/seat/month billed annually is where this market converges.** Wispr Pro
  and Aqua Team land on exactly the same number from different directions.
- **A shared dictionary is already table stakes at $12** (Wispr), and Aqua
  charges a custom enterprise price for the same thing. The market disagrees
  about what it is worth, which means there is room to be clear about it.
- **SSO is priced between $18/seat and a 100-seat minimum.** There is an
  obvious gap for SSO at a small seat count.
- **Nobody in this category publishes an on-premise or self-hosted option.**

The uncomfortable one: **Wispr Flow already ships a shared team dictionary at
$12/seat.** Our answer has to be the project's original thesis, stated
plainly: Wispr's dictionary corrects Wispr's transcripts. It does nothing for
Claude Code's own speech recognition, for ChatGPT voice, for Cursor, or for a
phone keyboard. The portable layer is the product; if that argument does not
land, the Team tier does not either.

One correction to our own file: [RESEARCH.md](RESEARCH.md#evidence) cites
Aqua's *"custom dictionary of up to 800 terms"*. That number appears only in an
Aqua **blog post**, not on the pricing page, not in the dictionary guide, and
not in their `llms.txt`. Otter publishes 800 names + 800 terms as a real plan
limit, so the figure may be cross-contaminated. Treat 800 as soft and do not
put it on the website.

### Open core generally

| Company | The free/paid boundary | Prices |
| --- | --- | --- |
| [Tailscale](https://tailscale.com/pricing) | Clients open source; **the coordination server is closed, and it is the business** | Personal free **up to 6 users**; Standard **$8/user/mo**; Premium **$18**; Enterprise custom. **SSO and SCIM are in the cheapest paid tier** |
| [Sentry](https://sentry.io/pricing/) | BSD → BUSL → **FSL** (converts to MIT/Apache after 2 years, per version) | Developer $0 (1 user); Team **$26/mo**; Business **$80/mo**; Enterprise custom. SAML and SCIM are **Enterprise-only** |
| [PostHog](https://posthog.com/pricing) | **MIT root plus an `ee/` directory under a proprietary seat licence.** Advertises "97% of companies use PostHog for free" | Add-ons: Boost **$250/mo** (SSO enforcement, 7-day activity log), Scale **$750/mo** (SAML, 2-month retention), Enterprise custom (RBAC, SCIM, 60-month retention) |
| [Grafana](https://grafana.com/pricing/) | Apache-2.0 → **AGPLv3** in 2021 | Cloud Free; Pro **$19/mo** + usage + **$8/active user**; Enterprise **$25,000/year minimum commit**. Enterprise self-managed includes SAML, RBAC, SCIM, team sync, 2-hour critical response and **indemnification** |
| [Plausible](https://plausible.io/) | AGPL, self-host free; cloud omits funnels, journeys, ecommerce goals, SSO and the sites API | Starter **$9/mo**, Growth **$14**, Business **$19**, Enterprise custom. Annual saves two months |
| [Cal.com](https://cal.com/pricing) | AGPL + `/ee` for 4.5 years, then **closed in April 2026** | Teams **$12/user/mo annual**; Organizations **$28** (SAML + SCIM); Enterprise custom |

**The pattern that repeats in every one of them:** SSO/SAML, SCIM, audit logs,
RBAC, a support SLA and indemnification. That is the enterprise checklist, and
it is remarkably stable across six companies in four different categories.

**Two refinements worth stealing:**

- **Do not tax SSO.** [sso.tax](https://sso.tax/) documents 200+ vendors
  gating SSO behind enormous multiples: Appsmith $15 → $2,500 (16,567%),
  Railway $20 → $2,000, GitHub $4 → $21. It does this under the argument
  that *"security shouldn't be a premium feature."* Tailscale includes SSO and
  SCIM in its cheapest paid tier and earns goodwill for it. Since Wispr charges
  $18/seat for SSO, including it at our lowest paid tier is both the right
  thing and a sharp competitive position.
- **Sell log *retention*, not log *existence*.** PostHog's ladder is 7 days →
  2 months → 60 months, and Tailscale holds flow logs for its $18 tier while
  selling SSO at $8. Giving every paid customer an audit trail and charging
  Enterprise for long retention and export is more defensible than hiding the
  feature.

---

## The proposed tiers

Three tiers. The boundary between them is **who operates the thing**, never
which features a binary is willing to execute.

### Free: MIT, forever, uncrippled

**Status: shipped, except where noted.**

Everything that exists today and everything that would be built for the local
experience tomorrow:

- The matcher, the CLI, the MCP server (nineteen tools), the Claude Code plugin
  and hooks, the browser extension, the macOS menu bar app, the loopback HTTP
  API, the clipboard daemon, local voice, the starter packs, fifteen exporters
  and seven importers, the importable library.
- Sharing a lexicon by committing `.lexicon.yaml` to a repository, with the
  trust gate.
- **`lexicon remote`: *planned, week 1*.** Pull a lexicon layer from any URL
  you control: a raw GitHub file, an S3 object, an internal file server.
  Unlimited members, unlimited terms, no account. This is the part that matters
  most for the integrity of the whole model, and it must ship *before* anything
  is sold.

No seat cap. No term cap. No time limit. No telemetry. No feature that exists
in the codebase and refuses to run.

**The commitment, which should be written down publicly and kept:** nothing
currently free becomes paid. New capabilities may be paid; existing ones never
move.

### Team (the hosted shared lexicon)

**Status: entirely unbuilt.** Scope in [TEAM-SYNC.md](TEAM-SYNC.md).

**$6 per user per month, billed annually. $8 billed monthly. Free for the first
5 members.**

What is in it, none of which is a binary refusing to run:

- A hosted org lexicon that every member's machine pulls automatically, sitting
  *below* each person's own file so an admin push can never overwrite what
  someone typed for themselves.
- Roles: owner, admin, editor, member.
- Proposals. A member's agent can offer to push a correction it just learned
  up to the team.
- An audit trail of every change, with 90-day retention.
- **SSO (SAML and OIDC), included at this tier.**
- Email support, best effort, no SLA.

**Why $6:**

1. **It is half the category's convergence price**, and it should be. Lexicon
   is the layer beside the dictation app, not the dictation app. A buyer who
   already pays Wispr $12 or Aqua $12 will not pay the same again for a
   complement, but will pay half without thinking hard about it.
2. **It is below Tailscale's $8**, which is the right anchor for a small
   per-seat utility that IT buys and forgets, and Tailscale is doing something
   considerably more load-bearing.
3. **It is not so cheap that it is unserious.** A $2 tool attracts the same
   support load as a $6 one and gets no procurement attention. The floor is set
   by support cost, not by willingness to pay.
4. **It undercuts SSO by 3x.** Wispr's cheapest SSO is $18/seat. Ours is $6.
5. **The deal sizes work out sane.** 20 seats is $1,440/year: self-serve only,
   never worth a call. 200 seats is $14,400/year, a real contract. 1,000 seats
   is $72,000/year, which is a company.

The 25% annual discount matches Cal.com's; five free seats is a little tighter
than Tailscale's six and generous enough that a startup adopts it before it
ever buys.

**The value argument, and where it is weak.** The tempting pitch is per-person
time: someone who dictates all day hits an out-of-vocabulary company term
roughly twenty times a day, and at six seconds each to notice and repair that
is about 44 minutes a month, call it $44 of loaded time. $6 against $44 is a
good ratio.

**But that argument mostly justifies the free tier, not the paid one**, because
a person who curates their own file already gets it. The honest Team argument
is narrower and better: *the words your colleagues were never going to add.*
The engineer will spend twenty minutes on a YAML file. The salesperson, the
designer, the support rep and the new hire in week one will not, and they are
the ones sending your company's name out with a spelling mistake in it. A
shared lexicon is the only version of this that reaches them. Sell that, and do
not lean on the per-person time maths, because a sharp buyer will notice it
argues for the free tier.

### Enterprise: quoted, not listed

**Status: entirely unbuilt, and several items should not be built until
something is signed.**

Anchor at **$14 per user per month, annual**, with a **$12,000/year floor**.

- Fleet deployment: signed and notarized macOS `.pkg` and a Windows MSI, a
  configuration profile, a managed policy file, silent enrolment.
- Self-hosted or on-premise sync, a container image and a database you own.
- Long audit retention and export.
- SCIM provisioning.
- Support with a written SLA and a named contact.
- **Indemnification.** The one item on the list with no free substitute. Our
  position is unusually clean: a single copyright holder, no CLA gaps, and 98
  production dependencies of which 87 are MIT, 8 ISC, 2 BSD-3-Clause and 1
  BSD-2-Clause, with **no copyleft anywhere in what ships**.

The floor matters more than the rate. Below roughly seventy seats, an
enterprise deal costs a one-person company more in questionnaires, redlines and
support than it returns. The floor is a qualification tool, and Grafana's
$25,000 minimum commit is the same instrument at a larger scale. **Do not sign
an Enterprise deal below the floor to get a logo.**

**Do not build SSO, SCIM or the MDM package on spec.** Building enterprise
plumbing before a customer asks is the most reliable way for a small team to
lose a month.

### The summary table

| | Free | Team | Enterprise |
| --- | --- | --- | --- |
| Price | $0 forever | $6/user/mo annual, $8 monthly | from $14/user/mo, $12k/yr floor |
| Free seats | unlimited | first 5 | n/a |
| Everything shipped today | ✓ | ✓ | ✓ |
| Share via repo or any URL you host | ✓ | ✓ | ✓ |
| Hosted shared lexicon | no | ✓ | ✓ |
| Roles and proposals | no | ✓ | ✓ |
| Audit trail | no | 90 days | long retention + export |
| SSO (SAML/OIDC) | no | ✓ | ✓ |
| SCIM | no | no | ✓ |
| Fleet deployment and managed policy | no | no | ✓ |
| Self-hosted sync | self-host any URL | no | ✓ managed |
| Support | community | email, best effort | SLA + named contact |
| Indemnification | no | no | ✓ |
| **Built today** | **yes, except `remote`** | **no** | **no** |

---

## Shipped versus planned

The landing page must not blur this line, so it is stated once, precisely.

**Shipped, working, in the public repository today:** the matcher; the CLI (25
commands); the MCP server (nineteen tools, two resources, two prompts); the
Claude Code plugin with `SessionStart` and `UserPromptSubmit` hooks; the
browser extension; the macOS menu bar app; the loopback HTTP API; the clipboard
daemon; local voice via ffmpeg and whisper.cpp; four starter packs (155 terms);
fifteen exporters and seven importers; the trust gate; the benchmark.

**Shipped with a distribution caveat:** the browser extension is not in the
Chrome or Firefox stores (unpacked install only), and the macOS app is ad-hoc
signed and not notarized (Gatekeeper blocks first launch). Both matter for any
fleet-deployment claim and neither may be described as fleet-ready.

**Planned, not built. Every single item:** `lexicon remote`; the hosted org
lexicon; accounts, device login and orgs; roles; proposals; the audit trail;
SSO; SCIM; the admin console; billing; signed and notarized installers; the
MSI; the configuration profile; the managed policy file; self-hosted sync; any
SLA; indemnification as an executed contract term.

---

## The risks, honestly

**1. A competitor can fork the MIT core, and one specific competitor can afford
to.** Wispr Flow raised a $280M Series B and already ships shared team
dictionaries at $12/seat. Extending that to a portable API is not hard for
them. Our defence is not the code (they do not need our code); it is being
the neutral layer that works with every recognizer including theirs, which a
dictation vendor has a structural reason not to build.

**2. The `remote` client in MIT core is a blueprint for someone else's
server.** This is the Headscale situation, accepted deliberately. Tailscale
publicly supports Headscale and is fine. The people who self-host were not
going to pay.

**3. The Team product has to be built and then operated forever.** Six weeks to
a credible v1, and then a permanent on-call obligation held by one person.
Infrastructure is cheap: call it $150 to $300/month for the first few
hundred seats. Attention is not.

**4. Support consumes the founder.** Every enterprise conversation costs days
of questionnaires and redlines. This is the real reason for the Enterprise
floor, and the reason Team must be entirely self-serve.

**5. Our own kill criteria cut against selling annual contracts.**
[RESEARCH.md](RESEARCH.md#kill-criteria) names two events that would shrink
this project: Claude Code shipping first-party custom vocabulary, or a
system-wide dictation app capturing agent voice input with a dictionary that
follows the user. Either would damage the Team tier more than the free tool.
Selling multi-year commitments against that is a disclosure question, not just
a business risk. Prefer annual terms; do not sell three-year deals.

**6. Channel conflict.** We currently export into Wispr Flow and Superwhisper
and list them as compatible. Selling a competing team feature changes that
relationship. Keep the exporters, keep the nominative-use framing in
[LANDING.md](LANDING.md#trademark-policy), and do not run comparison marketing
against the vendors we interoperate with.

**7. The market may not exist.** No organization has asked for this. That is
the whole reason for the recommendation at the top.

---

## Licensing communication

The full recommendation, including exact wording, is in
[pricing-content.md](pricing-content.md#licensing-communication). In short:

- **`LICENSE` stays exactly as it is.** Do not edit it, do not annotate it, do
  not dual-license the core.
- **Do not add `COMMERCIAL-LICENSE.md` yet.** Every line in this repository is
  MIT; a second licence file next to it invites a reader to hunt for the catch
  that is not there. When `@ashlr/lexicon-team` exists, its licence ships in
  *that* package.
- **Do not add a `NOTICE` file.** It has a specific meaning in Apache-2.0
  practice and adds confusion in an MIT project.
- **Three existing public statements will become false** the day anything is
  sold, and must be updated in the same change, never before and never after:
  the README's non-goal *"there are no hosted accounts and no sync service"*,
  and the FAQ answers *"What does Lexicon cost?"* and *"Is my text sent
  anywhere?"*.

---

## See also

- [ENTERPRISE.md](ENTERPRISE.md) is the same offering written for a buyer.
- [TEAM-SYNC.md](TEAM-SYNC.md) scopes what has to be built for Team to be real.
- [pricing-content.md](pricing-content.md) is the landing-page spec handed to the `web/` owner.
- [RESEARCH.md](RESEARCH.md) has the market analysis this builds on, and the kill criteria.
- [DISTRIBUTION.md](DISTRIBUTION.md) covers the open-source channels the licence buys.

Back to [the docs index](README.md).
