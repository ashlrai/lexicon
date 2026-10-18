# Post-quantum readiness

Status as of 2026-10-17. This note records what Lexicon does with cryptography today and what a post-quantum migration would touch. It makes no claim that Lexicon is quantum-safe or quantum-resistant, and it adds no new cryptography.

## Background (verified against NIST pages)
- NIST published FIPS 203 (ML-KEM), FIPS 204 (ML-DSA) and FIPS 205 (SLH-DSA) on August 13, 2024. Source: https://csrc.nist.gov/Projects/Post-Quantum-Cryptography/Post-Quantum-Cryptography-Standardization
- Shor's algorithm would break RSA and elliptic-curve schemes (RSA, ECDSA, ECDH, X25519, Ed25519) on a large enough quantum computer. Grover's algorithm gives a quadratic speedup on brute-force search, so symmetric keys are usually sized at 256 bits.
- Harvest-now-decrypt-later applies to confidentiality: ciphertext captured today, protected only by classical key exchange, could be read later. Signatures are different: they matter when they are verified, so the risk is forgery after a capable quantum computer exists.

## What Lexicon uses today
- Hashes only, for integrity and identity, never secrecy: SHA-256 pins the content of a trusted `.lexicon.yaml` (`src/cli/cmd-trust.ts`) and of review and import previews (`src/cli/cmd-review.ts`, `src/core/import-preview.ts`); the release contract checks SHA-256 and SHA-512 digests (`scripts/release-contract.mjs`). SHA-1 appears only as a short display label in benchmark scripts (`bench/audio`), not as a security control.
- No encryption, key exchange or signing in the shipped source. The inventory scan finds no RSA, ECDSA, ECDH, Ed25519 or X25519 use.
- Network transport security is whatever the Node.js runtime and the optional services provide; Lexicon does not configure TLS groups, so nothing is claimed about it here.

## The check
`scripts/check-crypto.mjs` scans source files (not tests, docs or vendored directories) for classical asymmetric primitives: RSA, ECDSA/ECDH, Ed25519/X25519 and Diffie-Hellman key generation. It prints an inventory and exits 1 when a file that is not in its `ALLOW` list uses one, so a new classical-only use needs a deliberate decision with a written reason. It does not judge hashes, HMAC or symmetric ciphers, and it is a regex scan, not a parser: it can miss indirect use through a dependency. Run it with `node scripts/check-crypto.mjs`; its tests run with `node --test scripts/check-crypto.test.mjs`.

## Library note
No post-quantum library is used here, because there is no concrete use that needs one. If one is added later, `@noble/post-quantum` 0.7.1 (MIT) offers ML-KEM, ML-DSA and SLH-DSA in TypeScript, but its README states it is not independently audited and not constant-time, so it should not be used for secret-key signing on shared hardware. RustCrypto `ml-kem` and `ml-dsa` carry the same "never independently audited" statement. Any adoption should say so in its docs. Source notes: Phantom's quantum research, /workspace/phantom-work/quantum-research.md.

## If a migration is needed
Because Lexicon holds no keys, the realistic exposure is the release channel: npm and GitHub provenance and any future signed release artifact. Choose signatures when the registries support a post-quantum scheme; until then the digest checks in `scripts/release-contract.mjs` stay as they are.
