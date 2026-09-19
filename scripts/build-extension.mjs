#!/usr/bin/env node
/**
 * Builds the browser extension (see docs/EXTENSION.md):
 *
 *   extension/dist/core.js         <- extension/src/core.ts (esm; browser-safe core + yaml)
 *   extension/dist/background.js   <- extension/src/background.ts (esm, imports ./core.js)
 *   extension/dist/options.js      <- extension/src/options.ts (esm, imports ./core.js)
 *   extension/dist/content.js      <- extension/src/content.ts (iife; no core needed)
 *   extension/dist/popup.js        <- extension/src/popup.ts (iife)
 *   extension/dist/manifest.json   <- extension/manifest.json with the package version
 *   extension/dist/*.html, ui.css  <- extension/static/
 *   extension/dist/icons/*.png     <- generated here (pure-JS PNG encoder)
 *   extension/dist-firefox/        <- same files, Firefox manifest (background.scripts + gecko id)
 *   extension/lexicon-extension.zip, extension/lexicon-extension-firefox.zip (when `zip` is on PATH)
 *
 * Like the demo site, only browser-safe core modules may be reached from the
 * extension sources; the build fails if a `node:` builtin survives.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'extension/src');
const outdir = resolve(root, 'extension/dist');
const outdirFirefox = resolve(root, 'extension/dist-firefox');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

rmSync(outdir, { recursive: true, force: true });
rmSync(outdirFirefox, { recursive: true, force: true });
mkdirSync(resolve(outdir, 'icons'), { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  loader: { '.yaml': 'text' },
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
};

// 1. The shared core as one ESM chunk.
await build({
  ...common,
  entryPoints: { core: resolve(src, 'core.ts') },
  outdir,
  format: 'esm',
  minify: true,
});

// 2. ESM consumers of core.js (module service worker, options page).
await build({
  ...common,
  entryPoints: { background: resolve(src, 'background.ts'), options: resolve(src, 'options.ts') },
  outdir,
  format: 'esm',
  external: ['./core.js'],
});

// 3. Classic scripts: content script (must be non-module) and popup.
await build({
  ...common,
  entryPoints: { content: resolve(src, 'content.ts'), popup: resolve(src, 'popup.ts') },
  outdir,
  format: 'iife',
});

// Guard: no Node builtins and no accidental core duplication in content.js.
for (const name of ['core.js', 'background.js', 'options.js', 'content.js', 'popup.js']) {
  const code = readFileSync(resolve(outdir, name), 'utf8');
  const nodeBuiltins = code.match(/["']node:[a-z_/]+["']/g);
  if (nodeBuiltins) {
    throw new Error(`${name} imports Node builtins (${[...new Set(nodeBuiltins)].join(', ')}); only import browser-safe core modules`);
  }
  if (/\brequire\(["'](fs|path|os|child_process)["']\)/.test(code)) {
    throw new Error(`${name} requires a Node module; only import browser-safe core modules`);
  }
}
for (const name of ['background.js', 'options.js', 'content.js', 'popup.js']) {
  const code = readFileSync(resolve(outdir, name), 'utf8');
  const usesCore = /from\s*["']\.\/core\.js["']/.test(code);
  if ((name === 'background.js' || name === 'options.js') && !usesCore) {
    throw new Error(`${name} should import ./core.js at runtime (external), but the import was inlined`);
  }
  // The core (zod + yaml + matcher) is ~1 MB unminified; anything else that
  // big has inlined it through a direct src/core import. Go through ./core.js.
  if (code.length > 200 * 1024) {
    throw new Error(`${name} is ${(code.length / 1024).toFixed(0)} KB; it inlined the core instead of importing ./core.js`);
  }
}

// 4. Static files and the manifest with the package version.
for (const name of readdirSync(resolve(root, 'extension/static'))) {
  copyFileSync(resolve(root, 'extension/static', name), resolve(outdir, name));
}
const manifest = JSON.parse(readFileSync(resolve(root, 'extension/manifest.json'), 'utf8'));
manifest.version = pkg.version.replace(/-.*$/, '');
manifest.version_name = pkg.version;
writeFileSync(resolve(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// 5. Icons: a teal rounded square with a white "L", encoded as PNG here so
//    the repo carries no binary assets.
for (const size of [16, 48, 128]) {
  writeFileSync(resolve(outdir, 'icons', `icon-${size}.png`), encodePng(size, size, drawIcon(size)));
}

// 6. Firefox variant: same files, manifest with background.scripts and a gecko id.
mkdirSync(outdirFirefox, { recursive: true });
copyDir(outdir, outdirFirefox);
const ffManifest = {
  ...manifest,
  background: { scripts: ['background.js'], type: 'module' },
  browser_specific_settings: { gecko: { id: 'lexicon@ashlr.ai', strict_min_version: '121.0' } },
};
writeFileSync(resolve(outdirFirefox, 'manifest.json'), JSON.stringify(ffManifest, null, 2) + '\n');

// 7. Zips for "Load unpacked" alternatives and releases.
const zipped = zipDir(outdir, resolve(root, 'extension/lexicon-extension.zip')) &&
  zipDir(outdirFirefox, resolve(root, 'extension/lexicon-extension-firefox.zip'));

// Report.
const files = ['core.js', 'background.js', 'content.js', 'popup.js', 'options.js', 'manifest.json'];
for (const f of files) {
  const kb = (statSync(resolve(outdir, f)).size / 1024).toFixed(1).padStart(7);
  console.log(`${kb} KB  extension/dist/${f}`);
}
console.log(zipped ? 'zipped -> extension/lexicon-extension.zip, extension/lexicon-extension-firefox.zip' : 'zip not on PATH; skipped extension/lexicon-extension.zip');

// ---------------------------------------------------------------------------

function copyDir(from, to) {
  for (const name of readdirSync(from)) {
    const a = join(from, name);
    const b = join(to, name);
    if (statSync(a).isDirectory()) {
      mkdirSync(b, { recursive: true });
      copyDir(a, b);
    } else {
      copyFileSync(a, b);
    }
  }
}

function zipDir(dir, zipPath) {
  const probe = spawnSync('zip', ['-v'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) return false;
  rmSync(zipPath, { force: true });
  const r = spawnSync('zip', ['-qr', '-X', zipPath, '.'], { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`zip failed for ${dir}`);
  return true;
}

/** RGBA pixel buffer for the icon: rounded teal square, white "L" glyph. */
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const radius = size * 0.22;
  const bg = [0x0f, 0x76, 0x6e];
  const stroke = Math.max(1.5, size * 0.11);
  // "L": vertical bar from (x0, y0) to (x0, y1), horizontal from (x0, y1) to (x1, y1).
  const x0 = size * 0.34;
  const y0 = size * 0.27;
  const y1 = size * 0.72;
  const x1 = size * 0.7;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5;
      const cy = y + 0.5;
      const alpha = roundedRectCoverage(cx, cy, size, radius);
      const i = (y * size + x) * 4;
      if (alpha <= 0) continue;
      const inV = cx >= x0 - stroke / 2 && cx <= x0 + stroke / 2 && cy >= y0 && cy <= y1 + stroke / 2;
      const inH = cy >= y1 - stroke / 2 && cy <= y1 + stroke / 2 && cx >= x0 - stroke / 2 && cx <= x1;
      const white = inV || inH;
      px[i] = white ? 255 : bg[0];
      px[i + 1] = white ? 255 : bg[1];
      px[i + 2] = white ? 255 : bg[2];
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/** 1 inside the rounded square, feathered over ~1px at the edge. */
function roundedRectCoverage(cx, cy, size, r) {
  const dx = Math.max(r - cx, 0, cx - (size - r));
  const dy = Math.max(r - cy, 0, cy - (size - r));
  const d = Math.hypot(dx, dy) - r;
  if (d <= -0.5) return 1;
  if (d >= 0.5) return 0;
  return 0.5 - d;
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Table lives on the function so it is hoisted with it (top-level code above
// runs before any module-level const/let would be initialised).
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
