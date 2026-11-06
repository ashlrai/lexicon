import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testsDir = fileURLToPath(new URL('.', import.meta.url));
const bidiControls = /[\u202a-\u202e\u2066-\u2069]/g;

function findControls(content: string): { line: number; codePoint: string }[] {
  return content.split('\n').flatMap((line, index) =>
    Array.from(line.matchAll(bidiControls), (match) => ({
      line: index + 1,
      codePoint: `U+${match[0].codePointAt(0)!.toString(16).toUpperCase()}`,
    })),
  );
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(filename);
    return entry.isFile() ? [filename] : [];
  });
}

describe('literal bidi control guard', () => {
  it('detects every prohibited code point and allows escaped text', () => {
    const controls = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
    expect(findControls(`safe\\u202e\n${String.fromCodePoint(...controls)}`)).toEqual(
      controls.map((codePoint) => ({ line: 2, codePoint: `U+${codePoint.toString(16).toUpperCase()}` })),
    );
    expect(findControls(String.fromCodePoint(0x2029, 0x202f, 0x2065, 0x206a))).toEqual([]);
  });

  it('contains no literal bidi controls anywhere in tests', () => {
    const findings = filesIn(testsDir).flatMap((filename) =>
      findControls(readFileSync(filename, 'utf8')).map(({ line, codePoint }) =>
        `${path.relative(testsDir, filename)}:${line}: ${codePoint}`,
      ),
    );
    expect(findings).toEqual([]);
  });
});
