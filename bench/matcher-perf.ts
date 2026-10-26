// Run with: node --import tsx bench/matcher-perf.ts
import { performance } from 'node:perf_hooks';
import { buildIndex } from '../src/core/matcher/build.js';
import { tokenize } from '../src/core/matcher/tokenize.js';
import { alphaOnly, collapse, foldLower, squash } from '../src/core/matcher/text.js';
import type { Lexicon } from '../src/core/types.js';

const vocabulary: Lexicon = {
  version: 1,
  terms: Array.from({ length: 5_000 }, (_, i) => ({
    canonical: `Widgetron${i}.AI`,
    aliases: [`widget tron ${i}`, `wigetron${i}`, `Wídget${i}`],
  })),
};
const transcript = "Widget tron's Wídget42 ships to https://example.com/widget beside `wigetron7`.\n".repeat(2_000);
const words = vocabulary.terms.flatMap((term) => [term.canonical, ...term.aliases]);
for (const [name, run] of [
  ['buildIndex (5000 terms)', () => buildIndex(vocabulary)],
  ['tokenize (158KB, protected ranges)', () => tokenize(transcript, true)],
  ['text shaping (20000 aliases)', () => { for (const word of words) { foldLower(word); alphaOnly(word); collapse(word); squash(word); } }],
] as const) {
  run(); // warm-up
  const cpuSamples: number[] = [];
  const samples = Array.from({ length: 5 }, () => {
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    run();
    const elapsed = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    cpuSamples.push((cpu.user + cpu.system) / 1_000);
    return elapsed;
  }).sort((a, b) => a - b);
  cpuSamples.sort((a, b) => a - b);
  console.log(`${name}: median ${samples[2].toFixed(2)} ms (min ${samples[0].toFixed(2)} ms), CPU median ${cpuSamples[2].toFixed(2)} ms`);
}
