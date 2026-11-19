# Firefox extension distribution

[Issue #12](https://github.com/ashlrai/lexicon/issues/12), "Package and publish
the extension on addons.mozilla.org", proposes Mozilla Add-ons (AMO)
distribution: a listed add-on page where Firefox users find and permanently
install the signed extension. Distribution is proposed, not done. Nothing has
been submitted to, signed by, approved by or published on AMO, and no AMO
account exists for the project yet. Today Firefox loads the extension only as
a temporary add-on through `about:debugging`, which Firefox removes on exit,
or from the unsigned release zip. See [Firefox notes](EXTENSION.md#firefox-notes)
and the [roadmap](../README.md#roadmap-and-non-goals), which still says the
extension is not on Firefox Add-ons.

This page is the single record for issue #12: what the issue asks, where the
repository stands, what maintainers must establish, and the submission
checklist. It is not evidence
of an AMO submission, approval, signing, or publication, and not a submission
or publication in itself.

## What the issue asks

The issue (opened September 20, 2026, labeled `help wanted` and `platform`)
describes packaging and process work rather than a code change:

- Add `web-ext lint` over `extension/dist-firefox` as a step in
  `scripts/build-extension.mjs` or as a new npm script, and fix what it
  reports.
- Confirm the APIs the extension uses have Firefox equivalents, and that the
  loopback host permission is declared in a way AMO accepts. The issue warns
  that a `127.0.0.1` host permission draws reviewer attention and needs a clear
  justification in the listing.
- Write the AMO submission notes. Reviewers ask for source and a build command
  for anything minified: state that the extension is built with
  `npm run build:extension` from this repository at the tagged commit, and
  which Node version to use.
- Document the flow in [EXTENSION.md](EXTENSION.md) as a "Publishing to AMO"
  section and in [RELEASING.md](RELEASING.md) so the next release can repeat it.
- Once listed, replace the `about:debugging` instructions in EXTENSION.md and
  the roadmap bullet in README.md with the listing link.

Its verification bar is `npm run build:extension` followed by
`npx web-ext lint --source-dir extension/dist-firefox` reporting zero errors,
and the built add-on installing permanently in a clean Firefox profile. The
issue also asks whoever takes it to say so on the issue before starting, so
two people do not both submit a listing.

## Repository state against the issue

The issue predates work that has since landed. When it was written the
generated Firefox manifest did not set `browser_specific_settings.gecko`; it
now does ([extension-manifest.mjs](../scripts/extension-manifest.mjs)): id
`lexicon@ashlr.ai`, `strict_min_version` `140.0` and the
`data_collection_permissions` declarations (`personalCommunications`,
`websiteContent`, `authenticationInfo`) covering the loopback traffic a
`web-ext lint` step would surface. Releases already attach
`lexicon-extension-firefox.zip` built by `npm run build:extension` on Node 22.

Still open from the issue: no `web-ext lint` step or npm script exists, there
is no "Publishing to AMO" documentation in EXTENSION.md or RELEASING.md, and
there are no submission notes, no listing and no AMO account yet.

## Information maintainers must verify before submission

This is the information to establish, not a claim that any of it is already
settled or that a submission has happened:

1. **Coordination.** A comment on issue #12 claiming the work so two people do
   not both submit; who owns the AMO account and the add-on listing; and
   whether `lexicon@ashlr.ai` is the intended long-term add-on ID, since
   future updates must go through the same ID.
2. **Candidate.** The source revision and version; that
   `npm run build:extension` actually produced
   `extension/lexicon-extension-firefox.zip` (the build can succeed without
   `zip`); the artifact checksum; and that the Chromium zip is not uploaded by
   mistake.
3. **Lint.** `npx web-ext lint --source-dir extension/dist-firefox` reporting
   zero errors on the candidate, and a decision on wiring it into the build or
   an npm script as the issue requests.
4. **Manifest.** The generated manifest's `background.scripts`, gecko id,
   `strict_min_version` and `data_collection_permissions` match the intended
   release, including the version left after the build strips any prerelease
   suffix into `version_name`.
5. **Permissions and API parity.** `storage`, `activeTab`, `scripting`, the
   chat-site and loopback `127.0.0.1:41733` / `localhost:41733` host
   permissions, and optional `<all_urls>` each behave correctly in Firefox and
   carry a justification ready for the listing; the loopback permission needs
   the reviewer-facing explanation the issue calls out, covering API mode
   (composer text, learned vocabulary and a bearer token sent to the local
   server) and embedded mode (no request at all).
6. **Reviewer materials.** The matching source archive or repository tag, the
   dependency lockfile, the Node version (`>=20` per `package.json` `engines`;
   CI builds on 22) and the exact build command, plus setup, pairing and test
   instructions that need no real user data or bearer token.
7. **Listing.** The name, summary, description, categories, screenshots,
   support contact and privacy policy; the copy must match the candidate's
   actual behavior, including loopback transmission and the absence of a
   hosted service.
8. **Install evidence.** The [manual checklist](EXTENSION.md#manual-checklist)
   passing in a clean Firefox profile on the supported versions: permanent
   installation, restart persistence, upgrades, pairing, editor sends,
   fallback, and permission revocation and regrant.
9. **Distribution path.** Mozilla's listed "On this site" submission path (not
   self-distribution), the current [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
   [policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
   and [source requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/),
   and where the listing URL and status are recorded before EXTENSION.md and
   the README roadmap change.

## Submission checklist

The target is a listed Firefox Add-ons (AMO) listing, submitted through
Mozilla's "On this site" path. All boxes are unverified until a maintainer
records evidence for them. Record the candidate revision, version, artifact
checksum, owner, dates and evidence links with the submission record.

### Candidate and review materials

- [ ] Claim the work on issue #12 and settle the AMO account owner and the
  long-term Gecko ID `lexicon@ashlr.ai`.
- [ ] From the candidate revision, run `npm ci` and `npm run build:extension`.
  Verify that `extension/lexicon-extension-firefox.zip` was created, inspect
  its root manifest and record its checksum. Do not upload the Chromium zip.
- [ ] Run `npx web-ext lint --source-dir extension/dist-firefox` and fix every
  error; investigate warnings.
- [ ] Prepare the source archive and reviewer build instructions. The build
  bundles with esbuild and minifies `core.js`, so Mozilla needs the source:
  the revision or tag, `package-lock.json`, the build scripts, the Node
  version and the exact command. Rebuild in a clean environment and compare
  the output with the candidate zip.
- [ ] Run the [manual checklist](EXTENSION.md#manual-checklist) in a clean
  Firefox profile on the supported versions, including permanent install,
  restart, upgrade, pairing on other ports, opt-in Any site, and permission
  revocation and regrant. Resolve failures.

### Listing and privacy

- [ ] Write the listing (name, summary, description, categories, license,
  support contact, screenshots) and check every claim against the candidate,
  including when the local server is needed.
- [ ] Justify `storage`, `activeTab`, `scripting`, the host permissions and
  optional `<all_urls>` in the listing, with the loopback explanation the issue
  asks for.
- [ ] Check the data declarations `personalCommunications`, `websiteContent`
  and `authenticationInfo` against actual behavior, and publish a privacy
  policy covering loopback transmission, use and retention.
- [ ] Write reviewer notes covering setup, pairing, both modes and the build.
  Use test data; never include a real user's bearer token.

### Submission and follow-up

- [ ] Upload the verified Firefox zip in the AMO Developer Hub on the listed
  path, attach the source, record the validation result, version and status,
  and answer review feedback.
- [ ] Verify the signed install and update from the live listing, record its
  URL, then add "Publishing to AMO" to EXTENSION.md and RELEASING.md and
  replace the `about:debugging` instructions and the README roadmap bullet.
  Future updates must go through the same AMO add-on.
