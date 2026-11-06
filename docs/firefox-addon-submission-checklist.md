# Firefox add-on submission checklist

The intended distribution target is a **listed Firefox Add-ons (AMO) listing**,
as stated in the [repository roadmap](../README.md#roadmap-and-non-goals). Use Mozilla's
“On this site” submission path, not the self-distribution path. This checklist
is for [issue #12](https://github.com/ashlrai/lexicon/issues/12); its text was
not accessible when this page was written, so verify its exact requirements
before submission. A release zip or temporary installation is not an AMO
submission, signature, approval, or publication. All boxes are unverified.

Record the candidate revision, version, artifact checksum, owner, dates and
evidence links with the submission record. Recheck Mozilla's current
[submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/),
[policies](https://extensionworkshop.com/documentation/publish/add-on-policies/)
and [source requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/)
for each candidate.

## Candidate and review materials

- [ ] Confirm issue #12's requirements, listing target, responsible AMO account,
  ownership and long-term Gecko ID `lexicon@ashlr.ai`.
- [ ] From the candidate revision, install locked dependencies and run
  `npm run build:extension`. Verify that
  `extension/lexicon-extension-firefox.zip` was created (the build can succeed
  without `zip`); inspect its root manifest and record its checksum. Do not
  upload the Chromium zip.
- [ ] Inspect the generated Firefox manifest for the intended version,
  `background.scripts`, Gecko ID and minimum Firefox version. The build strips
  a prerelease suffix from `version` and retains it in `version_name`; confirm
  the resulting version is suitable for this AMO submission.
- [ ] Prepare matching source and reviewer build instructions. The build uses
  esbuild bundles and minifies `core.js`; Mozilla requires source for generated
  code of this kind. Include the source revision, `package-lock.json`, build
  scripts, tool versions, environment and exact commands. Rebuild in a clean
  environment and compare the generated files with the candidate zip; resolve
  differences and document any environment requirements.
- [ ] Run the [manual Firefox checklist](EXTENSION.md#manual-checklist) on the
  supported Firefox versions. Record results for installation, restart and
  upgrade, editor sends, pairing, fallback, and permission removal and regrant,
  including opt-in Any site and other pairing ports. Resolve failures.

## Listing and privacy

- [ ] Prepare the listing name, unique URL, summary, description, categories,
  license, support contact and screenshots. Check feature and compatibility
  claims against the candidate, including whether the local server is needed.
- [ ] Review `storage`, `activeTab`, `scripting`, required host access and
  optional `<all_urls>` against the implementation. Explain why each is used
  and verify Firefox consent and revocation behavior.
- [ ] Verify the Firefox data declarations `personalCommunications`,
  `websiteContent` and `authenticationInfo` against actual behavior. API mode
  sends composer text, learned vocabulary and a bearer token to the local
  server; embedded correction runs inside the extension. Prepare a privacy
  policy covering the actual data flows, use and retention, including loopback
  transmission. See [Firefox notes](EXTENSION.md#firefox-notes) and
  [review evidence](firefox-extension-readiness.md).
- [ ] Prepare reviewer notes with setup and pairing instructions, both modes,
  permissions, test steps and source build instructions. Use test data and
  never include a real user's bearer token.

## Submission and follow-up

- [ ] In the AMO Developer Hub, choose the listed distribution path and upload
  the verified Firefox zip. Record validation results, address errors and
  investigate warnings, then attach the matching source and review materials.
- [ ] Complete the listing fields, submit the candidate and record the AMO
  version and status. Monitor review feedback and resolve any issues.
- [ ] Verify the actual listing, signed installation and update behavior once
  available. Record the listing URL and status before updating user-facing
  installation instructions. Future updates must use the same AMO add-on.
