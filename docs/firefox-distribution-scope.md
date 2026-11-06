# Firefox extension distribution scope

The repository roadmap calls for a listed Firefox Add-ons (AMO) listing for
Lexicon's browser extension. The intended outcome is that Firefox users can
find and install the signed extension from its AMO listing. The current
[Firefox instructions](EXTENSION.md#firefox-notes) describe a temporary
installation that Firefox removes on exit; the built release zip alone does not
establish a listing, approval, or signed installation.

## Issue requirements and evidence

[Issue #12](https://github.com/ashlrai/lexicon/issues/12) is the source to
check for the requested scope and any explicitly stated prerequisites. Its
text could not be accessed when this page was written. Therefore the issue's
prerequisites and any additional acceptance criteria remain **unverified**;
the roadmap outcome above must not be treated as a complete summary of the
issue. Read the issue and update this section before using it to decide that
the request is complete.

## Repository preparation

The following are repository preparation steps, not claims about what issue
#12 explicitly requires:

- Build the Firefox package and verify that the zip exists. The build can
  succeed without producing a zip when `zip` is unavailable.
- Review the candidate's Firefox manifest, permissions, privacy disclosures,
  source and build materials, and test it in Firefox.
- Resolve account ownership, listing details, submission, signing and update
  responsibilities; record review and publication evidence when available.

See [Firefox readiness](firefox-extension-readiness.md) for repository
evidence and open questions, and the [submission checklist](firefox-addon-submission-checklist.md)
for the candidate and review steps. Neither document establishes that a
submission or publication has occurred.
