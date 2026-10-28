import assert from 'node:assert/strict';
import { decodeImportBytes, importLexicon, type ImportFormat } from '../../src/core/importers/index.js';

const seeds: Record<ImportFormat, string> = {
  wispr: 'word,replacement\nashler,Ashlr.AI\n',
  csv: 'canonical,alias\nAshlr.AI,ashler\n',
  superwhisper: '[{"original":"ashler","replacement":"Ashlr.AI"}]',
  macos: '<plist><array><dict><key>phrase</key><string>Ashlr.AI</string><key>shortcut</key><string>ashler</string></dict></array></plist>',
  espanso: 'matches:\n  - trigger: ":ashler"\n    replace: Ashlr.AI\n',
  markdown: '| Canonical | Aliases |\n| --- | --- |\n| Ashlr.AI | ashler |\n',
  text: 'Ashlr.AI: ashler\n',
  json: '{"version":1,"terms":[{"canonical":"Ashlr.AI","aliases":["ashler"]}]}',
  auto: 'word,replacement\nashler,Ashlr.AI\n',
};
const format = process.argv[2] as ImportFormat;
assert.ok(Object.hasOwn(seeds, format));
const scenario = process.argv[3] ?? 'corpus';
let accepted = 0;
let refused = 0;
function exercise(content: string): void {
  let result;
  try {
    result = importLexicon(content, format);
  } catch (error) {
    // Descriptive parser/schema refusals are part of the API. Programming
    // errors and stack overflows must escape this catch and fail the child.
    const label = `${format} case ${accepted + refused}: ${JSON.stringify(content.slice(0, 100))}`;
    assert.ok(error instanceof Error, label);
    assert.ok(!(error instanceof TypeError || error instanceof RangeError || error instanceof ReferenceError), `${label}: ${error.message}`);
    assert.ok(error.message.length > 0);
    refused++;
    return;
  }
  accepted++;
  assert.notEqual(result.format, 'auto');
  const canonicals = new Set<string>();
  for (const term of result.terms) {
    assert.ok(term.canonical.length > 0);
    assert.equal(term.canonical, term.canonical.trim());
    const key = term.canonical.toLowerCase();
    assert.ok(!canonicals.has(key));
    canonicals.add(key);
    const aliases = term.aliases.map((alias) => alias.toLowerCase());
    assert.equal(new Set(aliases).size, aliases.length);
    assert.ok(!aliases.includes(key));
    assert.ok(term.aliases.every((alias) => alias.length > 0 && alias === alias.trim()));
  }
  for (const skip of result.skipped) {
    assert.ok(Number.isInteger(skip.line) && skip.line > 0);
    assert.ok(skip.reason.length > 0);
  }
}

const seed = seeds[format];
assert.equal(importLexicon(seed, format).terms[0]?.canonical, 'Ashlr.AI');
// Real byte decoding, including non-zero-offset views and both byte orders.
for (const encoding of ['utf8', 'utf16le', 'utf16be'] as const) {
  const bytes = encoding === 'utf8' ? Buffer.from(seed) : Buffer.from('\uFEFF' + seed, 'utf16le');
  if (encoding === 'utf16be') bytes.swap16();
  const padded = Buffer.concat([Buffer.from([255]), bytes, Buffer.from([255])]);
  const decoded = decodeImportBytes(padded.subarray(1, -1));
  assert.equal(importLexicon(decoded.text, format).terms[0]?.canonical, 'Ashlr.AI');
}

if (scenario === 'corpus') {
  const fragments = ['\0', '\uFFFD', '\uFEFF', '\ud800', '\udfff', 'é中🙂', '\r\n', '"', '\\', '<dict>', '&#99999999;', '[', '{', '*a', ':', '|'];
  for (const input of ['', ' ', 'null', '[]', '{}', 'true', '42', ...fragments]) exercise(input);
  // Fixed PRNG and bounded edits make every failure reproducible by format/index.
  let state = 0x1badb002;
  for (let i = 0; i < 96; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const at = state % (seed.length + 1);
    const fragment = fragments[i % fragments.length];
    exercise(seed.slice(0, at));
    exercise(seed.slice(0, at) + fragment + seed.slice(at + (i % 7)));
  }
  for (const bytes of [
    Buffer.from([0xc3, 0x28]),
    Buffer.from([0xff, 0xfe, 0x41]),
    Buffer.concat([Buffer.from(seed), Buffer.from([0xff, 0xfe, 0xe9])]),
  ]) {
    let decoded;
    try {
      decoded = decodeImportBytes(bytes);
    } catch (error) {
      assert.ok(error instanceof Error && !(error instanceof TypeError || error instanceof RangeError));
      refused++;
      continue;
    }
    exercise(decoded.text);
  }
} else {
  // Each large input gets its own process deadline, rather than charging
  // eight independent scans against one aggregate wall-clock budget.
  const fragments = ['x', '<dict>', '<key>', '"', '\\|', 'a,', '(', '['];
  if (scenario === 'duplicates') exercise(seed.repeat(2000));
  else {
    const fragment = fragments[Number(scenario)];
    assert.ok(fragment);
    exercise(fragment.repeat(Math.ceil(1_048_576 / fragment.length)));
  }
}
assert.ok(accepted + refused > 0);
process.stdout.write(JSON.stringify({ accepted, refused }));
