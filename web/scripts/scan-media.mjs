#!/usr/bin/env node
/**
 * Writes `web/lib/generated/media.json`: which product screenshots and
 * recordings actually exist in `web/public/media/`, and their true pixel
 * dimensions.
 *
 * Why a build step rather than `existsSync` in the page:
 *
 *   The page is ISR (`revalidate = 3600`), so anything it checks on the
 *   filesystem is checked again an hour later inside a serverless function,
 *   where `public/` is served by the CDN and is not reliably part of the
 *   function's own bundle. A file that existed at build time would quietly
 *   stop existing at revalidation and every image on the page would vanish.
 *   A generated JSON module is imported, so it is bundled, so it cannot drift.
 *
 * Dimensions are read from the file's own header rather than from a manifest,
 * because a manifest is a second thing to keep in sync and the header is the
 * truth. PNG carries width and height in the IHDR chunk; GIF carries them in
 * the logical screen descriptor. Anything else falls back to the dimensions
 * declared in lib/media.ts, which only set the aspect ratio -- every shot is
 * rendered fluid-width, so a wrong guess costs layout, never a broken image.
 *
 * The directory is allowed not to exist. The page falls back to its drawn
 * animations, and this writes `{}`.
 */
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mediaDir = resolve(web, 'public/media');
const outfile = resolve(web, 'lib/generated/media.json');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Intrinsic pixel size from the file header, or null when we cannot tell. */
function dimensions(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const head = Buffer.alloc(32);
    const read = readSync(fd, head, 0, 32, 0);
    if (read < 24) return null;

    if (head.subarray(0, 8).equals(PNG_SIG)) {
      // 8 byte signature, 4 byte chunk length, 4 byte "IHDR", then w and h.
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
    }
    const sig = head.subarray(0, 6).toString('latin1');
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return { width: head.readUInt16LE(6), height: head.readUInt16LE(8) };
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const entries = {};

if (existsSync(mediaDir)) {
  const names = await readdir(mediaDir);
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const file = resolve(mediaDir, name);
    const size = dimensions(file);
    // An mp4 has no header we parse; recording it as present is the whole point,
    // since the <video> is sized by its sibling still.
    entries[name] = size ?? { width: 0, height: 0 };
    const label = size ? `${size.width}x${size.height}` : extname(name).slice(1) || 'file';
    console.log(`scan-media: ${name} (${label})`);
  }
}

mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, `${JSON.stringify(entries, null, 2)}\n`);

const n = Object.keys(entries).length;
console.log(
  n === 0
    ? 'scan-media: no files in public/media; the page will use its drawn fallbacks'
    : `scan-media: ${n} file(s) available to the page`,
);
