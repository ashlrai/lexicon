import { readFile } from 'node:fs/promises';

// Keep dependency fixes in the build, rather than hand editing generated bundles.
// Match exactly once so a dependency upgrade requires reviewing these adaptations.
function replaceOnce(source, pattern, replacement) {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`Bundle adaptation drift: ${pattern}`);
  return source.replace(pattern, replacement);
}

export const hookBundleFixes = {
  name: 'hook-bundle-fixes',
  setup(build) {
    build.onLoad({ filter: /[/\\]zod[/\\]v4[/\\]core[/\\](util|doc|memoizer)\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      if (/[/\\]util\.js$/.test(path)) {
        // A state object makes the reentrant getter's state explicit. Comparing
        // an initially undefined local against a Symbol confuses flow analysis.
        contents = replaceOnce(contents, /let value = undefined;\n    Object.defineProperty/, 'const state = { value: undefined, evaluating: false };\n    Object.defineProperty');
        contents = replaceOnce(contents, /if \(value === EVALUATING\)/, 'if (state.evaluating)');
        contents = replaceOnce(contents, /if \(value === undefined\) \{\n                value = EVALUATING;\n                value = getter\(\);\n            \}\n            return value;/,
          'if (state.value === undefined) {\n                state.evaluating = true;\n                state.value = getter();\n                state.evaluating = false;\n            }\n            return state.value;');
        contents = replaceOnce(contents, /const EVALUATING = .*?;\n/, '');
        // The hook only needs Zod's interpreter. Never probe or generate code.
        contents = replaceOnce(contents, /export const allowsEval = \/\* @__PURE__\*\/ cached\(\(\) => \{[\s\S]*?\n\}\);/,
          'export const allowsEval = /* @__PURE__*/ cached(() => false);');
      } else if (/[/\\]doc\.js$/.test(path)) {
        contents = replaceOnce(contents, /    compile\(\) \{[\s\S]*?\n    \}/,
          '    compile() {\n        throw new Error("Code generation is disabled in the Lexicon hook");\n    }');
      } else {
        contents = replaceOnce(contents, /^            kind;$/m, '');
      }
      return { contents, loader: 'js' };
    });
    build.onLoad({ filter: /[/\\]yaml[/\\]dist[/\\]parse[/\\]lexer\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, 'utf8');
      // Lexing gates on `incomplete`, a parameter no loop iteration writes, so
      // the while reads one unmodified variable before the advancing one; move
      // the gate inside so the condition is the advancing `next` alone.
      contents = replaceOnce(contents,
        /while \(next && \(incomplete \|\| this\.hasChars\(1\)\)\)\n            next = yield\* this\.parseNext\(next\);/,
        'while (next) {\n            if (!incomplete && !this.hasChars(1))\n                break;\n            next = yield* this.parseNext(next);\n        }');
      // Same shape in pushSpaces: `allowTabs` is constant for the call while
      // `ch` advances; the do/while becomes a bounded read with a break.
      contents = replaceOnce(contents,
        /do \{\n            ch = this\.buffer\[\+{2}i\];\n        \} while \(ch === ' ' \|\| \(allowTabs && ch === '\\t'\)\);/,
        'for (;;) {\n            ch = this.buffer[++i];\n            if (ch !== \' \' && (!allowTabs || ch !== \'\\t\'))\n                break;\n        }');
      return { contents, loader: 'js' };
    });
  },
};
