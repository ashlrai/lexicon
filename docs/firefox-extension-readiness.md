# Firefox extension readiness

This is a packaging and review checklist for the Firefox extension in the
context of [issue #12](https://github.com/ashlrai/lexicon/issues/12). The issue
text was not available when this checklist was written, so its specific
requirements still need to be checked against this page. This is not evidence
of an AMO submission, approval, signing, or publication. The repository's
[extension guide](EXTENSION.md) describes temporary installation and says there
is no AMO listing yet.

## Repository evidence and prerequisites

- Build with `npm run build:extension` from a checkout with dependencies
  installed. [The build script](../scripts/build-extension.mjs) creates
  `extension/dist-firefox` and, when `zip` is on PATH,
  `extension/lexicon-extension-firefox.zip`. Check that the zip was actually
  created; a successful build can report that zip was unavailable. The build
  strips a prerelease suffix from the manifest version and keeps the package
  version as `version_name`.
- The Firefox package copies the Chromium build and changes its manifest via
  [extension-manifest.mjs](../scripts/extension-manifest.mjs): a module
  `background.scripts` entry, Gecko ID `lexicon@ashlr.ai`, and minimum Firefox
  `140.0`. Review the generated manifest and package for the intended release;
  the source [manifest](../extension/manifest.json) is the Chromium variant.
- The manifest requests `storage`, `activeTab`, and `scripting`, chat-site and
  default loopback host access, and optional `<all_urls>` access. The latter
  supports opt-in Any site and pairing on other ports. Explain these permissions
  and verify the user-facing consent and revocation behavior in Firefox. See
  [the extension guide](EXTENSION.md#firefox-notes).
- API mode sends composer text, learned vocabulary and a bearer token to the
  local server. The Firefox manifest declares `personalCommunications`,
  `websiteContent`, and `authenticationInfo`; embedded correction runs inside
  the extension. Review the declarations and privacy explanation against the
  actual behavior, including loopback transmission. The
  [review test](../tests/extension-firefox-review.test.ts) exercises both modes.
- The current installation instructions load `manifest.json` through
  `about:debugging` as a temporary add-on, removed when Firefox exits. A built
  zip and a successful temporary load do not establish signing or store readiness.
- Run the [manual browser checklist](EXTENSION.md#manual-checklist) in Firefox,
  including pairing, editor sends, fallback, permissions and Any site. Record
  browser version, results and failures; the automated DOM tests do not establish
  real browser editor compatibility.

## Open questions before submission

1. Does issue #12 specify additional acceptance criteria or a distribution
   channel that this checklist has missed?
2. Who owns the AMO account, add-on identity, signing and submission, and is
   `lexicon@ashlr.ai` the intended long-term ID?
3. What current Mozilla review, source-code and reproducible-build materials
   are required for this bundled package? Identify the exact source revision,
   dependency lockfile and build instructions to accompany the candidate.
4. What listing copy, screenshots, support and privacy policy links are needed,
   and do they accurately describe local API and embedded modes, permissions,
   retention and the absence of a hosted service?
5. Has the candidate passed Firefox's current validation and manual tests on
   the supported versions, including permission removal and regrant, pairing on
   other ports, upgrades and restart behavior? Record evidence and resolve
   failures before requesting review.
6. What is the signing, distribution and update path, and how will the signed
   artifact be matched to the reviewed source and communicated to users?

These questions are work to resolve, not a claim that Mozilla requires any
particular answer or that a release has been submitted.
