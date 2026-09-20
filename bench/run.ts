/**
 * Accuracy benchmark CLI.
 *
 *   npm run bench                         default config, markdown to stdout, bench/results.json
 *   npm run bench -- --verbose            also print every failing case
 *   npm run bench -- --filter person      one category
 *   npm run bench -- --min-confidence 0.9 --no-phonetic --no-fuzzy
 *   npm run bench -- --sweep              minConfidence 0.70..0.95 vs accuracy / false positives
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATEGORIES,
  DEFAULT_CORPUS,
  DEFAULT_LEXICON,
  loadCorpus,
  loadLexicon,
  runBench,
  sweep,
  type BenchCategory,
  type BenchOptions,
  type BenchReport,
  type CaseResult,
  type SweepRow,
} from './lib.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Args {
  filter?: BenchCategory;
  verbose: boolean;
  minConfidence?: number;
  phonetic?: boolean;
  fuzzy?: boolean;
  sweep: boolean;
  out: string;
  corpus: string;
  lexicon: string;
  json: boolean;
}

function usage(): never {
  console.error(`usage: node --import tsx bench/run.ts [options]
  --filter <brand|product|acronym|person|identifier|prose>
  --verbose               print every failing case with a diff
  --min-confidence <n>    override lexicon/default minConfidence (0..1)
  --no-phonetic           disable the phonetic pass
  --no-fuzzy              disable the fuzzy pass
  --sweep                 run minConfidence 0.70..0.95 and print accuracy vs false-positive rate
  --out <file>            where to write results.json (default bench/results.json)
  --corpus <file>         corpus path (default bench/corpus.jsonl)
  --lexicon <file>        lexicon path (default bench/lexicon.yaml)
  --json                  print the report as JSON instead of markdown`);
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    verbose: false,
    sweep: false,
    out: join(HERE, 'results.json'),
    corpus: DEFAULT_CORPUS,
    lexicon: DEFAULT_LEXICON,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (a) {
      case '--filter': {
        const v = next() as BenchCategory;
        if (!CATEGORIES.includes(v)) usage();
        args.filter = v;
        break;
      }
      case '--verbose':
      case '-v':
        args.verbose = true;
        break;
      case '--min-confidence': {
        const n = Number(next());
        if (!Number.isFinite(n) || n < 0 || n > 1) usage();
        args.minConfidence = n;
        break;
      }
      case '--no-phonetic':
        args.phonetic = false;
        break;
      case '--no-fuzzy':
        args.fuzzy = false;
        break;
      case '--sweep':
        args.sweep = true;
        break;
      case '--out':
        args.out = next();
        break;
      case '--corpus':
        args.corpus = next();
        break;
      case '--lexicon':
        args.lexicon = next();
        break;
      case '--json':
        args.json = true;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`unknown option: ${a}`);
        usage();
    }
  }
  return args;
}

// ---------------------------------------------------------------------------

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const frac = (r: { hit: number; total: number; rate: number }): string => `${pct(r.rate)} (${r.hit}/${r.total})`;

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function describeConfig(r: BenchReport): string {
  const parts = [
    `minConfidence=${r.config.minConfidence.toFixed(2)}`,
    `phonetic=${r.config.phonetic ? 'on' : 'off'}`,
    `fuzzy=${r.config.fuzzy ? 'on' : 'off'}`,
  ];
  if (r.config.filter) parts.push(`filter=${r.config.filter}`);
  return parts.join(', ');
}

function renderReport(r: BenchReport): string {
  const out: string[] = [];
  out.push(`## Headline (${describeConfig(r)})`, '');
  out.push(
    table(
      ['metric', 'value'],
      [
        ['cases', `${r.counts.cases} (${r.counts.positives} positive, ${r.counts.negatives} negative; ${r.counts.hard} marked expected-hard)`],
        ['sentence accuracy, all cases', frac(r.sentence.all)],
        ['sentence accuracy, positives', frac(r.sentence.positives)],
        ['sentence accuracy, positives excl. expected-hard', frac(r.sentence.positivesExcludingHard)],
        ['prose false-positive rate (negatives changed)', frac(r.falsePositiveRate)],
        ['prose false-positive rate excl. expected-hard', frac(r.falsePositiveRateExcludingHard)],
        ['term recall, raw STT (before)', frac(r.terms.rawRecall)],
        ['term recall, after lexicon', frac(r.terms.recall)],
        ['term precision', frac(r.terms.precision)],
        ['term F1', pct(r.terms.f1)],
        ...(r.latency
          ? [
              ['mean latency per case, normalize() incl. buildIndex (warm)', `${r.latency.normalizeUs.toFixed(0)} us`],
              ['mean latency per case, findReplacements() prebuilt index (warm)', `${r.latency.findReplacementsUs.toFixed(0)} us`],
            ]
          : []),
      ],
    ),
  );
  out.push('', '## By category', '');
  out.push(
    table(
      ['category', 'cases', 'sentence accuracy', 'term recall raw', 'term recall after'],
      CATEGORIES.filter((c) => r.sentence.byCategory[c]).map((c) => {
        const s = r.sentence.byCategory[c];
        const t = r.terms.byCategory[c];
        return [c, String(s.total), frac(s), t ? frac(t.rawRecall) : '-', t ? frac(t.recall) : '-'];
      }),
    ),
  );
  out.push('', '## By reason', '');
  out.push(
    table(
      ['reason', 'replacements', 'correct (canonical expected)', 'wrong (spurious)', 'mean confidence'],
      (['alias', 'phonetic', 'fuzzy'] as const).map((reason) => {
        const s = r.byReason[reason];
        return [reason, String(s.replacements), String(s.correct), String(s.wrong), s.replacements ? s.meanConfidence.toFixed(3) : '-'];
      }),
    ),
  );
  return out.join('\n');
}

function renderFailures(results: CaseResult[]): string {
  const failing = results.filter((x) => !x.pass);
  const out: string[] = ['', `## Failing cases (${failing.length})`, ''];
  for (const f of failing) {
    out.push(`### ${f.id} [${f.category}${f.hard ? ', expected-hard' : ''}${f.negative ? ', negative' : ''}]`);
    out.push(`- heard:    ${JSON.stringify(f.heard)}`);
    out.push(`- expected: ${JSON.stringify(f.expected)}`);
    out.push(`- output:   ${JSON.stringify(f.output)}`);
    if (f.missed.length) out.push(`- missed: ${f.missed.join(', ')}`);
    if (f.replacements.length) {
      out.push(
        `- replacements: ${f.replacements
          .map((x) => `"${x.original}" -> "${x.replacement}" (${x.reason}, ${x.confidence.toFixed(2)})`)
          .join('; ')}`,
      );
    }
    out.push('');
  }
  return out.join('\n');
}

function renderSweep(rows: SweepRow[]): string {
  return [
    '## Sweep: minConfidence vs accuracy and false positives',
    '',
    table(
      ['minConfidence', 'positive acc', 'positive acc excl. hard', 'term recall', 'term precision', 'term F1', 'prose FP rate', 'prose FP excl. hard'],
      rows.map((s) => [
        s.minConfidence.toFixed(2),
        pct(s.positiveAccuracy),
        pct(s.positiveAccuracyExcludingHard),
        pct(s.termRecall),
        pct(s.termPrecision),
        pct(s.f1),
        pct(s.falsePositiveRate),
        pct(s.falsePositiveRateExcludingHard),
      ]),
    ),
  ].join('\n');
}

// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const lexicon = loadLexicon(args.lexicon);
  const cases = loadCorpus(args.corpus);

  const opts: BenchOptions = {};
  if (args.filter) opts.filter = args.filter;
  if (args.minConfidence !== undefined) opts.minConfidence = args.minConfidence;
  if (args.phonetic !== undefined) opts.phonetic = args.phonetic;
  if (args.fuzzy !== undefined) opts.fuzzy = args.fuzzy;

  const report = runBench(cases, lexicon, opts);
  const { results, ...summary } = report;
  const sweepRows = args.sweep ? sweep(cases, lexicon, opts) : undefined;

  if (args.json) {
    console.log(JSON.stringify({ ...summary, sweep: sweepRows, failures: results.filter((r) => !r.pass) }, null, 2));
  } else {
    console.log(renderReport(report));
    if (sweepRows) console.log('\n' + renderSweep(sweepRows));
    if (args.verbose) console.log('\n' + renderFailures(results));
    else {
      const failing = results.filter((r) => !r.pass).length;
      console.log(`\n${failing} failing case(s); rerun with --verbose to list them.`);
    }
  }

  // Relative, not resolved: results.json is committed on every matcher change, and an
  // absolute path would publish the committer's home directory to a public repo.
  const repoRoot = join(HERE, '..');
  const payload = {
    generatedAt: new Date().toISOString(),
    lexicon: relative(repoRoot, args.lexicon),
    corpus: relative(repoRoot, args.corpus),
    ...summary,
    ...(sweepRows ? { sweep: sweepRows } : {}),
    failures: results.filter((r) => !r.pass),
  };
  writeFileSync(args.out, JSON.stringify(payload, null, 2) + '\n');
  console.error(`wrote ${args.out}`);
}

main();
