# Firefox extension publication questions

The requested outcome for [issue #12](https://github.com/ashlrai/lexicon/issues/12)
is a Firefox Add-ons (AMO) listing for Lexicon, as reflected in the
[repository roadmap](../README.md#roadmap-and-non-goals): users should be able to
find and install the signed extension from a listed add-on page. The issue text
was not accessible when this document was written, so its exact requirements
and any additional acceptance criteria remain unverified. Confirm them against
the issue before treating this outcome as complete.

This document records questions, not a submission or publication. The current
[Firefox instructions](EXTENSION.md#firefox-notes) describe a temporary add-on
that is removed when Firefox exits. A built zip or temporary installation does
not establish AMO submission, signing, approval, or publication.

## Packaging questions

1. Which source revision and version will be the candidate? Is the build's
   prerelease suffix handling suitable for that version, and does the generated
   Firefox manifest contain the intended ID and minimum Firefox version?
2. Who owns the AMO account and `lexicon@ashlr.ai` identity, and is that ID
   intended for the long term? Who will manage signing and subsequent updates?
3. Does `npm run build:extension` produce the Firefox zip in the candidate
   environment? The [build script](../scripts/build-extension.mjs) can succeed
   without a zip when `zip` is unavailable. Who will verify its contents and
   checksum and match it to the source revision?
4. What source archive, dependency lockfile, tool versions and build steps will
   Mozilla need to review the bundled and minified code? Can a clean build be
   reconciled with the uploaded artifact?

## Review and listing questions

1. What are Mozilla's current validation, source submission and review
   requirements for this candidate? Consult the [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
   [source guidance](https://extensionworkshop.com/documentation/publish/source-code-submission/)
   and [policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
   when preparing the submission.
2. Are the permissions, optional host access and Firefox data declarations
   accurate and justified? How should the listing and privacy policy explain
   embedded correction and API mode, including data sent to the local server?
3. What listing copy, screenshots, support contact, privacy policy and reviewer
   instructions are needed? Can a reviewer set up and test both modes without
   real user data or credentials?
4. Has the candidate passed validation and the [manual Firefox checklist](EXTENSION.md#manual-checklist),
   including pairing, permission revocation and regrant, restart and upgrade?
   Where will browser versions, results and review feedback be recorded?
5. Who will submit through the listed distribution path, respond to review,
   and verify the signed installation and update from the actual listing? Where
   will the listing URL and final status be recorded before instructions change?

For repository evidence see [Firefox readiness](firefox-extension-readiness.md);
for concrete preparation steps see the [submission checklist](firefox-addon-submission-checklist.md).
All questions above remain open until supported by candidate or review evidence.
