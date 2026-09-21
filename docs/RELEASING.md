# Releasing

How to cut a release of `@ashlr/lexicon`. One tag drives everything: npm, the GitHub release and its download assets, and the Homebrew formula bump that follows.

## 1. Bump the version

Ten files carry the version and must agree. `npm version` handles the first two; the rest are edited by hand in the same commit. This table has been wrong three times, and every time it shipped a skewed release, so treat anything not on it as a bug in this page rather than a file that does not matter. `grep -rnE "0\.5\.[0-9]|v0\.5" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next .` before you commit, with the old version's pattern, is the check that catches a new carrier. Do not trust the count in this sentence over that grep.

| File | Field |
|---|---|
| `package.json` (and `package-lock.json`) | `version` |
| `.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `plugins[0].version` |
| `server.json` | `version` and `packages[0].version` (the MCP Registry reads both) |
| `README.md` | the `github:ashlrai/lexicon#vX.Y.Z` install pin. It names a tag that must exist, so it cannot be left at whatever it said when it was written; `check:facts` fails the build on a stale one, which is why it is here rather than in your head |
| `apps/windows/Directory.Build.props` | `<Version>`, the assembly version of the Windows tray app. Nothing derives it from `package.json` |
| `web/lib/site.ts` | `VERSION`, the constant the landing page renders. Nothing derives it from `package.json`, and it is the one that shipped wrong: the site said 0.5.0 while the package said 0.5.2 and npm served 0.5.1. `check:facts` reads any declared `VERSION` constant now and fails on a stale one |
| `docs/CLI.md` | not edited by hand: `npm run docs:cli` regenerates it and it carries the version in its header. The CI `docs` job runs the generator and diffs the result, so a skipped regeneration fails the build |
| `packaging/homebrew/lexicon.rb` | `url` and `sha256`, in step 4 rather than here, because the sha256 does not exist until the tag does |
| `CHANGELOG.md` | rename `## X.Y.Z (unreleased)` to `## X.Y.Z (YYYY-MM-DD)` |

The extension manifest and `LexiconBar.app` read the version from `package.json` at build time, so they need no edit. `apps/windows` does not.

**Three things the grep finds that are not carriers.** `docs/assets/MANIFEST.md`, the alt text in `web/lib/media.ts` and the screenshots they describe are records of what a particular build actually printed, so bumping them would turn a transcript into a fabrication. `docs/EXTENSION.md` and `docs/MACOS-APP.md` quote sample output with a version inside it, and `docs/DISTRIBUTION.md`, `docs/COMMERCIAL.md` and the comments in `scripts/check-facts.mjs` name the release a thing happened in. Leave all of them. The rule is whether the number is a claim about *this* release or a record of an older one.

```bash
npm version patch --no-git-tag-version       # or minor / major; writes package.json + lock
# edit .claude-plugin/plugin.json, .claude-plugin/marketplace.json, server.json,
# the README install pin, apps/windows/Directory.Build.props and the VERSION
# constant in web/lib/site.ts to the same version
# date the CHANGELOG heading
npm run docs:cli                             # rewrites docs/CLI.md, including its version header

# The gate, in the order CI runs it. Everything here is also a CI job, so a
# failure now is a failure you would have got from the tag push anyway.
npx tsc --noEmit
npx vitest run
npm run build && npm run build:site && npm run build:extension
npm run check:bundle                         # plugin/ bundles match src/ (CI fails on drift)
npm run check:links
npm run check:facts
npm run check:server-json --offline          # see the note below before running it online
( cd apps/macos/LexiconBar && swift test )

# Stage by explicit path. `git add -A` has twice swept up another agent's
# uncommitted work in this shared tree, and it is how the plugin bundle came
# to be committed carrying source that the commit did not contain.
# `packaging/homebrew/lexicon.rb` is deliberately absent: its sha256 is the
# checksum of a source archive that does not exist until the tag is pushed, so
# it lands in step 4 as its own commit. This list used to name it, which meant
# committing a formula whose url and sha256 disagreed.
git add package.json package-lock.json server.json CHANGELOG.md README.md \
        .claude-plugin/plugin.json .claude-plugin/marketplace.json \
        apps/windows/Directory.Build.props web/lib/site.ts docs/CLI.md
git commit -m "vX.Y.Z"

# Annotated, not lightweight. `git push --follow-tags` pushes annotated tags
# only, so a lightweight one is created locally, silently not pushed, and the
# release workflow never fires. Every tag from v0.4.0 on is annotated.
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --follow-tags
```

The release workflow refuses to run when the tag does not match `package.json`, so a missed bump fails fast instead of publishing the wrong number.

**Build the plugin bundle from a clean checkout, not from your working tree.** Twice now a bundle built where `node_modules` is a symlink has baked hundreds of absolute paths to the maintainer's home directory into the published artifact: esbuild names every bundled module by the path it resolved to rather than by `node_modules/...`, and the result is committed. Clone the repo to a scratch directory, `npm ci` there, `npm run build:bundle`, and copy `plugin/` back. Then check the artifact before you tag, because a bundle is not something anyone reads by eye:

```bash
grep -c "/Users/" plugin/mcp-server.mjs plugin/hook.mjs   # both must be 0
```

`npm run check:bundle` rebuilds in place and diffs, so it proves the bundle matches `src/`; it does not prove the bundle is free of your home directory. Both checks are needed.

**`check:server-json` cannot pass before the publish.** Its third check fetches `https://registry.npmjs.org/@ashlr/lexicon/<version>` and requires an `mcpName` there, which is a statement about a version that is by definition not published yet. Run it with `--offline` before the tag (schema plus version agreement, which are the parts you can be wrong about), and run it again without the flag after npm has the release, which is when its answer means something.

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

`LexiconBar.app.zip` is signed ad-hoc and not notarized, so on someone else's Mac it is an unidentified developer: Gatekeeper blocks the first launch (right-click > Open, or `xattr -d com.apple.quarantine`), and its Accessibility grant is bound to a cdhash that changes with every release, so each update silently loses the grant until the user removes the row in System Settings and adds the app again. The local `LexiconBar Local Signing` certificate (`scripts/make-signing-identity.sh`, see [MACOS-APP.md](MACOS-APP.md#signing-and-why-the-accessibility-grant-kept-disappearing)) fixes that on the machine that made it and nowhere else. It is not distributable.

The real answer for shipping is a **Developer ID Application** certificate from the Apple Developer Program plus notarization: sign with `codesign --options runtime --sign "Developer ID Application: …"`, submit with `xcrun notarytool submit --wait`, then `xcrun stapler staple LexiconBar.app`. That gives a designated requirement anchored to Apple and the team id, which is stable across every release, so a user grants Accessibility once and updates keep it. In CI the certificate and its password go in repository secrets and are imported into a temporary keychain for the run; `LEXICONBAR_SIGN_IDENTITY` already lets `scripts/build-macos-app.sh` use whatever identity name is available. Until then, the README and the release notes should say the app is unsigned.

The asset names are referenced by the README, the demo site (`site/index.html`) and the Homebrew formula. Do not rename them without updating all three.

`.github/workflows/macos-app.yml` is separate: it builds the same app on pushes that touch `apps/macos/**` and stores the zip as a workflow artifact for review, not as a release asset. `.github/workflows/windows-app.yml` does the same for `apps/windows/**`, and `LexiconBar.exe` is likewise an artifact rather than a release asset, because nothing in that app has been verified on a real Windows desktop yet.

## 3. NPM_TOKEN

The npm publish needs a repository secret named `NPM_TOKEN`: an npm Automation token, or a granular token with publish rights on the `@ashlr` scope. Provenance attestation uses the workflow's `id-token: write` permission, already set; nothing else to configure.

If the secret is missing, the `Skipped npm publish` step says so and the run still succeeds: the GitHub release and every asset on it are produced either way. Only npm is left.

**Publishing by hand: drop `--provenance`.** It is not an optional extra there, it is a hard error. `libnpmpublish` generates an attestation from the CI provider's OIDC token and nothing else, so outside GitHub Actions or GitLab CI it throws `EUSAGE: Automatic provenance generation not supported for provider: <name>` before it reaches the registry. This page said to publish by hand *with* that flag until 0.5.2.

Publish the tarball the release already carries, rather than rebuilding from a checkout. It is the artifact CI produced and the one whose sha256 is in `SHA256SUMS`, so what reaches npm is the thing that was tested:

```bash
V=X.Y.Z
gh release download "v$V" --repo ashlrai/lexicon --pattern "ashlr-lexicon-$V.tgz"
shasum -a 256 "ashlr-lexicon-$V.tgz"            # must match SHA256SUMS on the release
npm publish "./ashlr-lexicon-$V.tgz" --access public
npm run check:server-json                        # now meaningful: the 404 is gone and mcpName is checked
```

Publishing a prebuilt tarball does not run `prepublishOnly`, which is correct here because CI already ran the build, the bundle and the tests to produce it.

The release keeps its provenance attestation only if npm does the publish from the workflow, which means an `NPM_TOKEN` in repository secrets. That is a token that publishes without a second factor, so it is a real trade against a hardware key on the account, and it is the maintainer's call rather than this page's.

## 4. Update the Homebrew formula

The formula in `ashlrai/homebrew-tap` (`Formula/lexicon.rb`) installs from the release tarball and pins its sha256. After the `publish` job finishes:

The formula builds from source: its `install` block runs `npm install` and `npm run build`, so it needs the **git source archive**, not the npm pack tarball on the release. `ashlr-lexicon-X.Y.Z.tgz` ships `dist/` and no `src/`, so a formula pinned to it cannot build and `SHA256SUMS` on the release is the wrong file to read the checksum out of. This page said otherwise until 0.5.2.

```bash
V=X.Y.Z
curl -fsSL -o /tmp/lexicon-src.tar.gz "https://github.com/ashlrai/lexicon/archive/refs/tags/v$V.tar.gz"
shasum -a 256 /tmp/lexicon-src.tar.gz
```

In the formula set `url` to the new tarball URL and `sha256` to that value, then:

```bash
brew install --build-from-source ashlrai/tap/lexicon
brew test lexicon
brew audit --strict lexicon
```

`packaging/homebrew/lexicon.rb` in this repo is the source of truth; `ashlrai/homebrew-tap` carries the same file as `Formula/lexicon.rb`. Update both in the same sitting or they drift, which is how the tap came to be two releases behind: 0.3.2 cannot parse a lexicon written by 0.5.x, so anyone who installed through brew and then ran `lexicon setup` had a broken tool.

```bash
git clone https://github.com/ashlrai/homebrew-tap /tmp/homebrew-tap
cp packaging/homebrew/lexicon.rb /tmp/homebrew-tap/Formula/lexicon.rb
cd /tmp/homebrew-tap && git add Formula/lexicon.rb && git commit -m "lexicon X.Y.Z" && git push
```

`brew install ashlrai/tap/lexicon` picks it up on the next `brew update`.

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

## See also

- [LANDING.md](LANDING.md) is the site whose install links go live with the assets.
- [DISTRIBUTION.md](DISTRIBUTION.md) covers where to list a release once it is out.
- [CHANGELOG.md](../CHANGELOG.md) is the file step 1 dates.

Back to [the docs index](README.md).
