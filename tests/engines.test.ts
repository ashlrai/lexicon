import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// package.json promises `engines.node`. A runtime dependency whose own floor is
// higher breaks that promise: npm prints EBADENGINE on every `npx
// @ashlr/lexicon` and refuses the install outright under engine-strict. This
// happened with commander 15 (node >=22.12) against our >=20.

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  engines: { node: string };
  dependencies: Record<string, string>;
};

/** Lowest version a simple `>=x.y.z` range admits, as [major, minor, patch]. */
function floor(range: string): [number, number, number] | undefined {
  const m = /^\s*>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(range);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

describe('engines.node', () => {
  const ours = floor(pkg.engines.node);

  it('is a plain >= floor this test can compare against', () => {
    expect(ours).toBeDefined();
  });

  for (const dep of Object.keys(pkg.dependencies)) {
    it(`${dep} runs on the Node versions package.json promises`, () => {
      const depPkg = JSON.parse(readFileSync(path.join(root, 'node_modules', dep, 'package.json'), 'utf8')) as {
        engines?: { node?: string };
      };
      const range = depPkg.engines?.node;
      if (!range) return; // no stated floor
      const theirs = floor(range);
      // A range this test cannot read (`^18 || >=20`) is left to a human.
      if (!theirs || !ours) return;
      expect(
        cmp(theirs, ours) <= 0,
        `${dep} requires node ${range}, but package.json engines.node is ${pkg.engines.node}`,
      ).toBe(true);
    });
  }
});
