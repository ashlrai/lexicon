/**
 * What encoding an import file is in, decided from its bytes before a single
 * term is parsed.
 *
 * `lexicon import` used to read every file as UTF-8. Two of the encodings a
 * Windows user produces without meaning to are not UTF-8: PowerShell's
 * `Out-File` and Notepad's "Unicode" option write UTF-16LE, and an older
 * editor writes Latin-1 or Windows-1252. Reading either as UTF-8 is lossy:
 * every byte that is not valid UTF-8 becomes U+FFFD, so "Café" arrives as
 * "Caf�" and a tool whose entire job is spelling silently records the
 * wrong spelling. Storing a replacement character is the worst outcome
 * available here, so it is the one outcome this module makes impossible.
 *
 * UTF-16 is unambiguous (a byte-order mark, or a NUL in every other byte), so
 * it is decoded rather than refused. An 8-bit encoding is not: Latin-1,
 * Windows-1252 and KOI8-R are the same bytes meaning different letters, and
 * guessing would trade a visible error for a silent wrong answer. Those are
 * refused by name, with the command that converts them.
 *
 * Pure: bytes in, string out. No IO, no env, no logging.
 */

/** Encodings `lexicon import` reads. A UTF-8 BOM decodes as UTF-8 and is left to the parsers, which already strip it. */
export type ImportEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** Encodings `lexicon import` refuses, each with its own explanation. */
export type UnsupportedImportEncoding = 'utf-32le' | 'utf-32be' | 'not-utf-8' | 'not-text';

export interface DecodedImport {
  text: string;
  encoding: ImportEncoding;
}

/** Where the bytes came from, for the error message. */
export interface ImportSource {
  /** Path of the file being imported, when there is one. Used in the conversion commands. */
  path?: string;
  /** How to name the input in an error message. Defaults to `path`, else "the input". */
  label?: string;
}

/** U+FFFD, what a lossy UTF-8 decode leaves behind. Exported so callers can say the same thing. */
export const REPLACEMENT_CHAR = '�';

/** How many bytes the UTF-16 guess looks at. A dictionary export is homogeneous; the first page is representative. */
const SAMPLE_BYTES = 4096;

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((b, i) => bytes[i] === b);
}

/**
 * UTF-16 without a BOM, which is what a file gets when it is concatenated or
 * re-saved: in mostly-ASCII text every other byte is NUL, on the high side for
 * little-endian and the low side for big-endian. Half the pairs having a NUL
 * in the same position is far past anything real UTF-8 produces (UTF-8 text
 * has no NUL at all).
 */
function looksLikeUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | undefined {
  const limit = Math.min(bytes.length, SAMPLE_BYTES) & ~1;
  if (limit < 2) return undefined;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < limit; i += 2) {
    if (bytes[i] === 0) evenNul++;
    if (bytes[i + 1] === 0) oddNul++;
  }
  const threshold = Math.max(1, Math.floor(limit / 2 / 2));
  if (oddNul > evenNul && oddNul >= threshold) return 'utf-16le';
  if (evenNul > oddNul && evenNul >= threshold) return 'utf-16be';
  return undefined;
}

/**
 * True when every byte is a valid UTF-8 sequence. Decoding and re-encoding is
 * the check: Node replaces each invalid byte with U+FFFD, which re-encodes to
 * three different bytes, so a round trip that differs is exactly a round trip
 * that lost something. A file that genuinely contains U+FFFD round-trips and
 * is accepted, which is correct: those bytes were the author's choice.
 */
function isUtf8(bytes: Uint8Array): boolean {
  const buf = toBuffer(bytes);
  return Buffer.compare(Buffer.from(buf.toString('utf8'), 'utf8'), buf) === 0;
}

export function detectImportEncoding(bytes: Uint8Array): ImportEncoding | UnsupportedImportEncoding {
  // UTF-32LE starts with the UTF-16LE mark, so it has to be ruled out first.
  if (startsWith(bytes, [0xff, 0xfe, 0x00, 0x00])) return 'utf-32le';
  if (startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])) return 'utf-32be';
  if (startsWith(bytes, [0xff, 0xfe])) return 'utf-16le';
  if (startsWith(bytes, [0xfe, 0xff])) return 'utf-16be';
  const guess = looksLikeUtf16(bytes);
  if (guess) return guess;
  // A NUL is valid UTF-8 (U+0000) but never valid in a dictionary: it would
  // survive decoding and die later against the schema's control-character
  // rule, naming the destination file instead of this one.
  if (bytes.includes(0)) return 'not-text';
  return isUtf8(bytes) ? 'utf-8' : 'not-utf-8';
}

function sourceName(source: ImportSource): string {
  return source.label ?? source.path ?? 'the input';
}

/** The conversion recipe, or the stdin equivalent when there is no file to name. */
function howToConvert(source: ImportSource, from: string): string {
  const p = source.path;
  if (p === undefined) {
    return `Convert it to UTF-8 before piping it in, for example with \`iconv -f ${from} -t UTF-8\`.`;
  }
  return [
    'Convert it to UTF-8 first and import the converted file:',
    `  iconv -f ${from} -t UTF-8 "${p}" > "${p}.utf8.txt"`,
    `  PowerShell: Get-Content -Raw "${p}" | Set-Content -Encoding utf8 "${p}.utf8.txt"`,
  ].join('\n');
}

/**
 * The refusal. It names the input file, because the file the user chose is the
 * one they can act on: the old failure surfaced from the schema and named the
 * destination lexicon, blaming a file they never touched.
 */
export function importEncodingError(source: ImportSource, encoding: UnsupportedImportEncoding): Error {
  const name = sourceName(source);
  switch (encoding) {
    case 'utf-32le':
    case 'utf-32be':
      return new Error(`${name} is UTF-32 text, which lexicon does not read.\n${howToConvert(source, 'UTF-32')}`);
    case 'not-text':
      return new Error(
        `${name} contains NUL bytes, so it is not a text file lexicon can import. ` +
          'If it is a Unicode export, save it as UTF-8 and import that.',
      );
    default:
      return new Error(
        `${name} is not UTF-8 text, most likely Latin-1 or Windows-1252, and lexicon will not guess which. ` +
          `Importing it as UTF-8 would store the wrong spelling: an accented letter such as é becomes "${REPLACEMENT_CHAR}".\n` +
          howToConvert(source, 'WINDOWS-1252'),
      );
  }
}

/**
 * Decode an import file. UTF-8 (with or without a BOM) and UTF-16 (either
 * endianness, with or without a BOM) come back as text; anything else throws
 * the message above. Never returns a string that a lossy decode invented.
 */
export function decodeImportBytes(bytes: Uint8Array, source: ImportSource = {}): DecodedImport {
  const encoding = detectImportEncoding(bytes);
  const buf = toBuffer(bytes);
  switch (encoding) {
    case 'utf-8':
      // Byte-identical to what readFile(path, 'utf8') used to return, BOM and all.
      return { text: buf.toString('utf8'), encoding };
    case 'utf-16le':
    case 'utf-16be': {
      // A trailing half code unit cannot be decoded either way; dropping it
      // loses nothing a parser could have used.
      const even = buf.subarray(0, buf.length & ~1);
      const le = encoding === 'utf-16le' ? even : Buffer.from(even).swap16();
      return { text: le.toString('utf16le').replace(/^﻿/, ''), encoding };
    }
    default:
      throw importEncodingError(source, encoding);
  }
}
