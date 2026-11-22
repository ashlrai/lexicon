/**
 * The trust gate hashes the exact bytes a project lexicon was parsed from.
 * These pin the side table in core/parsed-hash.ts: which hash a parsed file
 * reports, how sharing and copying behave, and what a bad input does.
 */
import { describe, expect, it } from 'vitest';
import {
  recalledParsedHash,
  rememberParsedBytes,
  rememberParsedHash,
  sha256OfBytes,
  shareParsedHash,
} from '../src/core/parsed-hash.js';
import type { LexiconFile } from '../src/core/types.js';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function project(path = '/repo/.lexicon.yaml'): LexiconFile {
  return { path, scope: 'project', lexicon: { version: 1, terms: [] }, exists: true };
}

describe('sha256OfBytes', () => {
  it('hashes a string and its UTF-8 bytes to the same known digest', async () => {
    expect(await sha256OfBytes('abc')).toBe(ABC_SHA256);
    expect(await sha256OfBytes(new TextEncoder().encode('abc'))).toBe(ABC_SHA256);
  });

  it('hashes empty input to the empty-message digest', async () => {
    expect(await sha256OfBytes('')).toBe(EMPTY_SHA256);
    expect(await sha256OfBytes(new Uint8Array())).toBe(EMPTY_SHA256);
  });

  it('rejects input that is neither a string nor bytes instead of hashing it', async () => {
    await expect(sha256OfBytes(42 as unknown as string)).rejects.toThrow();
  });
});

describe('recalledParsedHash', () => {
  it('is undefined for a file that was never remembered', async () => {
    expect(await recalledParsedHash(project())).toBeUndefined();
  });

  it('hashes remembered bytes on first recall and returns the same hash again', async () => {
    const file = project();
    rememberParsedBytes(file, 'abc');
    expect(await recalledParsedHash(file)).toBe(ABC_SHA256);
    expect(await recalledParsedHash(file)).toBe(ABC_SHA256);
  });

  it('returns a remembered hash as-is, without needing the bytes', async () => {
    const file = project();
    rememberParsedHash(file, 'precomputed-digest');
    expect(await recalledParsedHash(file)).toBe('precomputed-digest');
  });

  it('keys on the object: a spread copy of a parsed file has no entry', async () => {
    const file = project();
    rememberParsedBytes(file, 'abc');
    const copy = { ...file };
    expect(await recalledParsedHash(copy)).toBeUndefined();
    expect(await recalledParsedHash(file)).toBe(ABC_SHA256);
  });

  it('the latest remember wins over an earlier one for the same file', async () => {
    const file = project();
    rememberParsedBytes(file, 'abc');
    rememberParsedHash(file, 'replaced-digest');
    expect(await recalledParsedHash(file)).toBe('replaced-digest');
  });
});

describe('shareParsedHash', () => {
  it('lets the target report the source bytes hash, with one shared entry', async () => {
    const source = project('/repo/.lexicon.yaml');
    const standIn = project('/repo/.lexicon.yaml');
    rememberParsedBytes(source, 'abc');
    shareParsedHash(source, standIn);
    expect(await recalledParsedHash(standIn)).toBe(ABC_SHA256);
    // Hashed once between them: the source now reads the same cached digest.
    expect(await recalledParsedHash(source)).toBe(ABC_SHA256);
  });

  it('is a no-op when the source has nothing remembered', async () => {
    const source = project();
    const target = project();
    shareParsedHash(source, target);
    expect(await recalledParsedHash(target)).toBeUndefined();
  });
});
