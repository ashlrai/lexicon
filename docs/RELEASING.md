# Releasing

How to cut a release of `@ashlr/lexicon`. One tag drives everything: npm, the GitHub release and its download assets, and the Homebrew formula bump that follows.

## 1. Bump the version

Four files carry the version and must agree. `npm version` handles the first; edit the other three by hand in the same commit.

| File | Field |
|---|---|
| `package.json` (and `package-lock.json`) | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `plugins[0].version` |
| `CHANGELOG.md` | rename `## X.Y.Z (unreleased)` to `## X.Y.Z (YYYY-MM-DD)` |

```bash
npm version minor --no-git-tag-version      # or patch / major; writes package.json + lock
# edit .claude-plugin/plugin.json and .claude-plugin/marketplace.json to the same version
# date the CHANGELOG heading
npm run check:bundle                         # plugin/ bundles match src/ (CI fails on drift)
npm run docs:cli                             # docs/CLI.md matches --help
npm test
git add -A
git commit -m "vX.Y.Z"
git tag vX.Y.Z
git push --follow-tags
```

The release workflow refuses to run when the tag does not match `package.json`, so a missed bump fails fast instead of publishing the wrong number.

The extension manifest and `LexiconBar.app` read the version from `package.json` at build time, so they need no edit.

## 2. What the tag triggers

`.github/workflows/release.yml` runs on any `v*` tag, in two jobs.

**`publish` (ubuntu)**

1. `npm ci`, typecheck, build, bundle, `npm test`.
2. Tag check against `package.json`.
3. `npm publish --provenance --access public` when the `NPM_TOKEN` secret is set. Without it the step is skipped and the run still succeeds; the log says so.
4. `npm run build:extension` for the two extension zips.
5. `npm pack` for the tarball.
6. `gh release create vX.Y.Z --generate-notes`, then `gh release upload --clobber` of:
   - `ashlr-lexicon-X.Y.Z.tgz`
   - `lexicon-extension.zip`
   - `lexicon-extension-firefox.zip`
   - `SHA256SUMS` (covering the three above)

**`macos` (macos-latest, after `publish`)**

1. `swift test` for LexiconBarKit.
2. `scripts/build-macos-app.sh`: release build, `.app` assembly, icon, codesign, zip. On a CI runner there is no local signing identity, so the build signs ad-hoc and says so.
3. Downloads `SHA256SUMS` from the release, appends `LexiconBar.app.zip`, uploads both with `--clobber`.

Every upload uses `--clobber`, so re-running a failed job replaces its own assets without touching the others. The release exists as soon as the `publish` job creates it; `LexiconBar.app.zip` appears a few minutes later.

### Signing for other people

`LexiconBar.app.zip` is signed ad-hoc and not notarized, so on someone else's Mac it is an unidentified developer: Gatekeeper blocks the first launch (right-click > Open, or `xattr -d com.apple.quarantine`), and its Accessibility grant is bound to a cdhash that changes with every release, so each update silently loses the grant until the user removes the row in System Settings and adds the app again. The local `LexiconBar Local Signing` certificate (`scripts/make-signing-identity.sh`, see [MACOS-APP.md](MACOS-APP.md#signing-and-why-the-accessibility-grant-kept-disappearing)) fixes that on the machine that made it and nowhere else — it is not distributable.

The real answer for shipping is a **Developer ID Application** certificate from the Apple Developer Program plus notarization: sign with `codesign --options runtime --sign "Developer ID Application: …"`, submit with `xcrun notarytool submit --wait`, then `xcrun stapler staple LexiconBar.app`. That gives a designated requirement anchored to Apple and the team id, which is stable across every release, so a user grants Accessibility once and updates keep it. In CI the certificate and its password go in repository secrets and are imported into a temporary keychain for the run; `LEXICONBAR_SIGN_IDENTITY` already lets `scripts/build-macos-app.sh` use whatever identity name is available. Until then, the README and the release notes should say the app is unsigned.

The asset names are referenced by the README, the demo site (`site/index.html`) and the Homebrew formula. Do not rename them without updating all three.

`.github/workflows/macos-app.yml` is separate: it builds the same app on pushes that touch `apps/macos/**` and stores the zip as a workflow artifact for review, not as a release asset.

## 3. NPM_TOKEN

The npm publish needs a repository secret named `NPM_TOKEN`: an npm Automation token, or a granular token with publish rights on the `@ashlr` scope. Provenance attestation uses the workflow's `id-token: write` permission, already set; nothing else to configure.

If the secret is missing the release still gets its GitHub assets. Publish by hand afterwards with `npm publish --provenance --access public` from a clean checkout of the tag, or add the secret and re-run the `publish` job.

## 4. Update the Homebrew formula

The formula in `ashlrai/homebrew-tap` (`Formula/lexicon.rb`) installs from the release tarball and pins its sha256. After the `publish` job finishes:

```bash
V=X.Y.Z
curl -fsSL -o /tmp/lexicon.tgz "https://github.com/ashlrai/lexicon/releases/download/v$V/ashlr-lexicon-$V.tgz"
shasum -a 256 /tmp/lexicon.tgz
# or read it from the release's SHA256SUMS:
curl -fsSL "https://github.com/ashlrai/lexicon/releases/download/v$V/SHA256SUMS" | grep ashlr-lexicon
```

In the formula set `url` to the new tarball URL and `sha256` to that value, then:

```bash
brew install --build-from-source ashlrai/tap/lexicon
brew test lexicon
brew audit --strict lexicon
```

Commit and push the tap. `brew install ashlrai/tap/lexicon` picks it up on the next `brew update`.

## 5. Check the first 60 seconds

After both jobs are green, on a machine without the tool:

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
lexicon --version
lexicon doctor
```

The demo site's Install section links `releases/latest/download/<asset>`, so those links go live as soon as the assets land. The site itself rebuilds from `main` through `.github/workflows/pages.yml`; the tag push does not rebuild it.

## Hotfixes

Patch releases follow the same steps with `npm version patch`. If a job fails after the release was created, fix the cause on `main`, delete the tag and release (`gh release delete vX.Y.Z --cleanup-tag`) and tag again, or re-run the failed job when the fix needs no code change (a flaky runner, a missing secret).
