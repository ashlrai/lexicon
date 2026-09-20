# Distribution

Where Lexicon should be listed so agents and users find it, in priority order, and what
each destination costs. We pay for none of it. Several directories now sell queue position;
where that is true it is named, along with the free path and what the free path costs in
waiting.

Status is as of 2026-09-20. This landscape moves, so verify before acting.

| # | Destination | Cost | Who drives it | Status |
|---|---|---|---|---|
| 1 | [Official MCP Registry](#1-official-mcp-registry) | free | agent | ready to publish |
| 2 | [Glama](#2-glama) | free | agent | ready, file committed |
| 3 | [Anthropic plugin directory](#3-anthropic-plugin-directory) | free | **Mason** | needs his sign-in |
| 4 | [punkpeye/awesome-mcp-servers](#4-punkpeyeawesome-mcp-servers) | free | agent, Mason merges | line drafted, PR not opened |
| 5 | [Cline MCP Marketplace](#5-cline-mcp-marketplace) | free | agent, needs a logo | blocked on a 400x400 PNG |
| 6 | [mcpservers.org](#6-mcpserversorg) | free, or $39 | agent | not submitted |
| 7 | [mcp.so](#7-mcpso) | free via issue, or $39 | agent | not submitted |
| 8 | [mcpmarket.com](#8-mcpmarketcom) | free, or $29 | agent | not submitted |
| 9 | [Smithery](#9-smithery) | free | **Mason** | poor fit, low priority |
| 10 | [PulseMCP](#10-pulsemcp) | free | nobody | submissions paused upstream |
| 11 | [Continue.dev hub](#11-continuedev-hub) | n/a | nobody | dead, do not pursue |

Three of these need Mason personally: the Anthropic plugin directory, Smithery, and
merging the awesome-mcp-servers PR from his own GitHub account. Everything else an agent
can prepare and run.

## 1. Official MCP Registry

<https://registry.modelcontextprotocol.io>. Source at
<https://github.com/modelcontextprotocol/registry>.

The one that matters most: it is upstream of several other directories, which ingest from
it rather than crawling. Free, no review queue, no placement to buy.

**What it requires.** A [`server.json`](../server.json) at the repo root, valid against the
`2025-12-11` schema, plus proof that we own both the namespace and the npm package.

- *Namespace.* We claim `io.github.ashlrai/lexicon`, proven by logging in with a GitHub
  account that can act for the `ashlrai` org. The alternative, `ai.ashlr/lexicon`, is proven
  by a DNS TXT record on `ashlr.ai` and would be the better long-term name if we ever move
  off GitHub. But it is more setup for no immediate gain, so we use the GitHub namespace.
- *Package ownership.* The registry fetches
  `https://registry.npmjs.org/@ashlr%2flexicon/<version>` and requires an `mcpName` field
  equal to the server name.

**Validate before publishing:**

```bash
npm run check:server-json   # schema + version agreement + npm mcpName
mcp-publisher validate server.json
```

`mcp-publisher validate` only checks shape against the registry's schema; it does **not**
check npm ownership, so it passes on its own while a real publish would fail.
[`scripts/check-server-json.mjs`](../scripts/check-server-json.mjs) checks all three, and
as of 0.5.1 it prints `ready to publish`.

(This was blocked until 0.5.1. `@ashlr/lexicon@0.5.0` went to npm without an `mcpName`
field and npm versions are immutable, so the field could only arrive in a new release.
`server.json` carries the version too, which is why it is one of the files
[RELEASING.md](RELEASING.md) bumps. Do not hand-publish to clear a registry blocker, or
the five version-carrying files drift apart and the plugin marketplace ships a version npm
does not have.)

**Publish:**

```bash
brew install mcp-publisher        # already installed at 1.8.1
mcp-publisher login github        # opens a browser for GitHub device-code auth
mcp-publisher publish server.json
```

`mcp-publisher login github` prints a device code and a URL, and asks you to authorize the
MCP Registry OAuth app against a GitHub account with rights over the `ashlrai` org. It asks
for no password and no token on the command line. The credential is cached; `mcp-publisher
logout` clears it. Nothing else prompts.

To publish from CI instead, `mcp-publisher login github-oidc` uses the GitHub Actions OIDC
token and needs no interactive step. Worth wiring into the release workflow once the first
manual publish has proven the namespace.

## 2. Glama

<https://glama.ai/mcp/servers>

Glama's crawler creates a listing on its own; [`glama.json`](../glama.json) at the repo root
is how we *claim* the one it creates, which unlocks editing the listing.

Free. The schema (<https://glama.ai/mcp/schemas/server.json>) requires exactly one field,
`maintainers`, an array of GitHub usernames. Ours is `masonwyatt23` (confirmed with
`gh api user --jq .login`). Note this is a personal handle, not the `ashlrai` org; Glama
matches maintainers by GitHub user.

Nothing to submit. The file is committed; the crawler picks it up on its next pass. If the
listing does not appear or cannot be claimed after a couple of weeks, Glama has a contact
form on the server page.

## 3. Anthropic plugin directory

<https://platform.claude.com/plugins/submit>

**Mason must do this one personally**: it is a form behind his Anthropic Console sign-in,
and an agent cannot and should not authenticate as him.

Set expectations first. Anthropic's *official* marketplace (`claude-plugins-official`) is
curated at Anthropic's discretion and has **no public submission process**; their plugin
docs say to go through an Anthropic partner contact for an official listing. The in-app and
Console submission forms add a plugin to the separate **community** marketplace. That is
still worth having, but it is not the official list.

Lexicon is already a working Claude Code plugin: [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)
and `.claude-plugin/plugin.json` ship the MCP server, the hooks, the skill and the
`/lexicon` command, and `claude plugin marketplace add ashlrai/lexicon` already works today
without any listing. A directory listing adds discovery, not capability.

What to have ready before opening the form: the repo URL, the marketplace name (`ashlrai`),
the plugin name (`lexicon`), a one-line description, and the license (MIT).

## 4. punkpeye/awesome-mcp-servers

<https://github.com/punkpeye/awesome-mcp-servers>

Free, high-traffic, and a single-line README edit. Their
[CONTRIBUTING.md](https://github.com/punkpeye/awesome-mcp-servers/blob/main/CONTRIBUTING.md)
asks for one server per line, alphabetical order within a category, and invites automated
agents to append `🤖🤖🤖` to the PR title to opt into a fast-track merge. That last one
matters for us.

**Category:** `### 🎧 Text-to-Speech`, whose description is "Tools for converting
text-to-speech and vice-versa". That section already holds speech-to-text servers
(`transcribe-app/mcp-transcribe`, `mbailey/voice-mcp`) and is the one place voice users
browse. It is strictly alphabetical, and `ashlrai` sorts before the current first entry
`daisys-ai/daisys-mcp`, so our line goes at the top of the list.

The exact line, and the PR steps, are in [The awesome-mcp-servers line](#the-awesome-mcp-servers-line)
below.

Scope check passed: their list is for servers with a public repo that you install and run
yourself, not remote-only hosted URLs. Lexicon qualifies.

## 5. Cline MCP Marketplace

<https://github.com/cline/mcp-marketplace>

Free. Submission is a GitHub issue using their `mcp-server-submission.yml` template, which
requires three things:

1. The GitHub repo URL.
2. **A 400x400 PNG logo.** We do not have one at that size. This is the blocker. There is
   artwork under `docs/assets` and `web/` to cut one from.
3. A short reason the server benefits Cline users.

The template also asks you to confirm you have watched Cline install the server from the
`README.md` and/or `llms-install.md` alone. That is exactly what
[`llms-install.md`](../llms-install.md) is for, and it is why that file is worth keeping
current whether or not we ever submit here: Cline's one-click install reads it, and other
agents increasingly look for it by convention.

Their stated review criteria are community adoption, maintainer credibility, project
maturity and security. A brand-new project may be deferred; this is worth re-submitting
after the repo has some traction rather than burning the first impression now.

## 6. mcpservers.org

<https://mcpservers.org/submit>

A web form. Free tier is $0 with a stated review time of **within 2 weeks**. They also sell
a $39 one-time "Premium Submit" for a 24-hour review, an "official" badge, search priority
and a dofollow link. **Take the free tier.**

Form fields, and what to put in them:

| Field | Value |
|---|---|
| Server Name | `Lexicon` |
| Category | `Productivity` (no voice/speech category exists; `Development` is the fallback) |
| Short Description | Fixes the names and jargon speech-to-text gets wrong before your agent acts on a dictated prompt. |
| Repository / Website | `https://github.com/ashlrai/lexicon` |
| Official MCP Registry Name | `io.github.ashlrai/lexicon` (fill this in only after step 1 lands) |
| Supports remote connections | unchecked (stdio, local only) |
| Contact Email | `mason@ashlr.ai` |
| Plan | Free ($0) |

Do this *after* the registry publish, so the registry name field can be filled.

## 7. mcp.so

<https://mcp.so>

Their `/submit` page now shows **only** a $39 one-time paid path ("publish immediately
without review", verified badge, featured placement, dofollow link). Do not pay it.

The free path still exists but is no longer advertised on that page: open a GitHub issue on
<https://github.com/chatmcp/mcpso> (the repo behind the site; `chatmcp/mcp-directory`
redirects to it). Existing issues follow a `Submit: <name>` title convention. Be realistic
about the odds: that repo has roughly 3,100 open issues, so the free queue is effectively
unbounded. Low cost to file, low expectation.

```bash
gh issue create -R chatmcp/mcpso \
  --title "Submit: Lexicon (fixes what speech-to-text mishears before the agent acts)" \
  --body "https://github.com/ashlrai/lexicon"
```

Filing this needs a GitHub account; it can be Mason's or a project account.

## 8. mcpmarket.com

<https://mcpmarket.com/submit>

A web form taking a GitHub repository URL, an email for the go-live notification and an
optional "Try Now" link. Free queue is $0 with a stated **4 to 6 week** listing time and
standard placement. They sell a $29 one-time "Get Listed Now" for a 24-hour listing, an
official badge and the Try Now link. **Take the free queue.**

Fields: repo `https://github.com/ashlrai/lexicon`, type `MCP Server` + `GitHub repo`, email
`mason@ashlr.ai`, Try Now link `https://lexicon.ashlr.ai`.

## 9. Smithery

<https://smithery.ai>

**Needs Mason's sign-in**, and it is a poor fit besides. Leave it late.

Smithery now documents exactly two publishing paths, and the container/Docker build path
the survey remembered is gone (the old `smithery.ai/docs/build/deployments` page 404s and
no container page appears anywhere in their docs index):

- **URL.** Bring your own hosting, Streamable HTTP transport, Smithery proxies to it.
  Lexicon is a local stdio server that reads a file in the user's home directory. Hosting it
  remotely would defeat the point.
- **Local (MCPB bundle).** You build a `.mcpb` bundle and Smithery distributes it:
  `smithery mcp publish ./server.mcpb -n ashlrai/lexicon`. This is the only path that fits,
  and it means producing and maintaining an MCPB artifact we do not currently build.

Worth doing only if we decide to ship a `.mcpb` for other reasons. Not worth building one
just for Smithery.

## 10. PulseMCP

<https://www.pulsemcp.com/submit>

**Submissions are paused upstream.** Their submit page says they are not accepting new MCP
server or client submissions and are not changing existing listings, with no reopen date
(page last updated 2026-09-03). They explicitly direct people to publish to the Official MCP
Registry in the meantime and say they will pick it up automatically once they reopen.

So there is nothing to do here beyond step 1, which we are doing anyway. Re-check in a
month.

## 11. Continue.dev hub

Do not pursue. Continue has been acquired by Cursor (continue.dev now leads with "Continue
has joined Cursor"), and `hub.continue.dev` no longer resolves in DNS. The remaining docs at
docs.continue.dev describe MCP servers only as local user config, with no submission or
publishing flow and no directory. There is no listing to get.

## The awesome-mcp-servers line

Insert into `### 🎧 Text-to-Speech`, as the **first** entry in that section: immediately
after the "Tools for converting text-to-speech and vice-versa" line and its blank line, and
directly above the existing `daisys-ai/daisys-mcp` entry.

```markdown
- [ashlrai/lexicon](https://github.com/ashlrai/lexicon) 📇 🏠 🍎 🪟 🐧 - A personal vocabulary for dictated prompts: fixes the names, brands and jargon speech-to-text mishears before the agent acts on them. One local YAML file, 19 tools. Normalize a transcript, learn a correction from "I said X not Y", harvest terms from a repo, import a Wispr Flow or Superwhisper dictionary. No API key, nothing leaves the machine. `npx -y @ashlr/lexicon mcp`
```

Emoji, per their legend: 📇 TypeScript, 🏠 local service, 🍎 🪟 🐧 macOS/Windows/Linux.

**Fork and open the PR** (an agent can prepare every step; Mason runs the `gh pr create`
from his own account):

```bash
gh repo fork punkpeye/awesome-mcp-servers --clone --remote
cd awesome-mcp-servers
git checkout -b add-lexicon

# Insert the line above directly before the daisys-ai/daisys-mcp entry
# in the "🎧 Text-to-Speech" section of README.md.

git commit -am "Add ashlrai/lexicon to Text-to-Speech"
git push -u origin add-lexicon

gh pr create \
  --repo punkpeye/awesome-mcp-servers \
  --title "Add ashlrai/lexicon to Text-to-Speech 🤖🤖🤖" \
  --body "Adds [ashlrai/lexicon](https://github.com/ashlrai/lexicon), a local stdio MCP server that corrects what speech-to-text mishears before an agent acts on a dictated prompt. MIT, TypeScript, published as \`@ashlr/lexicon\`. Placed alphabetically as the first entry under Text-to-Speech, whose scope covers speech-to-text."
```

The `🤖🤖🤖` suffix is their documented opt-in for agent-authored PRs and fast-tracks the
merge. Keep it.

## Our own marketplace manifest

[`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) currently declares
the plugin with `"source": "./"`, so `claude plugin install lexicon@ashlrai` clones this
repo. Claude Code also supports an npm source, which would install from the published
tarball instead of cloning:

```json
{ "name": "lexicon", "source": { "source": "npm", "package": "@ashlr/lexicon" } }
```

`version` and `registry` are optional; omitting `version` takes the latest.

**We could use it.** Claude Code unpacks the tarball, looks for `.claude-plugin/plugin.json`
inside it and loads `skills/`, `commands/`, `agents/`, `hooks/` and the MCP servers from
there. The published `@ashlr/lexicon@0.5.0` tarball already contains every one of those:
`.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/lexicon.md`,
`skills/lexicon/SKILL.md`, `.mcp.json` and both `plugin/*.mjs` bundles.

One rule matters here: **npm lifecycle scripts never run** on a plugin install, so the
package must be publishable-and-usable with nothing built at install time. We satisfy that
because `plugin/mcp-server.mjs` and `plugin/hook.mjs` are committed, dependency-free
bundles, and `dist/` is built by `prepublishOnly` before the tarball is made. The tarball
carries no lockfile, which is fine precisely because nothing needs installing.

**The tradeoff.** A path source tracks the repo, so a plugin user gets whatever is on the
default branch; an npm source tracks releases, which is more predictable but means a plugin
fix needs an npm publish. There is also a chicken-and-egg risk: switching to npm makes
`claude plugin marketplace add ashlrai/lexicon` depend on a package version that ships a
correct `marketplace.json`. Recommendation: keep `"./"` for now, and revisit once the
release cadence settles.

**Reserved names do not affect us.** Plugin and marketplace names must be kebab-case with no
spaces or control characters; `lexicon` and `ashlrai` both qualify. The reserved marketplace
names are Anthropic's own (`claude-plugins-official`, `anthropic-marketplace`,
`first-party-plugins` and similar), anything impersonating an official marketplace, and the
package-manager words `npm`, `pip`, `uv`, `cargo`, `github`, `gh`. `ashlrai` is none of
these. Plugin names are unique per marketplace, not globally, so `lexicon` is safe;
marketplace names are unique per user, so a second marketplace called `ashlrai` would
replace this one on someone's machine.

## Order of operations

1. `0.5.1` is on npm carrying `mcpName`, so the blocker is gone: run `mcp-publisher
   publish`. Everything downstream benefits, and two of the forms want the registry
   name. Cut any further release through [RELEASING.md](RELEASING.md) rather than
   uploading assets by hand.
2. Glama needs nothing further. The file is in the repo.
3. Open the awesome-mcp-servers PR.
4. Mason submits the Anthropic plugin directory form.
5. Free-tier forms: mcpservers.org, then mcpmarket.com, then the mcp.so issue.
6. Cline, once there is a 400x400 logo and a little traction.
7. Re-check PulseMCP in a month.

## See also

- [CHANGELOG.md](../CHANGELOG.md) is the record each listing's "what is new" is written from.

Back to [the docs index](README.md).
