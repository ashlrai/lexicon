# Releasing

How to cut a release of `@ashlr/lexicon`. One tag drives everything: npm, the GitHub release and its download assets, and the Homebrew formula bump that follows.

## 1. Bump the version

Eleven files carry the version and must agree, in the ten rows below: `package.json` and `package-lock.json` share a row because `npm version` writes both, and the other nine rows are one file each. `npm version` handles that first row; the rest are edited by hand in the same commit. This table has been wrong four times now, and every time it shipped a skewed release, so treat anything not on it as a bug in this page rather than a file that does not matter. It said nine at 0.5.2 and ten at 0.5.3, and both times the miscount was counting rows and calling them files. `grep -rnE "0\.5\.[0-9]|v0\.5" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.next .` before you commit, with the old version's pattern, is the check that catches a new carrier. Do not trust the count in this sentence over that grep.

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

**Four things the grep finds that are not carriers.** `docs/assets/MANIFEST.md`, the alt text in `web/lib/media.ts` and the screenshots they describe are records of what a particular build actually printed, so bumping them would turn a transcript into a fabrication. `docs/EXTENSION.md` and `docs/MACOS-APP.md` quote sample output with a version inside it, and `docs/DISTRIBUTION.md`, `docs/COMMERCIAL.md` and the comments in `scripts/check-facts.mjs` name the release a thing happened in. `docs/metrics-copy.md` is the fourth: it is a dated handoff whose own opening says the project has been public for one day and has one GitHub star, so the line noting that `package.json` is ahead of what npm serves is part of that snapshot. Editing the version inside it and leaving the rest would turn a record into a half-fabricated one. Leave all of them. The rule is whether the number is a claim about *this* release or a record of an older one.

```bash
npm version patch --no-git-tag-version       # or minor / major; writes package.json + lock
# edit .claude-plugin/plugin.json, .claude-plugin/marketplace.json, server.json,
# the README install pin, apps/windows/Directory.Build.props and the VERSION
# constant in web/lib/site.ts to the same version
# date the CHANGELOG heading
npm run docs:cli                             # rewrites docs/CLI.md, including its version header

# The gate, in the order CI runs it. Everything here is also a CI job -- and so
# a failure now is a failure you would have got from the tag push anyway --
# with one exception, `check:server-json`, which no workflow runs at all.
npx tsc --noEmit
npx vitest run
npm run build && npm run build:site && npm run build:extension
npm run check:bundle                         # plugin/ bundles match src/ (CI fails on drift)
npm run check:links
npm run check:facts
npm run check:server-json -- --offline       # the `--` is load-bearing; see the note below
( cd apps/macos/LexiconBar && swift test )

# The release notes quote benchmark figures, so the benchmarks have to have been
# run against the code being tagged. Neither is a CI job. Both rewrite their
# result file on every run, and both put a timestamp (and `bench` a
# load-sensitive latency row) in it: if nothing else moved, restore the file by
# name rather than committing a diff that says nothing.
npm run bench
npm run bench:audio

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

The release workflow validates all eleven source version fields and the dated changelog before building and again before publishing. A missed bump fails before external writes.

**Build the plugin bundle from a clean checkout, not from your working tree.** A bundle built where `node_modules` is a symlink bakes hundreds of absolute paths to the maintainer's home directory into the published artifact: esbuild names every bundled module by the path it resolved to rather than by `node_modules/...`, and the result is committed. The count in this paragraph has been guessed at twice, so here is what the repository can actually be asked: `git log --format=%H --all -- plugin/hook.mjs` piped through `git show <sha>:plugin/hook.mjs | grep -c /Users/` finds exactly one commit that shipped them, 385c412, carrying 453 in `mcp-server.mjs` and 242 in `hook.mjs`, which is the 695 the 0.5.3 notes report. Any earlier occurrence was caught before it was committed and left no record, so run that command rather than trusting a number here. Clone the repo to a scratch directory, `npm ci` there, `npm run build:bundle`, and copy `plugin/` back. Then check the artifact before you tag, because a bundle is not something anyone reads by eye:

```bash
grep -c "/Users/" plugin/mcp-server.mjs plugin/hook.mjs   # both must be 0
```

`npm run check:bundle` rebuilds in place and diffs, so it proves the bundle matches `src/`; it does not prove the bundle is free of your home directory. Both checks are needed.

**`check:server-json` cannot pass before the publish.** Its third check fetches `https://registry.npmjs.org/@ashlr/lexicon/<version>` and requires an `mcpName` there, which is a statement about a version that is by definition not published yet. Run it with `--offline` before the tag (schema plus version agreement, which are the parts you can be wrong about), and run it again without the flag after npm has the release, which is when its answer means something.

**Write it `npm run check:server-json -- --offline`.** `--offline` is a real npm config flag, so `npm run check:server-json --offline` is consumed by npm, never reaches `process.argv`, and silently runs the two network checks anyway: the 404 on the unpublished version then makes the documented pre-tag gate exit 1 for the one reason it was told to skip. This page said it without the `--` until 0.5.3. Either write the `--`, or call the script directly as `node scripts/check-server-json.mjs --offline`.

## 2. What the tag triggers

`.github/workflows/release.yml` keeps the existing `v*` tag trigger and owner
protections. It has two parallel qualification jobs with default
`contents: read`, followed by one publication job that needs both to succeed.
Neither build job receives the npm publication secret or OIDC write authority.

**`ubuntu`** validates eleven source version fields plus the dated changelog
before building: package version, both lockfile versions, plugin and marketplace
versions, both MCP Registry versions, README install pin, Windows assembly
version, landing-page constant and generated CLI header. Homebrew's source-archive
checksum is deliberately updated after the tag, as described in step 4.
It then runs the release contract tests, clean dependency install, typecheck,
build, committed-bundle drift check, full tests, facts, offline server manifest
check and generated CLI-doc check. It builds both extension zips and packs the
npm archive once with lifecycle scripts disabled, because qualification already
ran. It uploads these original three assets and their canonical `SHA256SUMS`.

**`macos`** checks the same source versions, runs `swift test`, builds the app,
verifies its plist and code signature, and uploads `LexiconBar.app.zip` with its
own checksum. The runner signs ad-hoc, not with a distributable Developer ID.

**`publish`** runs only after both qualification jobs pass. It rechecks the source
version, downloads artifacts from this workflow run, verifies both producer
checksum inventories and assembles exactly four assets plus a complete
`SHA256SUMS`. Missing, extra, changed or symlinked assets fail before publication.
Copied bytes must still match the producer checksums captured before assembly.
It requires the existing `NPM_TOKEN` and workflow GitHub token, and proves that
neither this tag's release nor this exact npm version already exists. An HTTP
failure is not treated as absence.

The job publishes the original qualified `ashlr-lexicon-X.Y.Z.tgz` with
`--provenance`; it does not rebuild or repack in the privileged job. It checks the
exact registry name/version, SHA-512 integrity and downloaded archive bytes,
with bounded retries for registry propagation. Only then does it create a draft
GitHub release and upload the complete assets without overwrite. It verifies
hosted inventory, sizes, checksums and bytes against the qualified files,
rechecks npm acceptance, and makes the draft public. A final download verifies
the public release too. A successful publish command alone is insufficient.

These registry and GitHub mutations are not an atomic transaction. A failure
after npm accepts the immutable version can leave npm published and GitHub
absent or draft. Report each delivery layer separately. The workflow refuses
existing versions/releases instead of overwriting them on a rerun; preserve the
failed attempt for review and follow the fix-forward policy below.

Run the dependency-free contract checks before the tag:

```bash
node --test scripts/release-contract.test.mjs
node scripts/release-contract.mjs source . vX.Y.Z
```

The ordinary pull-request CI also runs the synthetic contract tests in its
Ubuntu Node 22 job. Those fixtures supply their own dated changelog, so an
unreleased candidate can be reviewed while the actual release source command
continues to reject an undated release.

### Signing for other people

`LexiconBar.app.zip` is signed ad-hoc and not notarized, so on someone else's Mac it is an unidentified developer: Gatekeeper blocks the first launch (right-click > Open, or `xattr -d com.apple.quarantine`), and its Accessibility grant is bound to a cdhash that changes with every release, so each update silently loses the grant until the user removes the row in System Settings and adds the app again. The local `LexiconBar Local Signing` certificate (`scripts/make-signing-identity.sh`, see [MACOS-APP.md](MACOS-APP.md#signing-and-why-the-accessibility-grant-kept-disappearing)) fixes that on the machine that made it and nowhere else. It is not distributable.

The real answer for shipping is a **Developer ID Application** certificate from the Apple Developer Program plus notarization: sign with `codesign --options runtime --sign "Developer ID Application: …"`, submit with `xcrun notarytool submit --wait`, then `xcrun stapler staple LexiconBar.app`. That gives a designated requirement anchored to Apple and the team id, which is stable across every release, so a user grants Accessibility once and updates keep it. In CI the certificate and its password go in repository secrets and are imported into a temporary keychain for the run; `LEXICONBAR_SIGN_IDENTITY` already lets `scripts/build-macos-app.sh` use whatever identity name is available. Until then, the README and the release notes should say the app is unsigned.

The asset names are referenced by the README, the demo site (`site/index.html`) and the Homebrew formula. Do not rename them without updating all three.

`.github/workflows/macos-app.yml` is separate: it builds the same app on pushes that touch `apps/macos/**` and stores the zip as a workflow artifact for review, not as a release asset. `.github/workflows/windows-app.yml` does the same for `apps/windows/**`, and `LexiconBar.exe` is likewise an artifact rather than a release asset, because nothing in that app has been verified on a real Windows desktop yet.

## 3. NPM_TOKEN

The normal release job requires the repository's existing `NPM_TOKEN` to have
publish rights for `@ashlr/lexicon`. The job's existing `id-token: write`
permission supplies GitHub Actions provenance. Build jobs have neither secret
nor OIDC publication authority. This workflow does not provision credentials.

If the token is absent, the job fails before npm or GitHub writes. It does not
report a successful npm skip or publish a GitHub-only release. The maintainer
must resolve existing access through the normal owner process; a missing token
is not authority to create one, broaden account access or use another publisher.

Publishing the prebuilt archive deliberately skips `prepublishOnly`: the exact
source was already qualified by the preceding jobs. The bytes published to npm
are the bytes preserved in the release, and both registry integrity and hosted
checksums must agree before the draft is made public. Existing versions cannot
be republished, and existing release assets cannot be replaced by a rerun.

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

After all three jobs and exact public-byte acceptance are green, on a machine without the tool:

```bash
curl -fsSL https://ashlrai.github.io/lexicon/install.sh | sh
lexicon --version
lexicon doctor
```

The demo site's Install section links `releases/latest/download/<asset>`, so those links go live as soon as the assets land. The site itself rebuilds from `main` through `.github/workflows/pages.yml`; the tag push does not rebuild it.

## Hotfixes

Patch releases follow the same source, qualification and owner tag steps with a new version. Never delete, move or reuse a published tag, version or release asset to repair a failed attempt. Preserve any partial npm publication or draft as incident evidence, report what actually succeeded, and have the release owner review a new fix-forward version. A rerun is not an overwrite or partial-publication recovery path.

## See also

- [LANDING.md](LANDING.md) is the site whose install links go live with the assets.
- [DISTRIBUTION.md](DISTRIBUTION.md) covers where to list a release once it is out.
- [CHANGELOG.md](../CHANGELOG.md) is the file step 1 dates.

Back to [the docs index](README.md).
