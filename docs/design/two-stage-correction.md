# Two-stage correction

Status: design, partially implemented. The stage-2 deterministic and ensemble
machinery landed with the Pellucid acquisition (`src/ambiguity/`); the
stage-1 producer and the model detector are the sibling work items
RQ-LEX-CONTEXT-NORMALIZE and RQ-LEX-STAGE2-LOCALMODEL.

## Why two stages

Stage 1 is the matcher lexicon has today: deterministic glossary and phonetic
rewrites over the user's own terms. It is fast (~200 ms budget in the prompt
hook), local, and precise about one thing - which word the user meant.

It is blind to a second class of problem a dictated prompt carries: the
sentence itself is ambiguous. "Deploy it to production", "make it fast", "use
and/or": each is individually a fine word, and the transcript is still wrong
in a way a glossary cannot fix - the meaning is under-specified. That is the
problem Pellucid was built to score.

Stage 2 takes stage 1's corrected text and scores it for ambiguity using the
engine ported from Pellucid: an INCOSE-derived rule layer, ensemble
aggregation over detector reports, and isotonic confidence calibration. A
small local model can join as one more detector through the same report
contract.

The stages share one candidate shape and one confidence path, so a surface
(prompt hook, expander, review UI) sees a single merged list instead of two
pipelines.

## Stage 1: deterministic glossary + phonetic

`src/core/matcher.ts` tokenizes the input, slides token windows over it and
tries three passes per window in priority order:

1. exact alias match (confidence 1, or `INVENTED_BOUNDARY_CONFIDENCE` 0.95
   when the text invents a word break the term lacks),
2. double-metaphone phonetic,
3. edit-distance fuzzy.

`Replacement { start, end, original, replacement, canonical, reason,
confidence }` is today's emitted shape. Stage 1 maps into the shared
candidate shape by field rename (`original` -> `text`, `reason` -> `source`),
no semantic change. `skipCode` ranges stay authoritative: stage 2 detectors
never see code spans, URLs or emails either - a pronoun inside a fence is not
prose.

Output of stage 1 is both the rewritten text and the candidate list; stage 2
runs on the rewritten text and is told which spans were already corrected so
it does not re-litigate them (the exclusion list Pellucid passed to its
agents is the same idea).

## Stage 2: ambiguity scoring + small local model

`src/ambiguity/` is the Pellucid port, adapted to the core's rules: pure
functions, no IO, ESM/NodeNext, no `any` in exported signatures.

| Module | Ported from | What it does |
|---|---|---|
| `terms.ts` | `detectors/rules.py` | INCOSE vague-term lexicon, verbatim data |
| `rules.ts` | `detectors/rules.py` | Boundary-aware term matching |
| `syntax.ts` | `detectors/spacy_rules.py` | Passive voice, dangling pronouns - POS-free port (see below) |
| `resolve.ts` | `agents/base.py` | `cleanLiteral` + `resolveSpan`: trust the model's text, never its offsets |
| `parse.ts` | `agents/base.py` | `_parse_report`: raw model JSON -> `DetectorReport` |
| `calibrate.ts` | `agents/calibration.py` | PAV isotonic calibrator, synthetic-prior default, `.fit()` for a real corpus |
| `aggregate.ts` | `agents/aggregator.py` | Overlap clustering, canonical pick, calibrated ensemble confidence |
| `index.ts` | `detectors/pipeline.py` | `runRuleLayer` + `dedupeFindings` |

The POS-free adaptation needs one paragraph, because it is the only place the
port is not line-for-line. spaCy cannot run in a dependency-free TypeScript
core, so `syntax.ts` approximates it: regex sentence boundaries, a be/get +
participle pattern with a small adjective exclusion list for passive voice,
and a nominal-antecedent estimate built from determiners, noun morphology, a
requirements-domain glossary and verb-position lookbehind. Findings keep the
same types, severities and confidences; on Pellucid's own sample document the
term layer is identical and the passive layer is equal or stricter (regex
sentences do not merge markdown headers into 200-char spans the way spaCy
sentences did).

`runRuleLayer` is deterministic and needs no model. It is stage 2's floor:
every surface can score a transcript today.

### Where the model fits

Pellucid ran four LLM agents plus a critique round under LangGraph. The port
keeps the *contract* (`DetectorReport`, `FindingVote`, the aggregator and
calibrator that consume them) and the *parser* that made model output safe
(`parseDetectorReport`, built on `resolveSpan`: the model's verbatim text is
trusted, its character offsets are not, and a finding whose span cannot be
resolved unambiguously is dropped rather than mis-anchored).

What it deliberately does not port: the LangGraph graph, LiteLLM plumbing,
asyncio orchestration, the FastAPI/web/database layers. A stage-2 model in
lexicon is a local, offline scorer (RQ-LEX-STAGE2-LOCALMODEL) that emits the
same `DetectorReport` JSON `parseDetectorReport` consumes - the wiring is a
small runner, not a framework.

## The shared contract

Both stages speak `CorrectionCandidate` (`src/ambiguity/types.ts`), defined
so RQ-LEX-CONTEXT-NORMALIZE and RQ-LEX-STAGE2-LOCALMODEL consume one shape:

```ts
interface CorrectionCandidate {
  start: number;          // char offset into the input
  end: number;
  text: string;           // verbatim slice of the input
  replacement?: string;   // absent = flag-only finding, no rewrite
  confidence: number;     // 0..1, pre-ensemble
  source: string;         // 'glossary' | 'phonetic' | 'rules' | 'model' | ...
  rationale?: string;
}
```

Producer tags by stage:

- Stage 1 emits `glossary` (alias) and `phonetic`/`fuzzy` candidates with
  replacements set.
- Stage 2 detectors emit `rules` (deterministic layer) and `model` (local
  model) candidates, usually flag-only.

Confidence is ensemble, not additive. `AmbiguityFinding` and
`DetectorReport` feed `aggregateFindings`, which clusters overlapping spans,
takes max severity, and scores each cluster through the isotonic
`ConfidenceCalibrator` on these signals (`CalibrationInput`): canonical base
confidence, count of additional agreeing sources, AGREE/DISAGREE vote counts,
rule-layer corroboration. Output is clamped to [0.05, 0.99] and strictly
monotone in every signal - one more agreeing source can only raise
confidence, one more dispute can only lower it.

Cross-stage merge rule: a `glossary`/`phonetic` candidate and an ambiguity
finding on the same span are both evidence. The candidate's replacement wins
the rewrite; the ambiguity finding attaches as rationale and a corroboration
signal into the calibrator (stage 1 source counts as the rule layer - it is
the deterministic baseline exactly as Pellucid's `rules` were).

## Pipeline

```
transcript
   |
   v
[stage 1] findReplacements  ->  corrected text + CorrectionCandidate[]  (glossary/phonetic)
   |
   v
[stage 2a] runRuleLayer     ->  AmbiguityFinding[]  (INCOSE + syntax, deterministic)
[stage 2b] model detector   ->  DetectorReport      (parseDetectorReport over model JSON)
   |
   v
aggregateFindings(ruleFindings, reports, votes)
   |
   v
merged candidate list: calibrated confidence, max severity, ensemble source
```

## Non-goals

- No rewrite generation yet. Pellucid's "Forge Clarity" produced candidate
  rewrites from an LLM; lexicon's stage-2 model may propose `suggestion`
  text, but nothing applies an ambiguity rewrite automatically.
- No remote model calls. Stage 2b is local-only by design; BYOK/provider
  plumbing was not ported.
- No critique round required. `FindingVote` exists so a future multi-detector
  setup can vote, but a single model detector plus the rule layer already
  produces calibrated output.
