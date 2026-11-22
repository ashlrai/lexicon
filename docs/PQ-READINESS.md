# Post-quantum readiness

First written 2026-10-17; the inventory below was rechecked against the source on 2026-11-22. This note records what Lexicon does with cryptography today and what a post-quantum migration would touch. It makes no claim that Lexicon is quantum-safe or quantum-resistant, and it adds no new cryptography.

## Background (verified against NIST pages)
- NIST published FIPS 203 (ML-KEM), FIPS 204 (ML-DSA) and FIPS 205 (SLH-DSA) on August 13, 2024. Source: https://csrc.nist.gov/Projects/Post-Quantum-Cryptography/Post-Quantum-Cryptography-Standardization
- Shor's algorithm would break RSA and elliptic-curve schemes (RSA, ECDSA, ECDH, X25519, Ed25519) on a large enough quantum computer. Grover's algorithm gives a quadratic speedup on brute-force search, so symmetric keys are usually sized at 256 bits.
- Harvest-now-decrypt-later applies to confidentiality: ciphertext captured today, protected only by classical key exchange, could be read later. Signatures are different: they matter when they are verified, so the risk is forgery after a capable quantum computer exists.

## What Lexicon uses today
Everything comes from `node:crypto`; there is no third-party crypto dependency.

- SHA-256, for integrity and identity:
  - trust pins: the content hash of a trusted `.lexicon.yaml` (`src/core/trust.ts`, shared with `src/core/parsed-hash.ts`; `src/cli/cmd-trust.ts` shows and compares it);
  - review and import previews: the file hash in `src/cli/cmd-review.ts` and the preview ids in `src/core/import-preview.ts`;
  - downloads: community pack files are checked against the registry's `checksum` (`src/core/registry.ts`, which also derives project cache directory names from a hash), and a downloaded voice model is checked against the SHA-256 Hugging Face states in `X-Linked-Etag` or `ETag` (`src/voice/models.ts`, which also caches the model's hash beside it);
  - labels: short ids for queued corrections (`src/core/pending.ts`);
  - the local API token check (`src/serve/server.ts`) hashes the presented and the stored token to fixed-length digests before `timingSafeEqual`, so the comparison does not leak the token's length.
- The release contract (`scripts/release-contract.mjs`) writes and checks `SHA256SUMS` for the release assets and the npm `sha512-` integrity of the published tarball.
- Random values: the local API bearer token is 16 bytes from `randomBytes` (`src/serve/config.ts`), a 128-bit shared secret compared on loopback; temporary file names add a few random bytes. These are symmetric secrets, not keys for an asymmetric scheme.
- SHA-1 appears only as a short display label in the benchmark scripts (`bench/audio`), not as a security control.
- No encryption, key exchange or signing in the shipped source. The scan below finds no RSA, ECDSA, ECDH, Ed25519 or X25519 use.
- Network transport security is whatever the Node.js runtime and the optional services provide; Lexicon does not configure TLS groups, so nothing is claimed about it here.

## The check
`scripts/check-crypto.mjs` scans source files for classical asymmetric primitives: RSA, ECDSA/ECDH, Ed25519/X25519 and Diffie-Hellman key generation. It reads `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.rs` and `.toml` files, and skips `node_modules`, `target`, `.git`, `dist`, `build`, `coverage`, `.next` and `docs` directories, `test`/`tests`/`__tests__` directories and `*.test.*` files. It prints an inventory and exits 1 when a file that is not in its `ALLOW` list uses one, so a new classical-only use needs a deliberate decision with a written reason. The `ALLOW` list is empty today and the current inventory is `0 file(s)`.

It does not judge hashes, HMAC or symmetric ciphers, and it is a regex scan, not a parser: it can miss indirect use through a dependency. Run it with `npm run check:crypto`, which runs its tests (`node --test scripts/check-crypto.test.mjs`) and then the scan. The required `CI Gate` check runs it on every pull request and merge-queue run (the "Crypto policy check" step in `.github/workflows/ci.yml`).

## Library note
No post-quantum library is used here, because there is no concrete use that needs one. If one is added later, `@noble/post-quantum` 0.7.1 (MIT) offers ML-KEM, ML-DSA and SLH-DSA in TypeScript, but its README states it is not independently audited and not constant-time, so it should not be used for secret-key signing on shared hardware. RustCrypto `ml-kem` and `ml-dsa` carry the same "never independently audited" statement. Any adoption should say so in its docs. These library notes come from Phantom's post-quantum research, from which this page started.

## If a migration is needed
Because Lexicon holds no keys, the realistic exposure is the release channel: npm and GitHub provenance and any future signed release artifact. Choose signatures when the registries support a post-quantum scheme; until then the digest checks in `scripts/release-contract.mjs` stay as they are.
