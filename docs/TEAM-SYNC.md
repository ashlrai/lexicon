# Team sync: the engineering plan

**Status: nothing in this document is built.** Every command, endpoint and table
below is a proposal. Read it as the scope of work for the one product that
[COMMERCIAL.md](COMMERCIAL.md) proposes selling, not as documentation. Nothing
described here exists in `src/` today, and the landing page must not claim it
does.

The one-line version: an organization gets a third lexicon layer, hosted by us,
that every member's machine pulls and nobody has to curate twice.

---

## Why this is the product

MIT gives an organization the code. It does not give them a place to put a
shared file, an identity to attach to it, or a record of who changed it. Those
are operations, not software, and a fork cannot take them.

Today a team can already share a vocabulary two ways, and both stay free
forever:

- Commit `.lexicon.yaml` and every teammate runs `lexicon trust` ([TRUST.md](TRUST.md)).
- Export the terms and mail the file around ([EXPORTS.md](EXPORTS.md)).

Both work. Both break at about fifteen people, because a repo file only reaches
people who clone that repo, the designer and the salesperson never do, and
nobody knows whether Ana on the support team has the current list. The hosted
layer is what fixes that, and it is a service.

---

## The data model on the client

### A third layer

Today `loadLexicon()` merges two files (`src/core/store.ts`):

```
global (~/.config/lexicon/lexicon.yaml)  →  project (.lexicon.yaml)
```

Later wins on a canonical collision; aliases union. Team adds one layer:

```
org (cached)  →  global (personal)  →  project
```

**The org layer sits lowest on purpose.** An admin's push must never overwrite
what a person typed into their own file. If the company writes `Ashlr.AI` and
Mason's personal file says `Ashlr.AI` with three extra aliases, the aliases
union and Mason keeps his spelling. This is the difference between a tool
people keep installed and one they uninstall the first time it fights them.

Enterprise gets one exception, and it is opt-in per term: a term marked
`enforced: true` in the org layer moves to the top of the precedence chain and
cannot be overridden locally. This is for the compliance case (a regulated
product name that has to be written one way) and should be rare. `lexicon list
--why` prints the layer every term came from so the behaviour is never
mysterious.

### Where it is cached

```
~/.config/lexicon/org/<org-id>.yaml     the last successful pull, mode 0600
~/.config/lexicon/org/<org-id>.etag     the version it corresponds to
~/.config/lexicon/auth.json             device token, mode 0600
```

Same directory, same permissions discipline and same atomic writes as
`serve.json` (`src/util/atomic.ts`, `src/serve/config.ts`). `LEXICON_CONFIG`
and `XDG_CONFIG_HOME` keep working unchanged.

### Trust

A remote lexicon is untrusted content arriving from off the machine, which is
exactly the threat [SECURITY.md](../SECURITY.md) already models for a project
`.lexicon.yaml`. Four rules, all of which reuse code that exists:

1. **Joining is the consent event.** An org source is only ever added by an
   explicit `lexicon org join` that the user runs, or by a managed policy file
   an administrator installed through MDM on a machine they own. Nothing is
   auto-discovered, and a repository can never introduce one.
2. **Every existing schema limit applies unchanged.** Remote terms go through
   the same `parseLexicon()` as a local file: 80-character canonicals,
   200-character notes, at most 64 aliases per term, 5,000 terms, no control
   characters, and the zero-width and bidi stripping described in
   [SECURITY.md](../SECURITY.md#mitigations). A hosted term is not more trusted
   than a local one; it is parsed by the same function.
3. **Changes are visible.** `lexicon org diff` shows what a pull would change
   before it lands, and Enterprise can set `reviewBeforeApply` so a pull stages
   rather than applies.
4. **Notes are the sharp edge.** A term's `notes` field reaches model context
   verbatim, which makes an org admin an injection vector for their own
   employees. v1 answer: org terms carry no `notes` at all. The field is
   dropped at parse time on the org layer. If customers ask for it later it
   comes back behind an admin-only flag and a diff that quotes it.

---

## The service

### Storage

Postgres. The whole dataset for a 500-seat customer is a few megabytes.

| Table | Columns that matter |
| --- | --- |
| `org` | `id`, `name`, `slug`, `plan`, `seat_limit`, `created_at` |
| `member` | `org_id`, `user_id`, `role` (`owner`/`admin`/`editor`/`member`), `status`, `invited_by` |
| `term` | `id`, `org_id`, `canonical`, `aliases[]`, `phonetic`, `category`, `never[]`, `case_sensitive`, `enforced`, `version`, `created_by`, `updated_by`, `updated_at`, `deleted_at` |
| `term_revision` | `term_id`, `actor_id`, `op` (`create`/`update`/`delete`), `before` jsonb, `after` jsonb, `at` — this table **is** the audit trail |
| `proposal` | `org_id`, `proposed_by`, `payload` jsonb, `state`, `decided_by`, `decided_at` |
| `snapshot` | `org_id`, `version` int, `yaml` text, `built_at` — rebuilt on write, served on read |
| `device` | `id`, `user_id`, `name`, `token_hash`, `last_seen_at`, `revoked_at` |

`term` is soft-deleted because the audit trail has to survive a deletion, and
because a snapshot has to be reproducible at a version.

Rows are written per-org and read per-org. Every query is scoped by `org_id`,
enforced in the database with row-level security rather than only in
application code, so a bug in a handler cannot leak another customer's terms.

### The sync protocol

Deliberately boring. The org lexicon is server-authoritative and small, so
there is no CRDT, no merge, and no offline write queue.

```
GET  /v1/orgs/{org}/lexicon          If-None-Match: "<version>"
     -> 200 text/yaml + ETag, or 304 with an empty body
POST /v1/orgs/{org}/terms            admin+; If-Match on update, 409 on stale
GET  /v1/orgs/{org}/terms
GET  /v1/orgs/{org}/audit?since=     admin+
POST /v1/orgs/{org}/proposals        any member
POST /v1/orgs/{org}/proposals/{id}/decide   admin+
```

**Clients pull; they never push the merged file.** The only write path is a
term-level API call that an admin (or a proposal) drives. That removes the
entire class of "two laptops synced different versions of the same YAML"
problems, because no laptop is ever authoritative.

**Conflicts, all three kinds:**

- *Two admins edit the same term.* Optimistic concurrency on `term.version`
  through `If-Match`. A stale write gets `409` and the CLI prints the two
  versions and asks which to keep. No silent last-write-wins.
- *An org term collides with a personal term.* Not a conflict. The precedence
  rule above decides it, and `lexicon list --why` explains it.
- *The machine is offline.* The cached YAML is used with its stored etag.
  Nothing blocks, nothing errors, and `lexicon doctor` reports the cache age.
  A pull that fails is a warning, never a failure of the correction path.

**When it pulls:** on `SessionStart`, on `lexicon org pull`, and on a timer in
`lexicon serve` when it is running (default 15 minutes, jittered). With `ETag`
the steady state is a 304 with an empty body, which is the whole reason the
protocol looks like this.

### Authentication

Three paths, one token format.

- **A person on a laptop.** OAuth device-code flow, the shape `gh auth login`
  uses: `lexicon org login` prints a short code and a URL, the person approves
  in a browser, the CLI polls and stores a device token at
  `~/.config/lexicon/auth.json` with mode 0600. Same handling as the local API
  bearer token that already exists.
- **A fleet install.** `LEXICON_ORG_TOKEN` in the environment, or a token in
  the managed policy file that MDM lays down. No browser, no interaction.
- **The web admin console.** Email magic link and GitHub/Google OAuth on Team.
  SAML and OIDC SSO on Enterprise, through an identity vendor rather than
  hand-written SAML, because hand-written SAML is how people get breached.

Device tokens are stored hashed, are listed and revocable per device in the
admin console, and expire on a schedule the org sets.

### What it costs to run

Honest ranges for the first 500 seats, which is a long way past where this
needs to get to be worth doing:

| Line | Monthly |
| --- | --- |
| Postgres (managed, small) | $25–70 |
| API compute (serverless or one small instance) | $0–25 |
| Identity vendor, Team tier only (magic link + social) | $0–25 |
| Identity vendor, per SSO connection (Enterprise) | $100–150 per customer connection — **verify against a current quote** |
| Bandwidth | under $5. A 5,000-term snapshot is well under a megabyte and most requests are 304s |
| Error tracking, uptime, logs | $0–50 |

**Infrastructure is not the cost.** Call it $150–300/month to serve the first
few hundred seats. The cost is one person's time: roughly six weeks to build
v1, then a permanent on-call obligation and a support queue. Do not model this
as a software margin business until the support load is measured.

---

## The client surface

### CLI

Subcommands under one noun, matching the existing `lexicon pack` and
`lexicon trust` shapes.

```
lexicon org login                 device-code flow
lexicon org logout
lexicon org status                which org, which role, cache age, term count
lexicon org join <code>
lexicon org pull                  fetch now (normally automatic)
lexicon org diff                  what a pull would change, before it lands
lexicon org list                  org terms, and who added each
lexicon org add <canonical>       admin+; 403 with a hint to propose otherwise
lexicon org remove <canonical>    admin+
lexicon org propose <canonical>   any member; goes to the admin queue
lexicon org log                   the audit trail, newest first
lexicon org leave
```

Every one of these prints through `sanitizeForDisplay` like the rest of the
CLI, because the strings now come off a network.

### MCP

A deliberately small set. An agent needs to know what the company calls things
and to offer a correction upward; it does not need to administer the org.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `org_status` | none | org name, role, term count, cache age, whether a pull is pending |
| `org_list_terms` | `query?` | org-layer terms with the member who added each |
| `org_propose_term` | `canonical`, `aliases?`, `reason?` | the proposal and its state |
| `org_pull` | none | what changed, as a diff summary |

`org_propose_term` is the interesting one. Today when a user says "it is
Ashlr.AI, not Ashler", the agent calls `learn_correction` and the fix lands in
one person's file. With an org, the agent can offer: "Added it for you. Your
team does not have this term — propose it to them?" That is the moment the
product sells itself, and it is one tool call.

### The extension, the macOS app and the local API

All three read the merged lexicon through `loadLexicon()`, so they inherit the
org layer with no change beyond showing which layer a term came from. The local
API's `GET /lexicon` gains an `org` block; `GET /health` gains cache age.

---

## What goes in the MIT repo and what does not

The line matters, so it is drawn explicitly.

**In the MIT repo, free forever:**

- `lexicon remote add <url>` — pull a lexicon layer from *any* URL that serves
  the YAML, with an etag cache, offline fallback, `diff` before apply, and the
  full parse-time hardening. A raw GitHub URL, an S3 object, an internal file
  server, or our API: it does not care, and it needs no account.
- The third merge layer, the precedence rules, `list --why`, the cache, the
  offline behaviour, and `doctor`'s reporting of all of it.

This is the part that must not be crippled. A team that wants to host a YAML
file themselves and point everyone at it gets a complete, working, unlimited
shared lexicon for nothing. That is the honest answer to "are you holding the
useful part hostage": no, here it is.

**In a separate package under a commercial licence (`@ashlr/lexicon-team`),
detected by the core CLI as a subcommand plugin:**

- Device login, orgs, roles, proposals, the audit trail, the admin console, SSO.

Why separate rather than in-repo-but-paywalled: a paywall inside an MIT file is
a line of code anyone may legally delete, so it is theatre. A separate package
is honest about what it is, keeps the MIT repo genuinely complete, and means
the free tool never ships a disabled button.

**The risk this does not remove.** The `remote` client in MIT core is a working
blueprint for someone else's server, the way Headscale is for Tailscale's
control plane. That is accepted deliberately. The bet is that a handful of
people will self-host, that they were never going to pay, and that what
companies buy is the operation, the SSO, the audit trail and someone to call —
none of which a reimplementation supplies.

---

## Build order

Six weeks for one engineer to a credible v1, in an order where each week ends
with something demonstrable.

| Week | Ships | Done means |
| --- | --- | --- |
| 1 | `lexicon remote` in MIT core: third layer, precedence, etag cache, offline, `diff`, `list --why`, `doctor` | A team shares a lexicon from a raw GitHub URL, end to end, with no service at all. Release it on its own. |
| 2 | Service skeleton: Postgres, RLS, orgs/members/terms/revisions, the six endpoints, term-level writes with `If-Match` | `curl` can drive a whole org. Tests cover the 409 path. |
| 3 | `@ashlr/lexicon-team`: device-code login, `org` subcommands, the new MCP tools | One admin and one member on two machines, sharing terms. |
| 4 | Admin console: term CRUD, invites, member list, audit view. Stripe checkout and seat counting. | A stranger can sign up, pay, invite someone, and it works without you. |
| 5 | Roles and proposals end to end, audit export, revocation, seat enforcement | An admin can approve what a member's agent proposed. |
| 6 | Hardening, rate limits, backups with a *tested* restore, status page, docs, a real pilot org | One paying customer in production. |

Enterprise is a separate three to four weeks — SSO, SCIM, the MDM package, the
managed policy file, self-hosting — and **should not be started until a
customer has signed something**. Building SSO on spec is the most common way a
small team burns a month.

### What must be true before week 1 starts

The plan above is sound and premature. See
[COMMERCIAL.md](COMMERCIAL.md#recommendation-do-not-sell-yet) for the
preconditions; the short version is that the project is days old with no
measured users, and five conversations with teams of ten or more should happen
before six weeks of engineering does.

---

## See also

- [COMMERCIAL.md](COMMERCIAL.md) — why this layer is the thing to sell, and what it should cost.
- [ENTERPRISE.md](ENTERPRISE.md) — the same plan described for a buyer.
- [TRUST.md](TRUST.md) — the trust gate this reuses for the remote layer.
- [ARCHITECTURE.md](ARCHITECTURE.md) — the module map `org` plugs into.
- [SECURITY.md](../SECURITY.md) — the threat model the parse-time limits come from.
