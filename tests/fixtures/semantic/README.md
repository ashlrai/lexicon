# Local embedding fixture

`cases.json` labels 28 dictated-name spellings and 12 hard negatives against
18 product names. These are hand-authored spelling fixtures, not audio samples
or a held-out population estimate. The thresholds were set before measuring:
cosine >= 0.85, runner-up margin >= 0.05, spelling similarity >= 0.5.

`bge-m3.json` contains actual embeddings recorded from a locally installed
`bge-m3:latest` through Ollama on literal loopback. Its provenance includes the
model digest and recording time. Vectors are normalized and rounded to seven
decimal places. The tests replay them through a real loopback HTTP server;
CI needs neither Ollama nor a downloaded model and makes no external requests.
Small synthetic vectors in the transport tests exercise malformed responses,
thresholds and ambiguity separately from this real-model measurement.

Measured at the default thresholds:

| Matcher | TP | FP | FN | Precision | Recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing matcher | 22 | 0 | 6 | 100% | 78.57% |
| Existing + local fallback | 23 | 0 | 5 | 100% | 82.14% |
| Fallback alone, on the six baseline misses | 1 | 0 | 5 | 100% | 16.67% |

All 12 negatives abstain. The recovered spelling is `Kubernetics` ->
`Kubernetes` (cosine approximately 0.92947). This is **one** additional true
positive, so 100% fixture precision is weak statistical evidence. It does not
establish production precision, audio recognition accuracy or quality for
other models. Five baseline misses still abstain. No threshold was lowered to
make them match. Tests pin the counts so regressions remain visible.

Run the measurement and safety tests:

```sh
HOME=$(mktemp -d) npm test -- tests/semantic-match.test.ts
```

To explicitly refresh the recording, first install the model yourself and run
an Ollama server at `127.0.0.1:11434`. This script does not download or start
anything, does not read environment configuration, and releases the model
after inference. Review changed vectors, provenance and precision counts:

```sh
HOME=$(mktemp -d) node --import tsx tests/fixtures/semantic/record.ts
HOME=$(mktemp -d) npm test -- tests/semantic-match.test.ts
```
