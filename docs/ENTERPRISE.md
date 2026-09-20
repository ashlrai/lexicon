# Lexicon for organizations

Written for the person evaluating this for a company, not for the person
installing it. If you are here to deploy it yourself, start at
[QUICKSTART.md](QUICKSTART.md).

> **What is available today.** Everything in the section *"What you can deploy
> today, for nothing"* is shipped and MIT-licensed. Everything
> under *"Team"* and *"Enterprise"* is **planned and not yet built**. Those
> sections are marked. We would rather lose a deal than sell you a roadmap
> described in the present tense. If you need the Team or Enterprise
> capabilities on a date, tell us the date and we will tell you honestly
> whether we can meet it.

---

## The problem, in one paragraph

Speech-to-text is about 95% accurate on ordinary English and close to useless
on the words your company invented. It fails on precisely the words that
matter: your company name, your product names, your people, your internal
systems. When a transcript goes to a person they read past it. When it goes to
an AI agent, the agent searches your codebase for a name that does not exist
and guesses. Lexicon is one small file of those words, applied to every
transcript before an agent or a text field sees it.

Measured on 330 real audio clips: proper nouns recovered went from 41.9% to
82.8%. On a synthetic corpus of speech-to-text errors, 5.1% to 96.5%. Zero of
95 ordinary prose sentences were changed incorrectly. Method, corpora and the
cases that still fail are in [BENCHMARK.md](BENCHMARK.md), and the benchmark is
reproducible with one command.

---

## What you can deploy today, for nothing

**Shipped. MIT-licensed. No account, no contract, no conversation with us
required.**

| Capability | How it reaches your people |
| --- | --- |
| The correction engine | A CLI (`lexicon`) on macOS, Linux and Windows, Node 20+ |
| AI agents | An MCP server with nineteen tools, registered automatically into Claude Code, Claude Desktop, Codex, Cursor, Windsurf, Gemini CLI and VS Code |
| Claude Code specifically | A plugin with `SessionStart` and `UserPromptSubmit` hooks, so corrections land before the model reads the prompt |
| Browser chat | An extension for ChatGPT, Claude.ai, Gemini, Grok, Perplexity, Copilot and Poe |
| Any macOS text field | A menu bar app using the Accessibility API: Slack, Mail, Notes, your editor |
| Your own tooling | A loopback HTTP API, and the matcher as an importable library |
| Existing dictation apps | Fifteen export formats and seven importers, including Wispr Flow, Superwhisper, macOS Text Replacement, Deepgram, Azure and Google |
| Sharing within a repository | Commit `.lexicon.yaml`; each engineer approves it once with `lexicon trust` |

There is no seat limit, no term limit, no time limit and no telemetry. If your
organization deploys this to ten thousand machines and never contacts us, that
is a legitimate and permanent use of the MIT licence, and it is a use we
support.

**Two shipped things have distribution caveats you should know before you
plan a rollout:**

- The **browser extension is not in the Chrome or Firefox stores yet**. Today
  it installs unpacked from a build directory, which is workable for engineers
  and awkward for everyone else. Store listings are on the roadmap.
- The **macOS menu bar app is ad-hoc signed and not notarized**. A downloaded
  copy is blocked by Gatekeeper on first launch until the user right-clicks and
  chooses Open. A Developer ID certificate and notarization are prerequisites
  for any real fleet deployment and are on the roadmap.

Neither caveat affects the CLI, the MCP server or the Claude Code plugin, which
install cleanly through npm, Homebrew or a shell script.

---

## Security and privacy posture

This tool reads text you dictate, including text you type into chat composers,
and it injects vocabulary into a model's context. You should interrogate that.
Here are the facts, each of which you can verify in the public repository.

### Nothing leaves the machine

**There is no network destination in this product.** Not a telemetry endpoint,
not an update check, not an analytics beacon. The CLI, the hooks, the MCP
server, the local API and the browser extension make no request beyond the
loopback interface.

There is exactly one outbound request anywhere in the codebase: the optional
local dictation command downloads a whisper speech model from Hugging Face the
first time you use it. Point it at a local model file and even that disappears.
Audio itself never leaves the machine; transcription is local.

Your vocabulary is a plain YAML file at `~/.config/lexicon/lexicon.yaml`. You
can read it, diff it, back it up and delete it. There is no account to close.

### The local API is loopback-only and authenticated

The HTTP API that the browser extension and desktop integrations use binds
`127.0.0.1`. Specifically:

- Every route except the health check requires a bearer token read from a file
  created with mode 0600, compared in constant time.
- CORS headers are sent only to browser-extension origins or exact origins the
  user has explicitly listed. Never `*`. A web page cannot read a response even
  if it somehow obtained the token.
- The one route that returns the token without a bearer, the extension pairing
  page, is served only when the TCP peer is a loopback address *and* the
  `Host` header is exactly `127.0.0.1:<port>` or `localhost:<port>`, which
  defeats DNS rebinding. It sends `X-Frame-Options: DENY`,
  `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and
  `default-src 'none'`, runs no script and makes no external request.
- Request bodies are capped at 1 MB and concurrency at 64.
- Binding a non-loopback address is possible and prints a warning; the pairing
  page is never exposed on it.

The honest boundary: an attacker who already runs code as that user could read
the token file, because it is that user's file. But they could equally well
edit the YAML directly. The API does not widen the blast radius. A *different*
user on the same machine cannot read the token and cannot use the API.

### A lexicon from an untrusted repository is refused

This is the part most security reviewers care about, and it is the part we
designed first.

A project `.lexicon.yaml` is discovered by walking up from the working
directory, which means it comes from whatever repository your engineer happened
to clone. Its contents reach model context. A hostile repository could ship a
term whose "correct spelling" is an instruction, and every dictated prompt in
that repository becomes a prompt-injection vector.

So a project lexicon is **not merged until a human approves it**, the same way
Claude Code gates a repository's `.mcp.json`:

- `lexicon trust` shows a sanitized preview (canonicals and counts, with notes
  reported as *present* and never quoted) and only then pins the file.
- Approval records the file's sha256. If the file changes, for example after a
  `git pull`, it drops back to untrusted and is skipped until re-approved.
- When a file is skipped, every surface reports **the path only**. The
  contents never reach model context. Not in the session-start injection, not
  in the prompt hook, not in the MCP resources, not in the API response.
- A write into an untrusted project file is refused outright rather than
  silently promoting that file to trusted.

### Defence in depth on the file format itself

Even in an approved file, every field is bounded and scrubbed at parse time:
canonicals and aliases capped at 80 characters, notes at 200, at most 64
aliases per term and 5,000 terms per file, no control characters or line breaks
anywhere. Zero-width characters, bidirectional embedding and override controls,
bidi isolates and the byte-order mark are stripped, so nothing can hide
instructions or reverse displayed text. Files over 2 MB are refused; imports
over 8 MB are refused before being read.

Everything the CLI prints that did not come from its own source code, such as
file paths, term text and error strings, passes through a sanitizer that
removes ANSI escape sequences and control characters and caps length, so a
hostile repository cannot recolour a terminal, set its title or move the cursor
to hide text.

### Dependency and licence position

The shipped dependency tree is 98 packages, every one under a permissive
licence: 87 MIT, 8 ISC, 2 BSD-3-Clause, 1 BSD-2-Clause. **There is no copyleft
anywhere in what we ship.** If your legal team's first question is whether
deploying this creates a source-disclosure obligation, the answer is no, and it
is checkable in one command against the public repository.

### What we do *not* claim

- No SOC 2 report. We are a very small company and have not undergone an audit.
  If you require one, say so now; it changes the timeline, not the answer.
- No penetration test by a third party has been performed.
- The extension and the macOS app are not distributed through the platform
  stores yet, as noted above.
- We have no compliance certifications of any kind. What we have is a public
  codebase, a written threat model in [SECURITY.md](../SECURITY.md), and the
  willingness to answer a questionnaire honestly.

---

## Team: *planned, not built*

> **None of this exists yet.** It is the one thing we intend to charge for, and
> it is described here so you can tell us whether it is worth building.

Every employee at your company mispronounces the same twenty words into the
same recognizers, and today each of them curates their own file. The first
engineer spends thirty minutes teaching Lexicon your product names. So does the
second. So does the two hundredth, and the salesperson never does it at all.

Team is a hosted lexicon your organization owns, that every member's machine
pulls automatically:

- **One shared vocabulary.** An admin curates your company's names once. It
  appears on every member's machine, in their agents, their browser and their
  text fields.
- **Roles.** Owner, admin, editor, member. Members propose terms; admins
  approve them. When someone's agent learns a correction, it can offer to
  propose it to the team, which is how the list stays current without anyone
  being assigned to maintain it.
- **An audit trail.** Every term, who added it, when, and what it was before.
  Exportable.
- **SSO.** SAML and OIDC. We intend to include SSO in the lowest paid tier
  rather than holding it for an enterprise upsell.
- **Your personal file still wins.** The shared layer sits *below* each
  person's own vocabulary. An admin's push can never overwrite what someone
  typed for themselves. That is a deliberate design commitment, not an
  implementation detail.

The full engineering plan, including the data model, the sync protocol and the
trust boundary for remote content, is public in
[TEAM-SYNC.md](TEAM-SYNC.md). We would rather you read the plan and tell us it
is wrong.

**You do not have to wait for this to share a vocabulary.** Committing
`.lexicon.yaml` to a repository works today and is free forever. Team exists
for the people who do not clone your repositories.

---

## Enterprise: *planned, not built*

> **None of this exists yet.** Several items below are things we would build
> against a signed agreement, not ahead of one. We will tell you which is
> which on a call rather than implying everything is waiting on a shelf.

### Fleet deployment

The target is that a device management team can deploy Lexicon to every
machine without touching any of them:

- **Signed, notarized installers** for macOS (a `.pkg` suitable for Jamf,
  Kandji, Intune or Mosyle) and an MSI for Windows. *This requires a
  Developer ID certificate and notarization, which is genuine prerequisite work
  and is not done today.*
- **A configuration profile** that pins the organization's lexicon source, so a
  machine joins the shared vocabulary at enrolment with no user action.
- **A managed policy file** for settings a user may not override: whether local
  voice history is written at all, which terms are enforced, whether the local
  API may bind a non-loopback address, whether the browser extension is
  permitted.
- **Silent, non-interactive enrolment** through an environment variable or the
  policy file, so imaging works.

### Self-hosted and on-premise sync

The shared-lexicon service, run inside your own network, so no vocabulary ever
reaches infrastructure we operate. For organizations where the *words* are
themselves sensitive (unreleased product names, client names, codenames), this
is usually the only acceptable shape, and we would rather sell you that than
lose you to a policy objection.

A container image, a Postgres database you own, and a licence key. Note that
the free tier already supports pointing every machine at any URL you host
yourself; the paid self-hosted product adds identity, roles and the audit
trail.

### Support with an SLA

A named contact, a response-time commitment in writing, and a path to a fix
rather than a GitHub issue that may sit. We will write a specific number into a
contract. We will not write one we cannot meet: today this is one person, and
any SLA we sign will reflect that until it does not.

### Indemnification

This is the one thing the open-source licence structurally cannot give you, and
it is usually the reason procurement stops at an MIT project.

The MIT licence disclaims all warranty and all liability, in capital letters.
That is fine for an individual and unacceptable for a company that needs
someone to stand behind the software. A commercial agreement with Ashlr.AI can
provide intellectual-property indemnification for the versions covered by your
subscription: we defend the claim and bear the cost, subject to negotiated
caps. This is the same structure Red Hat's Open Source Assurance and Grafana
Enterprise use, and the reason it works is that we hold the copyright
in the entire codebase: there is a single author, no contributor licence
agreement gaps, and a permissively licensed dependency tree with no copyleft in
it.

**This is a contract term, not a feature.** It requires a signed agreement and
our counsel's review. Ask early; it is the longest lead time in any deal.

---

## Questions your procurement team will ask

**Where is our data stored?**
Today, nowhere but your own machines. Under Team, the shared vocabulary, not
your transcripts, would be stored in a hosted database in a region you pick.
Transcripts are never transmitted under any tier. The product never sees the
sentence, only the vocabulary list.

**Can you see what our employees dictate?**
No, and there is no code path by which we could. The correction happens on the
device. Under Team we would hold the word list your admin curated and nothing
else.

**What happens if you go out of business?**
You keep everything. The engine is MIT-licensed, every version already published
stays MIT and cannot practically be withdrawn, and your vocabulary is a YAML file
on your own disks. For Team specifically we will commit contractually to a data export in
an open format and, for Enterprise, to source escrow or a self-hosted
deployment so that continuity does not depend on us existing. This is a fair
question to ask a one-person company and we will not be offended by it.

**Do you have a DPA? A sub-processor list? GDPR representation?**
For the free tier there is no processing to cover. We receive nothing. For
Team we will execute a DPA and publish a sub-processor list before the first
paid customer, not after.

**Is it accessible? Does it work offline?**
It works entirely offline today. Under Team, a failed sync uses the last cached
vocabulary and reports the cache age; corrections never stop working because a
network did.

**What is your security contact?**
mason@ashlr.ai, with the disclosure policy in
[SECURITY.md](../SECURITY.md#reporting-a-vulnerability). Acknowledgement within
a few days.

**How do we evaluate this without talking to you?**
Install it. `npm i -g @ashlr/lexicon` and `lexicon setup`. Everything in the
first section of this document works with no account and no contact. We would
prefer you arrive at a conversation having already run it on ten machines.

---

## Talk to us

Ashlr.AI, mason@ashlr.ai

Tell us the number of people, which agents and dictation tools they already
use, and whether hosted or self-hosted is acceptable in your environment. If
what you need is on the planned list rather than the shipped list, we will say
so on the first call.

- Repository: <https://github.com/ashlrai/lexicon>
- Package: <https://www.npmjs.com/package/@ashlr/lexicon>
- Site: <https://lexicon.ashlr.ai>

---

## See also

- [SECURITY.md](../SECURITY.md) is the full threat model, unabridged.
- [BENCHMARK.md](BENCHMARK.md) has every number in this document, with the method behind it.
- [COMMERCIAL.md](COMMERCIAL.md) explains how we decided what to charge for, and what we deliberately do not.
- [TEAM-SYNC.md](TEAM-SYNC.md) is the engineering plan behind the Team tier.
- [TRUST.md](TRUST.md) covers the project-lexicon trust gate in detail.

Back to [the docs index](README.md).
