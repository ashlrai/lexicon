# Real-audio benchmark results

Generated 2026-09-20T19:42:45.128Z by `npm run bench:audio`. Pipeline: macOS `say` (voices Samantha, Daniel, Karen) -> 16 kHz mono WAV -> whisper.cpp (`/opt/homebrew/bin/whisper-cli`, models base.en, small.en) -> `normalize()` with `bench/lexicon.yaml`.

Sentences: 110 (80 with lexicon terms, 30 clean prose; 6 marked expected-hard) x 3 voice(s) = 330 clips per variant. This invocation took 1 s (synthesis 0 s); cached audio and transcripts are skipped, so a cold run is longer (see the whisper wall time row).

Metrics are the ones from `bench/lib.ts` (see `bench/README.md`). Term recall is exact and case-sensitive on the canonical. Sentence accuracy is "loose": case and edge punctuation are folded before comparing, because Whisper capitalizes and punctuates on its own; internal punctuation (`Ashlr.AI`, `Next.js`) still has to match. "+ prompt" variants pass `lexicon export whisper-prompt` (654 chars, canonicals only) as whisper's initial prompt.

## Headline

| metric | base.en | base.en + prompt | small.en | small.en + prompt |
| --- | --- | --- | --- | --- |
| clips | 330 | 330 | 330 | 330 |
| term recall, raw Whisper | 41.9% (117/279) | 66.7% (186/279) | 45.9% (128/279) | 76.0% (212/279) |
| term recall, after lexicon | **82.8% (231/279)** | **90.3% (252/279)** | **91.0% (254/279)** | **95.7% (267/279)** |
| term precision | 93.9% (231/246) | 95.5% (252/264) | 94.4% (254/269) | 95.7% (267/279) |
| term F1 | 88.0% | 92.8% | 92.7% | 95.7% |
| sentence accuracy, raw Whisper (positives, loose) | 37.9% (91/240) | 51.2% (123/240) | 45.4% (109/240) | 72.5% (174/240) |
| sentence accuracy, after lexicon (positives, loose) | 65.8% (158/240) | 67.1% (161/240) | 78.8% (189/240) | 83.8% (201/240) |
| prose false-positive rate (negatives changed) | 16.7% (15/90) | 13.3% (12/90) | 16.7% (15/90) | 13.3% (12/90) |
| prose false-positive rate excl. expected-hard | 0.0% (0/72) | 0.0% (0/72) | 0.0% (0/72) | 0.0% (0/72) |
| whisper wall time | cached | cached | cached | cached |

## base.en

### By voice

| voice | clips | term recall raw | term recall after | sentence acc raw | sentence acc after | prose FP |
| --- | --- | --- | --- | --- | --- | --- |
| Samantha | 110 | 44.1% (41/93) | 88.2% (82/93) | 42.5% (34/80) | 73.8% (59/80) | 16.7% (5/30) |
| Daniel | 110 | 41.9% (39/93) | 83.9% (78/93) | 38.8% (31/80) | 68.8% (55/80) | 16.7% (5/30) |
| Karen | 110 | 39.8% (37/93) | 76.3% (71/93) | 32.5% (26/80) | 55.0% (44/80) | 16.7% (5/30) |

### By category

| category | clips | term recall raw | term recall after |
| --- | --- | --- | --- |
| brand | 48 | 14.8% (8/54) | 81.5% (44/54) |
| product | 96 | 48.6% (54/111) | 80.2% (89/111) |
| acronym | 42 | 88.9% (48/54) | 94.4% (51/54) |
| person | 30 | 21.2% (7/33) | 75.8% (25/33) |
| identifier | 24 | 0.0% (0/27) | 81.5% (22/27) |
| prose | 90 | - | - |

### By reason

| reason | replacements | correct | spurious | mean confidence |
| --- | --- | --- | --- | --- |
| alias | 102 | 90 | 12 | 1.000 |
| phonetic | 19 | 16 | 3 | 0.896 |
| fuzzy | 8 | 8 | 0 | 0.910 |

## base.en + prompt

### By voice

| voice | clips | term recall raw | term recall after | sentence acc raw | sentence acc after | prose FP |
| --- | --- | --- | --- | --- | --- | --- |
| Samantha | 110 | 64.5% (60/93) | 90.3% (84/93) | 55.0% (44/80) | 73.8% (59/80) | 13.3% (4/30) |
| Daniel | 110 | 68.8% (64/93) | 92.5% (86/93) | 51.2% (41/80) | 67.5% (54/80) | 13.3% (4/30) |
| Karen | 110 | 66.7% (62/93) | 88.2% (82/93) | 47.5% (38/80) | 60.0% (48/80) | 13.3% (4/30) |

### By category

| category | clips | term recall raw | term recall after |
| --- | --- | --- | --- |
| brand | 48 | 37.0% (20/54) | 85.2% (46/54) |
| product | 96 | 73.0% (81/111) | 88.3% (98/111) |
| acronym | 42 | 100.0% (54/54) | 100.0% (54/54) |
| person | 30 | 54.5% (18/33) | 90.9% (30/33) |
| identifier | 24 | 48.1% (13/27) | 88.9% (24/27) |
| prose | 90 | - | - |

### By reason

| reason | replacements | correct | spurious | mean confidence |
| --- | --- | --- | --- | --- |
| alias | 58 | 49 | 9 | 1.000 |
| phonetic | 11 | 8 | 3 | 0.895 |
| fuzzy | 9 | 9 | 0 | 0.914 |

## small.en

### By voice

| voice | clips | term recall raw | term recall after | sentence acc raw | sentence acc after | prose FP |
| --- | --- | --- | --- | --- | --- | --- |
| Samantha | 110 | 49.5% (46/93) | 93.5% (87/93) | 48.8% (39/80) | 83.8% (67/80) | 16.7% (5/30) |
| Daniel | 110 | 43.0% (40/93) | 90.3% (84/93) | 43.8% (35/80) | 78.8% (63/80) | 16.7% (5/30) |
| Karen | 110 | 45.2% (42/93) | 89.2% (83/93) | 43.8% (35/80) | 73.8% (59/80) | 16.7% (5/30) |

### By category

| category | clips | term recall raw | term recall after |
| --- | --- | --- | --- |
| brand | 48 | 22.2% (12/54) | 92.6% (50/54) |
| product | 96 | 51.4% (57/111) | 91.0% (101/111) |
| acronym | 42 | 88.9% (48/54) | 94.4% (51/54) |
| person | 30 | 30.3% (10/33) | 87.9% (29/33) |
| identifier | 24 | 3.7% (1/27) | 85.2% (23/27) |
| prose | 90 | - | - |

### By reason

| reason | replacements | correct | spurious | mean confidence |
| --- | --- | --- | --- | --- |
| alias | 107 | 95 | 12 | 1.000 |
| phonetic | 25 | 22 | 3 | 0.890 |
| fuzzy | 9 | 9 | 0 | 0.890 |

## small.en + prompt

### By voice

| voice | clips | term recall raw | term recall after | sentence acc raw | sentence acc after | prose FP |
| --- | --- | --- | --- | --- | --- | --- |
| Samantha | 110 | 75.3% (70/93) | 96.8% (90/93) | 75.0% (60/80) | 88.8% (71/80) | 13.3% (4/30) |
| Daniel | 110 | 75.3% (70/93) | 94.6% (88/93) | 71.3% (57/80) | 82.5% (66/80) | 13.3% (4/30) |
| Karen | 110 | 77.4% (72/93) | 95.7% (89/93) | 71.3% (57/80) | 80.0% (64/80) | 13.3% (4/30) |

### By category

| category | clips | term recall raw | term recall after |
| --- | --- | --- | --- |
| brand | 48 | 48.1% (26/54) | 90.7% (49/54) |
| product | 96 | 76.6% (85/111) | 96.4% (107/111) |
| acronym | 42 | 94.4% (51/54) | 100.0% (54/54) |
| person | 30 | 75.8% (25/33) | 90.9% (30/33) |
| identifier | 24 | 92.6% (25/27) | 100.0% (27/27) |
| prose | 90 | - | - |

### By reason

| reason | replacements | correct | spurious | mean confidence |
| --- | --- | --- | --- | --- |
| alias | 53 | 44 | 9 | 1.000 |
| phonetic | 9 | 6 | 3 | 0.886 |
| fuzzy | 5 | 5 | 0 | 0.894 |

## What Whisper wrote (base.en)

One row per canonical, sorted by raw recall (worst first). Outcome per spelling: `alias`/`phonetic`/`fuzzy` = recovered by that pass, `MISSED` = the lexicon did not fix it.

| canonical | category | raw | after | what Whisper wrote (count, outcome) |
| --- | --- | --- | --- | --- |
| Anthropic | brand | 0.0% (0/3) | 0.0% (0/3) | `and Thropic` x2 MISSED; `and Tropic` x1 MISSED |
| Ashlr.AI | brand | 0.0% (0/6) | 100.0% (6/6) | `Ashler AI` x3 alias; `Ashler AI's` x3 alias |
| Bjørn Halvorsen | person | 0.0% (0/3) | 66.7% (2/3) | `Byorn Halverson` x1 fuzzy; `By-on Halverson` x1 MISSED; `Byron Halvorsen` x1 fuzzy |
| Cloudflare | brand | 0.0% (0/3) | 66.7% (2/3) | `CloudFloor` x1 phonetic; `Cloudflour` x1 phonetic; `Cloudflow` x1 MISSED |
| Drizzle | product | 0.0% (0/3) | 100.0% (3/3) | `drizzle` x3 alias |
| harvestRepo | identifier | 0.0% (0/6) | 83.3% (5/6) | `Harvest repo` x3 alias; `harvest repo` x2 alias; `Harvest read per` x1 MISSED |
| JSON | acronym | 0.0% (0/3) | 100.0% (3/3) | `Jason` x3 alias |
| Kwame Mensah | person | 0.0% (0/6) | 100.0% (6/6) | `Kwame Mensa` x3 alias; `Kwame Mensa's` x2 alias; `Kwame mens's` x1 fuzzy |
| LangChain | product | 0.0% (0/3) | 66.7% (2/3) | `LANG chain` x1 alias; `landshane` x1 MISSED; `Langshane` x1 phonetic |
| Levenshtein | product | 0.0% (0/3) | 33.3% (1/3) | `Leventtien` x1 MISSED; `Levenstein` x1 fuzzy; `Leventstein` x1 MISSED |
| LexiconStore | identifier | 0.0% (0/6) | 83.3% (5/6) | `lexicon store` x3 alias; `lexicon story` x1 phonetic; `Lexi can store` x1 phonetic; `Lexic and` x1 MISSED |
| Nginx | product | 0.0% (0/3) | 100.0% (3/3) | `Engine X` x2 alias; `Enginex` x1 alias |
| normalizeTranscript | identifier | 0.0% (0/6) | 100.0% (6/6) | `normalize transcript` x3 alias; `Normalize transcript` x3 alias |
| Ollama | product | 0.0% (0/3) | 33.3% (1/3) | `Olima` x2 MISSED; `all Emma` x1 phonetic |
| OpenClaw | brand | 0.0% (0/3) | 100.0% (3/3) | `open claw` x3 alias |
| Playwright | product | 0.0% (0/6) | 100.0% (6/6) | `playwright` x6 alias |
| PostgreSQL | product | 0.0% (0/6) | 100.0% (6/6) | `Postgres` x6 alias |
| Puppeteer | product | 0.0% (0/3) | 66.7% (2/3) | `puppeteer` x2 alias; `pup hitear` x1 MISSED |
| Pydantic | product | 0.0% (0/3) | 66.7% (2/3) | `pedantic` x2 phonetic; `Adipidantic` x1 MISSED |
| Siobhan Reilly | person | 0.0% (0/6) | 83.3% (5/6) | `Shiv on Riley` x2 alias; `Shivorn really` x1 fuzzy; `Shivorn Riley` x1 fuzzy; `Shivorn rally` x1 MISSED; `Sheve-On-Rally` x1 phonetic |
| SQLite | product | 0.0% (0/3) | 0.0% (0/3) | `SQ light` x2 MISSED; `SQ light fall` x1 MISSED |
| Supabase | brand | 0.0% (0/6) | 100.0% (6/6) | `Superbase` x6 alias |
| Superwhisper | brand | 0.0% (0/3) | 100.0% (3/3) | `Super Whisper` x3 alias |
| Tadeusz Wróblewski | person | 0.0% (0/3) | 66.7% (2/3) | `Tadayush Vrooblefsky` x1 phonetic; `Tadayushvublefsky` x1 MISSED; `Ted Ayushvroob Lefsky` x1 phonetic |
| tRPC | product | 0.0% (0/3) | 100.0% (3/3) | `TRPC` x3 alias |
| Upstash | brand | 0.0% (0/3) | 66.7% (2/3) | `upstash` x2 alias; `erupts` x1 MISSED |
| UserPromptSubmit | identifier | 0.0% (0/6) | 50.0% (3/6) | `user prompt submit` x3 alias; `prompt` x1 MISSED; `prompt, submit` x1 MISSED; `user prompt, submit` x1 MISSED |
| Vercel | brand | 0.0% (0/6) | 66.7% (4/6) | `Versal` x4 phonetic; `vessel` x1 MISSED; `versatile` x1 MISSED |
| Vite | product | 0.0% (0/3) | 0.0% (0/3) | `VEED` x2 MISSED; `V8` x1 MISSED |
| Vitest | product | 0.0% (0/3) | 0.0% (0/3) | `V test` x3 MISSED |
| Wispr Flow | brand | 0.0% (0/3) | 100.0% (3/3) | `whisper flow` x3 alias |
| Xiuying Zhao | person | 0.0% (0/3) | 66.7% (2/3) | `Shaoying Jia` x1 phonetic; `Shawingiao` x1 MISSED; `Showing Zhao` x1 fuzzy |
| Deepgram | brand | 16.7% (1/6) | 100.0% (6/6) | `deep gram` x3 alias; `DeepGram` x2 alias |
| YAML | acronym | 16.7% (1/6) | 66.7% (4/6) | `yaml` x3 alias; `Yannell` x1 MISSED; `Yemil` x1 MISSED |
| Neon | brand | 33.3% (1/3) | 100.0% (3/3) | `neon` x1 alias; `knee on` x1 alias |
| Priyanka Raghunathan | person | 33.3% (2/6) | 50.0% (3/6) | `Priyanka Regunath and` x2 MISSED; `Priyankaragunath and` x1 MISSED; `Priyanka Regunathan` x1 fuzzy |
| Tailwind | product | 33.3% (1/3) | 100.0% (3/3) | `tailwind` x2 alias |
| Hetzner | brand | 50.0% (3/6) | 50.0% (3/6) | `Tetsner` x1 MISSED; `now` x1 MISSED; `Hetzena` x1 MISSED |
| JWT | product | 50.0% (3/6) | 100.0% (6/6) | `jot` x3 alias |
| Kubernetes | product | 50.0% (3/6) | 50.0% (3/6) | `Cuban eats` x1 MISSED; `Cuban needs` x1 MISSED; `cuba needs` x1 MISSED |
| Next.js | product | 66.7% (2/3) | 100.0% (3/3) | `next JS` x1 alias |
| OAuth | product | 66.7% (2/3) | 66.7% (2/3) | `OA auth` x1 MISSED |
| SaaS | acronym | 66.7% (2/3) | 66.7% (2/3) | `SAS` x1 MISSED |
| Zod | product | 66.7% (2/3) | 66.7% (2/3) | `sod` x1 MISSED |
| Kafka | product | 83.3% (5/6) | 83.3% (5/6) | `calf care` x1 MISSED |
| Mason Wyatt | person | 83.3% (5/6) | 83.3% (5/6) | `Mason Wired` x1 MISSED |
| API | acronym | 100.0% (6/6) | 100.0% (6/6) | - |
| ARR | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| CLI | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| CRM | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| Docker | product | 100.0% (3/3) | 100.0% (3/3) | - |
| Grafana | product | 100.0% (6/6) | 100.0% (6/6) | - |
| GraphQL | product | 100.0% (3/3) | 100.0% (3/3) | - |
| GTM | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| KPI | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| MCP | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| Metaphone | product | 100.0% (3/3) | 100.0% (3/3) | - |
| MRR | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| OKR | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| PRD | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| Prisma | product | 100.0% (3/3) | 100.0% (3/3) | - |
| Prometheus | product | 100.0% (6/6) | 100.0% (6/6) | - |
| Redis | product | 100.0% (6/6) | 100.0% (6/6) | - |
| RLS | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| SDK | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| SSO | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| STT | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| Terraform | product | 100.0% (3/3) | 100.0% (3/3) | - |
| TTS | acronym | 100.0% (3/3) | 100.0% (3/3) | - |
| Whisper | product | 100.0% (3/3) | 100.0% (3/3) | - |

## Suggested aliases for bench/lexicon.yaml (base.en)

Spellings the lexicon did not recover (adding these as aliases fixes the miss):

| canonical | add alias | seen |
| --- | --- | --- |
| Vitest | `V test` | x3 |
| Anthropic | `and Thropic` | x2 |
| Ollama | `Olima` | x2 |
| Priyanka Raghunathan | `Priyanka Regunath and` | x2 |
| SQLite | `SQ light` | x2 |
| Vite | `VEED` | x2 |
| Anthropic | `and Tropic` | x1 |
| Bjørn Halvorsen | `By-on Halverson` | x1 |
| Cloudflare | `Cloudflow` | x1 |
| harvestRepo | `Harvest read per` | x1 |
| Hetzner | `Tetsner` | x1 |
| Hetzner | `now` | x1 |
| Hetzner | `Hetzena` | x1 |
| Kafka | `calf care` | x1 |
| Kubernetes | `Cuban eats` | x1 |
| Kubernetes | `Cuban needs` | x1 |
| Kubernetes | `cuba needs` | x1 |
| LangChain | `landshane` | x1 |
| Levenshtein | `Leventtien` | x1 |
| Levenshtein | `Leventstein` | x1 |
| LexiconStore | `Lexic and` | x1 |
| Mason Wyatt | `Mason Wired` | x1 |
| OAuth | `OA auth` | x1 |
| Priyanka Raghunathan | `Priyankaragunath and` | x1 |
| Puppeteer | `pup hitear` | x1 |
| Pydantic | `Adipidantic` | x1 |
| SaaS | `SAS` | x1 |
| Siobhan Reilly | `Shivorn rally` | x1 |
| SQLite | `SQ light fall` | x1 |
| Tadeusz Wróblewski | `Tadayushvublefsky` | x1 |
| Upstash | `erupts` | x1 |
| UserPromptSubmit | `prompt` | x1 |
| UserPromptSubmit | `prompt, submit` | x1 |
| UserPromptSubmit | `user prompt, submit` | x1 |
| Vercel | `vessel` | x1 |
| Vercel | `versatile` | x1 |
| Vite | `V8` | x1 |
| Xiuying Zhao | `Shawingiao` | x1 |
| YAML | `Yannell` | x1 |
| YAML | `Yemil` | x1 |
| Zod | `sod` | x1 |

Spellings recovered by the phonetic or fuzzy pass (an alias would make the hit exact and confidence 1.0):

| canonical | add alias | seen |
| --- | --- | --- |
| Vercel | `Versal` | x4 |
| Pydantic | `pedantic` | x2 |

## Failing clips: base.en (97)

- **a-brand-08@Samantha** [brand, terms recovered, Whisper mangled another word]
  - heard:    `I dictated the whole speck with whisper flow this morning.`
  - output:   `I dictated the whole speck with Wispr Flow this morning.`
  - expected: `I dictated the whole spec with Wispr Flow this morning.`
- **a-brand-11@Samantha** [brand]
  - heard:    `and Thropic released a new model, update the pricing doc.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-brand-13@Samantha** [brand]
  - heard:    `Write a quick note on why we pick Tetsner over Versal.`
  - output:   `Write a quick note on why we pick Tetsner over Vercel.`
  - expected: `Write a quick note on why we picked Hetzner over Vercel.`
  - missed: Hetzner
- **a-prod-03@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Migrate the session's table from Postgres to Redis.`
  - output:   `Migrate the session's table from PostgreSQL to Redis.`
  - expected: `Migrate the sessions table from PostgreSQL to Redis.`
- **a-prod-04@Samantha** [product]
  - heard:    `Ship the SQ light fallback for offline mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-06@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Replace the hand-written the styles with Tailwind on the settings page.`
  - expected: `Replace the handwritten styles with Tailwind on the settings page.`
- **a-prod-07@Samantha** [product]
  - heard:    `Validate the request body with sod before it hits the handler.`
  - expected: `Validate the request body with Zod before it hits the handler.`
  - missed: Zod
- **a-prod-08@Samantha** [product]
  - heard:    `Switch the build from webpack to VEED.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Samantha** [product]
  - heard:    `Run the V test suite before you push.`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-12@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `the TRPC router needs an off-middle wear.`
  - output:   `the tRPC router needs an off-middle wear.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-16@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the jot when it has less than 5 minutes left.`
  - output:   `Refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-17@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Engine X is returning a bad gateway on the wood socket route.`
  - output:   `Nginx is returning a bad gateway on the wood socket route.`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-24@Samantha** [product]
  - heard:    `Replace pup hitear with playwright in the scraper.`
  - output:   `Replace pup hitear with Playwright in the scraper.`
  - expected: `Replace Puppeteer with Playwright in the scraper.`
  - missed: Puppeteer
- **a-prod-29@Samantha** [product]
  - heard:    `Use Leventtien distance for the fuzzy pass.`
  - expected: `Use Levenshtein distance for the fuzzy pass.`
  - missed: Levenshtein
- **a-prod-31@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Cash the Postgres query results in Redis for an hour.`
  - output:   `Cash the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-acr-01@Samantha** [acronym]
  - heard:    `Our SAS margins are fine. The services margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
  - missed: SaaS
- **a-acr-11@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-05@Samantha** [person, terms recovered, Whisper mangled another word]
  - heard:    `Byorn Halverson is presenting at the off-site.`
  - output:   `Bjørn Halvorsen is presenting at the off-site.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
- **a-person-10@Samantha** [person]
  - heard:    `Get Priyankaragunath and sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
  - missed: Priyanka Raghunathan
- **a-ident-03@Samantha** [identifier]
  - heard:    `user prompt submithook has to stay fast.`
  - expected: `The UserPromptSubmit hook has to stay fast.`
  - missed: UserPromptSubmit
- **a-ident-05@Samantha** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `have lexicon story load when the yaml changes.`
  - output:   `have LexiconStore load when the YAML changes.`
  - expected: `Have LexiconStore reload when the YAML changes.`
- **a-prose-10@Samantha** [prose, expected-hard, negative]
  - heard:    `there was a light drizzle all afternoon.`
  - output:   `there was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Samantha** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Samantha** [prose, expected-hard, negative]
  - heard:    `Please whisper, "The baby is asleep."`
  - output:   `Please Whisper, "The baby is asleep."`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-13@Samantha** [prose, expected-hard, negative]
  - heard:    `The playwright took a bow after the final curtain.`
  - output:   `The Playwright took a bow after the final curtain.`
  - expected: `The playwright took a bow after the final curtain.`
  - spurious: "playwright" -> "Playwright" (alias, 1.00)
- **a-prose-15@Samantha** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commerce.`
  - output:   `He can be a bit Pydantic about commerce.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-02@Daniel** [brand]
  - heard:    `Move the staging box off-heads now before the renewal.`
  - expected: `Move the staging box off Hetzner before the renewal.`
  - missed: Hetzner
- **a-brand-03@Daniel** [brand]
  - heard:    `The vessel bill doubled last month. Can you check why?`
  - expected: `The Vercel bill doubled last month, can you check why?`
  - missed: Vercel
- **a-brand-11@Daniel** [brand]
  - heard:    `and Tropic released a new model. Update the pricing doc.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-prod-01@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Add a pedantic model for the sink job.`
  - output:   `Add a Pydantic model for the sink job.`
  - expected: `Add a Pydantic model for the sync job.`
- **a-prod-02@Daniel** [product]
  - heard:    `The Cuban eats cluster ran out of memory again last night.`
  - expected: `The Kubernetes cluster ran out of memory again last night.`
  - missed: Kubernetes
- **a-prod-04@Daniel** [product]
  - heard:    `Ship the SQ light fall back for a flying mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-08@Daniel** [product]
  - heard:    `Switch the build from webpack to V8.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Daniel** [product]
  - heard:    `Run the V test suite before you push.`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-12@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs an orth middle way.`
  - output:   `The tRPC router needs an orth middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-16@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `refresh the jot when it has less than 5 minutes left.`
  - output:   `refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-17@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Engine X is returning a bad gateway on the Wibsocket route.`
  - output:   `Nginx is returning a bad gateway on the Wibsocket route.`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-20@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka consumer lag spiked off to the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-25@Daniel** [product]
  - heard:    `Rip out landshane and call the model directly.`
  - expected: `Rip out LangChain and call the model directly.`
  - missed: LangChain
- **a-prod-26@Daniel** [product]
  - heard:    `Run the evil locally with Olima first.`
  - expected: `Run the eval locally with Ollama first.`
  - missed: Ollama
- **a-prod-31@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Cash the Postgres query results in Redis for an hour.`
  - output:   `Cash the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-prod-32@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `work Kafka into the Kubernetes deployment with a sidecar.`
  - expected: `Wire Kafka into the Kubernetes deployment with a sidecar.`
- **a-acr-04@Daniel** [acronym]
  - heard:    `Export the lexicon as Yannell, not Jason.`
  - output:   `Export the lexicon as Yannell, not JSON.`
  - expected: `Export the lexicon as YAML, not JSON.`
  - missed: YAML
- **a-acr-11@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-01@Daniel** [person]
  - heard:    `Ask Mason Wired to review the pricing page.`
  - expected: `Ask Mason Wyatt to review the pricing page.`
  - missed: Mason Wyatt
- **a-person-03@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Lupin Kwame Mensa on the data pipeline.`
  - output:   `Lupin Kwame Mensah on the data pipeline.`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
- **a-person-04@Daniel** [person]
  - heard:    `Shawingiao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
  - missed: Xiuying Zhao
- **a-person-05@Daniel** [person]
  - heard:    `By-on Halverson is presenting at the off-site.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
  - missed: Bjørn Halvorsen
- **a-person-07@Daniel** [person]
  - heard:    `Send the contract to Tadayushvublefsky today.`
  - expected: `Send the contract to Tadeusz Wróblewski today.`
  - missed: Tadeusz Wróblewski
- **a-person-10@Daniel** [person]
  - heard:    `Get Priyanka Regunath and sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
  - missed: Priyanka Raghunathan
- **a-ident-01@Daniel** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `The lexicon store should cache the past file.`
  - output:   `The LexiconStore should cache the past file.`
  - expected: `The LexiconStore should cache the parsed file.`
- **a-prose-10@Daniel** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Daniel** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Daniel** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-13@Daniel** [prose, expected-hard, negative]
  - heard:    `The playwright took a bow after the final curtain.`
  - output:   `The Playwright took a bow after the final curtain.`
  - expected: `The playwright took a bow after the final curtain.`
  - spurious: "playwright" -> "Playwright" (alias, 1.00)
- **a-prose-15@Daniel** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-02@Karen** [brand]
  - heard:    `Move the staging box off Hetzena before the renewal.`
  - expected: `Move the staging box off Hetzner before the renewal.`
  - missed: Hetzner
- **a-brand-03@Karen** [brand]
  - heard:    `The versatile bill doubled last month. Can you check why?`
  - expected: `The Vercel bill doubled last month, can you check why?`
  - missed: Vercel
- **a-brand-06@Karen** [brand]
  - heard:    `L erupts stash usage's way over the free tile.`
  - expected: `Our Upstash usage is way over the free tier.`
  - missed: Upstash
- **a-brand-11@Karen** [brand]
  - heard:    `and Thropic released a new model, update the pricing doc.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-brand-12@Karen** [brand]
  - heard:    `Put the API behind Cloudflow before we announce.`
  - expected: `Put the API behind Cloudflare before we announce.`
  - missed: Cloudflare
- **a-prod-01@Karen** [product]
  - heard:    `Adipidantic model for the synch job.`
  - expected: `Add a Pydantic model for the sync job.`
  - missed: Pydantic
- **a-prod-02@Karen** [product]
  - heard:    `The Cuban needs cluster ran out of memory again last night.`
  - expected: `The Kubernetes cluster ran out of memory again last night.`
  - missed: Kubernetes
- **a-prod-04@Karen** [product]
  - heard:    `Ship the SQ light fallback for offline mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-08@Karen** [product]
  - heard:    `Switch the build from Webpack to VEED.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Karen** [product]
  - heard:    `Run the V test suite before you push.`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-12@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs an orth-middle way.`
  - output:   `The tRPC router needs an orth-middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-14@Karen** [product]
  - heard:    `The OA auth callback is redirecting to the wrong port.`
  - expected: `The OAuth callback is redirecting to the wrong port.`
  - missed: OAuth
- **a-prod-16@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the jot when it has less than 5 minutes left.`
  - output:   `Refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-17@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Enginex is returning a bad gateway on the Whibsocket route.`
  - output:   `Nginx is returning a bad gateway on the Whibsocket route.`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-20@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka consumer lag sparked after the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-21@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Set up a Grafana dashboard for checkout agency.`
  - expected: `Set up a Grafana dashboard for checkout latency.`
- **a-prod-26@Karen** [product]
  - heard:    `Run the ever locally with Olima first.`
  - expected: `Run the eval locally with Ollama first.`
  - missed: Ollama
- **a-prod-29@Karen** [product]
  - heard:    `Use Leventstein distance for the fuzzy pass.`
  - expected: `Use Levenshtein distance for the fuzzy pass.`
  - missed: Levenshtein
- **a-prod-31@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Pash the Postgres query results in Redis for an hour.`
  - output:   `Pash the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-prod-32@Karen** [product]
  - heard:    `Wire calf care into the cuba needs deployment with a side car.`
  - expected: `Wire Kafka into the Kubernetes deployment with a sidecar.`
  - missed: Kafka, Kubernetes
- **a-acr-01@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Our SaaS margins are fine, the service's margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
- **a-acr-03@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `The CLI should print the diff before it rides.`
  - expected: `The CLI should print the diff before it writes.`
- **a-acr-04@Karen** [acronym]
  - heard:    `Export the lexicon as Yemil, not Jason.`
  - output:   `Export the lexicon as Yemil, not JSON.`
  - expected: `Export the lexicon as YAML, not JSON.`
  - missed: YAML
- **a-acr-05@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `The RLS policy blocks the export through admins.`
  - expected: `The RLS policy blocks the export for admins.`
- **a-acr-14@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `compared TTS latency against the STT pipeline.`
  - expected: `Compare TTS latency against the STT pipeline.`
- **a-person-02@Karen** [person]
  - heard:    `Shivorn rally owns the onboarding flow now.`
  - expected: `Siobhan Reilly owns the onboarding flow now.`
  - missed: Siobhan Reilly
- **a-person-03@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Lupin Kwame Mensa on the data pipeline.`
  - output:   `Lupin Kwame Mensah on the data pipeline.`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
- **a-person-04@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Showing Zhao wrote the original matcha.`
  - output:   `Xiuying Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
- **a-person-05@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Byron Halvorsen is presenting at the upside.`
  - output:   `Bjørn Halvorsen is presenting at the upside.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
- **a-person-06@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Priyanka Raghunathan flagged the memory league.`
  - expected: `Priyanka Raghunathan flagged the memory leak.`
- **a-person-10@Karen** [person]
  - heard:    `Get Priyanka Regunath and sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
  - missed: Priyanka Raghunathan
- **a-ident-01@Karen** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `The Lexi can store should cache the past file.`
  - output:   `The LexiconStore should cache the past file.`
  - expected: `The LexiconStore should cache the parsed file.`
- **a-ident-03@Karen** [identifier]
  - heard:    `user prompt, submit hook has to stay fast.`
  - expected: `The UserPromptSubmit hook has to stay fast.`
  - missed: UserPromptSubmit
- **a-ident-05@Karen** [identifier]
  - heard:    `Have Lexic and Storyload when the yaml changes.`
  - output:   `Have Lexic and Storyload when the YAML changes.`
  - expected: `Have LexiconStore reload when the YAML changes.`
  - missed: LexiconStore
- **a-ident-07@Karen** [identifier]
  - heard:    `Register user prompt, submit in the plug-in hooks file`
  - expected: `Register UserPromptSubmit in the plugin hooks file.`
  - missed: UserPromptSubmit
- **a-ident-08@Karen** [identifier]
  - heard:    `Harvest read per should skip node modules.`
  - expected: `harvestRepo should skip node modules.`
  - missed: harvestRepo
- **a-prose-10@Karen** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Karen** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Karen** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-13@Karen** [prose, expected-hard, negative]
  - heard:    `The playwright took a bow after the final curtain.`
  - output:   `The Playwright took a bow after the final curtain.`
  - expected: `The playwright took a bow after the final curtain.`
  - spurious: "playwright" -> "Playwright" (alias, 1.00)
- **a-prose-15@Karen** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)

## Failing clips: base.en + prompt (91)

- **a-brand-03@Samantha** [brand, terms recovered, Whisper mangled another word]
  - heard:    `The Versal Build doubled last month. Can you check why?`
  - output:   `The Vercel Build doubled last month. Can you check why?`
  - expected: `The Vercel bill doubled last month, can you check why?`
- **a-brand-06@Samantha** [brand]
  - heard:    `RUPS-USAGE as way over the free tier.`
  - expected: `Our Upstash usage is way over the free tier.`
  - missed: Upstash
- **a-brand-11@Samantha** [brand]
  - heard:    `and Thropic released a new model, update the pricing doc.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-prod-04@Samantha** [product]
  - heard:    `Ship the SQ-like fallback for offline mode`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-08@Samantha** [product]
  - heard:    `Switch the build from Webpack to VEED`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-13@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Exposed the search endpoint over GraphQL as well`
  - expected: `Expose the search endpoint over GraphQL as well.`
- **a-prod-17@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Nginx is returning a bad gateway on the wood socket route.`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-20@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka Consumer Lagspiked after the deploy`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-22@Samantha** [product]
  - heard:    `from Etheus is scraping the wrong port.`
  - expected: `Prometheus is scraping the wrong port.`
  - missed: Prometheus
- **a-prod-25@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Ripout LangChain and call the model directly.`
  - expected: `Rip out LangChain and call the model directly.`
- **a-prod-26@Samantha** [product]
  - heard:    `Run the eval locally with Olima first.`
  - expected: `Run the eval locally with Ollama first.`
  - missed: Ollama
- **a-prod-31@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Cash the Postgres Query Results in Redis for an hour`
  - output:   `Cash the PostgreSQL Query Results in Redis for an hour`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-prod-32@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Wire Kafka into the Kubernete's deployment with a sidecar`
  - output:   `Wire Kafka into the Kubernetes's deployment with a sidecar`
  - expected: `Wire Kafka into the Kubernetes deployment with a sidecar.`
- **a-acr-01@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Our SaaS margins are fine, the service's margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
- **a-acr-09@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `MRR is flat but churned dropped`
  - expected: `MRR is flat but churn dropped.`
- **a-acr-11@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-07@Samantha** [person]
  - heard:    `Send the contract to Tadeusz-Vroublewski today.`
  - expected: `Send the contract to Tadeusz Wróblewski today.`
  - missed: Tadeusz Wróblewski
- **a-person-10@Samantha** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunath and sign off on this schema.`
  - output:   `Get Priyanka Raghunathan and sign off on this schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-03@Samantha** [identifier]
  - heard:    `The user prompt submithook has to stay fast.`
  - expected: `The UserPromptSubmit hook has to stay fast.`
  - missed: UserPromptSubmit
- **a-ident-05@Samantha** [identifier]
  - heard:    `have Lexicon Storyload when the YAML changes.`
  - expected: `Have LexiconStore reload when the YAML changes.`
  - missed: LexiconStore
- **a-ident-07@Samantha** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `Register UserPromptSubmit in the plug-in hooks file`
  - expected: `Register UserPromptSubmit in the plugin hooks file.`
- **a-prose-10@Samantha** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Samantha** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Samantha** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-15@Samantha** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commerce.`
  - output:   `He can be a bit Pydantic about commerce.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-03@Daniel** [brand, terms recovered, Whisper mangled another word]
  - heard:    `The Versal Build doubled last month. Can you check why?`
  - output:   `The Vercel Build doubled last month. Can you check why?`
  - expected: `The Vercel bill doubled last month, can you check why?`
- **a-brand-06@Daniel** [brand, terms recovered, Whisper mangled another word]
  - heard:    `ARR, Upstash Usage is way over the free tier.`
  - expected: `Our Upstash usage is way over the free tier.`
- **a-brand-11@Daniel** [brand]
  - heard:    `and Tropic released a new model. Update the pricing doc.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-brand-12@Daniel** [brand]
  - heard:    `Put the API behind Cloudflow before we announce`
  - expected: `Put the API behind Cloudflare before we announce.`
  - missed: Cloudflare
- **a-prod-04@Daniel** [product]
  - heard:    `Ship the SQ light fallback for a flying mode`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-08@Daniel** [product]
  - heard:    `Switch the build from Webpack to V8`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Daniel** [product]
  - heard:    `Run the V test suite before you push.`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-12@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs an orth middle way.`
  - output:   `The tRPC router needs an orth middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-13@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Exposed the search endpoint over GraphQL as well.`
  - expected: `Expose the search endpoint over GraphQL as well.`
- **a-prod-16@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the JWT when it has less than 5 minutes left`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-17@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Nginx is returning a bad gateway on the Wibsocket route.`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-20@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka Consumer Lags spiked off to the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-24@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Replace Puppeteer with Playwright and the Scraper.`
  - expected: `Replace Puppeteer with Playwright in the scraper.`
- **a-prod-26@Daniel** [product]
  - heard:    `Run the evil locally with Olima first.`
  - expected: `Run the eval locally with Ollama first.`
  - missed: Ollama
- **a-prod-31@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Cash the Postgres query results in Redis for an hour.`
  - output:   `Cash the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-prod-32@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Work Kafka into the Kubernete's deployment with a sidecar`
  - output:   `Work Kafka into the Kubernetes's deployment with a sidecar`
  - expected: `Wire Kafka into the Kubernetes deployment with a sidecar.`
- **a-acr-01@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Our SaaS margins are fine. The service's margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
- **a-acr-08@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `ARR cross the target this quarter.`
  - expected: `ARR crossed the target this quarter.`
- **a-acr-09@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `MRR is flat but churned rocked.`
  - expected: `MRR is flat but churn dropped.`
- **a-acr-11@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-03@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Lupin Kwame Mensah on the data pipeline.`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
- **a-person-04@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Shawing Zhao wrote the original matcha.`
  - output:   `Xiuying Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
- **a-person-05@Daniel** [person]
  - heard:    `by on Halverson is presenting at the upper side.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
  - missed: Bjørn Halvorsen
- **a-person-10@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunathan sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-01@Daniel** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `The LexiconStore should cache the past file.`
  - expected: `The LexiconStore should cache the parsed file.`
- **a-ident-03@Daniel** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `The UserPrompt Submit Hooked has to stay fast.`
  - output:   `The UserPromptSubmit Hooked has to stay fast.`
  - expected: `The UserPromptSubmit hook has to stay fast.`
- **a-prose-10@Daniel** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Daniel** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Daniel** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-15@Daniel** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-04@Karen** [brand, terms recovered, Whisper mangled another word]
  - heard:    `SpinUp a new Superbase project for the demo.`
  - output:   `SpinUp a new Supabase project for the demo.`
  - expected: `Spin up a new Supabase project for the demo.`
- **a-brand-06@Karen** [brand]
  - heard:    `L erupts Tash usage's way over the free tile`
  - expected: `Our Upstash usage is way over the free tier.`
  - missed: Upstash
- **a-brand-10@Karen** [brand, terms recovered, Whisper mangled another word]
  - heard:    `and OpenClaw to the stack slide in the pitch deck.`
  - expected: `Add OpenClaw to the stack slide in the pitch deck.`
- **a-brand-11@Karen** [brand]
  - heard:    `and Thropic released a new model, update the pricing doc.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-brand-12@Karen** [brand]
  - heard:    `Put the API behind Cloudflow before we announce.`
  - expected: `Put the API behind Cloudflare before we announce.`
  - missed: Cloudflare
- **a-brand-13@Karen** [brand]
  - heard:    `Write a quick note on why we picked Hetzner overversal.`
  - expected: `Write a quick note on why we picked Hetzner over Vercel.`
  - missed: Vercel
- **a-prod-01@Karen** [product]
  - heard:    `ADAPIDANTIC MODEL FOR THE SINK JOG`
  - expected: `Add a Pydantic model for the sync job.`
  - missed: Pydantic
- **a-prod-03@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Margrate the sessions table from Postgres to Redis.`
  - output:   `Margrate the sessions table from PostgreSQL to Redis.`
  - expected: `Migrate the sessions table from PostgreSQL to Redis.`
- **a-prod-05@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `UpgradeNext.js and see if the build still passes.`
  - expected: `Upgrade Next.js and see if the build still passes.`
- **a-prod-08@Karen** [product]
  - heard:    `Switch the build from Webpack to VEED`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Karen** [product]
  - heard:    `Run the V test suite before you push`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-12@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs an orth middle way`
  - output:   `The tRPC router needs an orth middle way`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-16@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the JWT when it has less than 5 minutes left`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-17@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Nginx is returning a bad gateway on the Wibsocket route`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-20@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka consumer lag sparked after the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-21@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Set up a Grafana dashboard for checkout agency.`
  - expected: `Set up a Grafana dashboard for checkout latency.`
- **a-prod-25@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Ripout LangChain and call the model directly.`
  - expected: `Rip out LangChain and call the model directly.`
- **a-prod-26@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Run the ever locally with Olama first`
  - output:   `Run the ever locally with Ollama first`
  - expected: `Run the eval locally with Ollama first.`
- **a-prod-30@Karen** [product]
  - heard:    `Point Grafaneur at Prometheus instead of the old exporter.`
  - expected: `Point Grafana at Prometheus instead of the old exporter.`
  - missed: Grafana
- **a-prod-31@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Pash the Postgres query results in Redis for an hour.`
  - output:   `Pash the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-prod-32@Karen** [product]
  - heard:    `YKAFKARIN to the Kubernetes deployment with a sidecar`
  - expected: `Wire Kafka into the Kubernetes deployment with a sidecar.`
  - missed: Kafka
- **a-acr-01@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Our SaaS margins are fine, the service's margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
- **a-acr-03@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `The CLI should print the diff before it rides.`
  - expected: `The CLI should print the diff before it writes.`
- **a-acr-14@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `and compare TTS latency against the STT pipeline.`
  - expected: `Compare TTS latency against the STT pipeline.`
- **a-person-03@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Lube and Kwame Mensah on the data pipeline`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
- **a-person-04@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Showing Zhao wrote the original matcha.`
  - output:   `Xiuying Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
- **a-person-05@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Byron Halvorsen is presenting at the upside.`
  - output:   `Bjørn Halvorsen is presenting at the upside.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
- **a-person-06@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Priyanka Raghunathan flagged the memory league`
  - expected: `Priyanka Raghunathan flagged the memory leak.`
- **a-person-07@Karen** [person]
  - heard:    `Send the contract to Ted Ayushvroob, Levski today.`
  - expected: `Send the contract to Tadeusz Wróblewski today.`
  - missed: Tadeusz Wróblewski
- **a-person-10@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunathan sign off on the schema`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-01@Karen** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `The LexiconStore should cache the past file.`
  - expected: `The LexiconStore should cache the parsed file.`
- **a-ident-08@Karen** [identifier]
  - heard:    `HarvestReadPer should skip node modules`
  - expected: `harvestRepo should skip node modules.`
  - missed: harvestRepo
- **a-prose-10@Karen** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Karen** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Karen** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-15@Karen** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)

## Failing clips: small.en (66)

- **a-brand-03@Samantha** [brand]
  - heard:    `The versatile bill doubled last month. Can you check why?`
  - expected: `The Vercel bill doubled last month, can you check why?`
  - missed: Vercel
- **a-brand-11@Samantha** [brand, terms recovered, Whisper mangled another word]
  - heard:    `Anthropic released a new model, update the pricing dock.`
  - expected: `Anthropic released a new model, update the pricing doc.`
- **a-prod-04@Samantha** [product]
  - heard:    `Ship the SQ light fallback for offline mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-08@Samantha** [product]
  - heard:    `Switch the build from Webpack to VEED.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Samantha** [product]
  - heard:    `Run the V test suite before you push.`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-13@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Expose the search and point over GraphQL as well.`
  - expected: `Expose the search endpoint over GraphQL as well.`
- **a-prod-16@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the jot when it has less than 5 minutes left.`
  - output:   `Refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-17@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Engine X is returning a bad gateway on the Whib socket route.`
  - output:   `Nginx is returning a bad gateway on the Whib socket route.`
  - expected: `Nginx is returning a bad gateway on the websocket route.`
- **a-prod-29@Samantha** [product]
  - heard:    `Use Levengteen distance for the fuzzy pass.`
  - expected: `Use Levenshtein distance for the fuzzy pass.`
  - missed: Levenshtein
- **a-acr-11@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR dock.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-06@Samantha** [person]
  - heard:    `Free-eye anchor Agunathan flagged the memory leak.`
  - expected: `Priyanka Raghunathan flagged the memory leak.`
  - missed: Priyanka Raghunathan
- **a-person-10@Samantha** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunath and sign off on the schema.`
  - output:   `Get Priyanka Raghunathan and sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-05@Samantha** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `Have lexicon storey load when the YAML changes.`
  - output:   `Have LexiconStore load when the YAML changes.`
  - expected: `Have LexiconStore reload when the YAML changes.`
- **a-prose-10@Samantha** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Samantha** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Samantha** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-13@Samantha** [prose, expected-hard, negative]
  - heard:    `The playwright took a bow after the final curtain.`
  - output:   `The Playwright took a bow after the final curtain.`
  - expected: `The playwright took a bow after the final curtain.`
  - spurious: "playwright" -> "Playwright" (alias, 1.00)
- **a-prose-15@Samantha** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-03@Daniel** [brand]
  - heard:    `The versatile bill doubled last month. Can you check why?`
  - expected: `The Vercel bill doubled last month, can you check why?`
  - missed: Vercel
- **a-brand-11@Daniel** [brand]
  - heard:    `and Thropic released a new model. Update the pricing dock.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-prod-04@Daniel** [product]
  - heard:    `Ship the SQ light full back for a flying mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-12@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs a north middle way.`
  - output:   `The tRPC router needs a north middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-16@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the jot when it has less than 5 minutes left.`
  - output:   `Refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-20@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka consumer lag spiked off to the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-26@Daniel** [product]
  - heard:    `Run the eval locally with Olima first.`
  - expected: `Run the eval locally with Ollama first.`
  - missed: Ollama
- **a-acr-01@Daniel** [acronym]
  - heard:    `Our SAS margins are fine. The services margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
  - missed: SaaS
- **a-acr-04@Daniel** [acronym]
  - heard:    `Export the lexicon as Yannal, not Jason.`
  - output:   `Export the lexicon as Yannal, not JSON.`
  - expected: `Export the lexicon as YAML, not JSON.`
  - missed: YAML
- **a-acr-07@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Sync the CRM with the billing event nightly.`
  - expected: `Sync the CRM with the billing events nightly.`
- **a-acr-11@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR dock.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-01@Daniel** [person]
  - heard:    `Ask Mason Wired to review the pricing page.`
  - expected: `Ask Mason Wyatt to review the pricing page.`
  - missed: Mason Wyatt
- **a-person-03@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Lupin Kwame Mensa on the data pipeline.`
  - output:   `Lupin Kwame Mensah on the data pipeline.`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
- **a-person-04@Daniel** [person]
  - heard:    `Shouen Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
  - missed: Xiuying Zhao
- **a-person-05@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Bayern Halvorsen is presenting at the other side.`
  - output:   `Bjørn Halvorsen is presenting at the other side.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
- **a-person-10@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunath and sign off on the schema.`
  - output:   `Get Priyanka Raghunathan and sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-02@Daniel** [identifier]
  - heard:    `Call normalize_transcript before the hook returns.`
  - expected: `Call normalizeTranscript before the hook returns.`
  - missed: normalizeTranscript
- **a-prose-10@Daniel** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Daniel** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Daniel** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-13@Daniel** [prose, expected-hard, negative]
  - heard:    `The playwright took a bow off to the final curtain.`
  - output:   `The Playwright took a bow off to the final curtain.`
  - expected: `The playwright took a bow after the final curtain.`
  - spurious: "playwright" -> "Playwright" (alias, 1.00)
- **a-prose-15@Daniel** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-02@Karen** [brand]
  - heard:    `Move the staging box off Hetzena before the renewal.`
  - expected: `Move the staging box off Hetzner before the renewal.`
  - missed: Hetzner
- **a-brand-06@Karen** [brand, terms recovered, Whisper mangled another word]
  - heard:    `Our upstache usage is way over the free tire.`
  - output:   `Our Upstash usage is way over the free tire.`
  - expected: `Our Upstash usage is way over the free tier.`
- **a-brand-11@Karen** [brand, terms recovered, Whisper mangled another word]
  - heard:    `Anthropic released a new model, update the pricing dock.`
  - expected: `Anthropic released a new model, update the pricing doc.`
- **a-prod-04@Karen** [product]
  - heard:    `Ship the SQ light fallback for offline mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
  - missed: SQLite
- **a-prod-08@Karen** [product]
  - heard:    `switch the build from Webpack to VEED.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-09@Karen** [product]
  - heard:    `Run the V test suite before you push.`
  - expected: `Run the Vitest suite before you push.`
  - missed: Vitest
- **a-prod-12@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs an old middle way.`
  - output:   `The tRPC router needs an old middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-16@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the Jot when it has less than 5 minutes left.`
  - output:   `Refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-20@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka consumer lag sparked after the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-23@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `The playwright tests a flaky on the build server.`
  - output:   `The Playwright tests a flaky on the build server.`
  - expected: `The Playwright tests are flaky on the build server.`
- **a-prod-26@Karen** [product]
  - heard:    `Run the ever locally with Olima first.`
  - expected: `Run the eval locally with Ollama first.`
  - missed: Ollama
- **a-prod-31@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kesh the Postgres query results in Redis for an hour.`
  - output:   `Kesh the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-acr-01@Karen** [acronym]
  - heard:    `Our SAS margins are fine, the services margin is the problem.`
  - expected: `Our SaaS margins are fine, the services margin is the problem.`
  - missed: SaaS
- **a-acr-11@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR dock.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-03@Karen** [person]
  - heard:    `Lubenquame Mensa on the data pipeline.`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
  - missed: Kwame Mensah
- **a-person-04@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Shuo Yingjiao wrote the original matcha.`
  - output:   `Xiuying Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
- **a-person-09@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Khwame Mensas branch conflicts with the migration.`
  - output:   `Kwame Mensah branch conflicts with the migration.`
  - expected: `Kwame Mensah's branch conflicts with the migration.`
- **a-person-10@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunathan sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-03@Karen** [identifier]
  - heard:    `The user prompt "Submit hook" has to stay fast.`
  - expected: `The UserPromptSubmit hook has to stay fast.`
  - missed: UserPromptSubmit
- **a-ident-07@Karen** [identifier]
  - heard:    `Register user prompt, submit in the plugin hooks file.`
  - expected: `Register UserPromptSubmit in the plugin hooks file.`
  - missed: UserPromptSubmit
- **a-ident-08@Karen** [identifier]
  - heard:    `Harvest Reaper should skip node modules.`
  - expected: `harvestRepo should skip node modules.`
  - missed: harvestRepo
- **a-prose-10@Karen** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Karen** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Karen** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-13@Karen** [prose, expected-hard, negative]
  - heard:    `The playwright took a bow after the final curtain.`
  - output:   `The Playwright took a bow after the final curtain.`
  - expected: `The playwright took a bow after the final curtain.`
  - spurious: "playwright" -> "Playwright" (alias, 1.00)
- **a-prose-15@Karen** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)

## Failing clips: small.en + prompt (51)

- **a-brand-06@Samantha** [brand]
  - heard:    `Our ups-usage is way over the free tier.`
  - expected: `Our Upstash usage is way over the free tier.`
  - missed: Upstash
- **a-brand-11@Samantha** [brand, terms recovered, Whisper mangled another word]
  - heard:    `Anthropic released a new model, update the pricing dock.`
  - expected: `Anthropic released a new model, update the pricing doc.`
- **a-prod-08@Samantha** [product]
  - heard:    `Switch the build from Webpack to VEED.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-13@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Expose the search and point over GraphQL as well.`
  - expected: `Expose the search endpoint over GraphQL as well.`
- **a-prod-29@Samantha** [product, terms recovered, Whisper mangled another word]
  - heard:    `Use LevenshteinDistance for the fuzzy pass.`
  - expected: `Use Levenshtein distance for the fuzzy pass.`
- **a-acr-04@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Export to Lexicon as YAML, not JSON.`
  - expected: `Export the lexicon as YAML, not JSON.`
- **a-acr-11@Samantha** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR dock.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-05@Samantha** [person]
  - heard:    `Veyorn Halvorson is presenting at the offsite.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
  - missed: Bjørn Halvorsen
- **a-person-10@Samantha** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunathan sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-prose-10@Samantha** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Samantha** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Samantha** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-15@Samantha** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-06@Daniel** [brand]
  - heard:    `Powerups-Usages way over the free tier.`
  - expected: `Our Upstash usage is way over the free tier.`
  - missed: Upstash
- **a-brand-07@Daniel** [brand]
  - heard:    `Swap the deep grand key in the staging environment.`
  - expected: `Swap the Deepgram key in the staging environment.`
  - missed: Deepgram
- **a-brand-11@Daniel** [brand]
  - heard:    `and Thropic released a new model, update the pricing dock.`
  - expected: `Anthropic released a new model, update the pricing doc.`
  - missed: Anthropic
- **a-prod-04@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Ship the SQLite fallback for a flying mode.`
  - expected: `Ship the SQLite fallback for offline mode.`
- **a-prod-08@Daniel** [product]
  - heard:    `Switch the build from Webpack to Vit.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-12@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs a north-middle way.`
  - output:   `The tRPC router needs a north-middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-16@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Refresh the JWT when it has less than 5 minutes left.`
  - expected: `Refresh the JWT when it has less than five minutes left.`
- **a-prod-20@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka Consumer lag spiked off to the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-29@Daniel** [product, terms recovered, Whisper mangled another word]
  - heard:    `Use LevenshteinDistance for the fuzzy pass.`
  - expected: `Use Levenshtein distance for the fuzzy pass.`
- **a-acr-07@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Sync the CRM with the billing event nightly.`
  - expected: `Sync the CRM with the billing events nightly.`
- **a-acr-11@Daniel** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR dock.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-person-04@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Shoeing Zhao wrote the original matcha.`
  - output:   `Xiuying Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
- **a-person-05@Daniel** [person]
  - heard:    `Bion Halveson is presenting at the other side.`
  - expected: `Bjørn Halvorsen is presenting at the offsite.`
  - missed: Bjørn Halvorsen
- **a-person-10@Daniel** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunathan, sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-prose-10@Daniel** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Daniel** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Daniel** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-15@Daniel** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
- **a-brand-06@Karen** [brand]
  - heard:    `Allerupstash usage is way over the free tire.`
  - expected: `Our Upstash usage is way over the free tier.`
  - missed: Upstash
- **a-brand-11@Karen** [brand, terms recovered, Whisper mangled another word]
  - heard:    `Anthropik released a new model, update the pricing dock.`
  - output:   `Anthropic released a new model, update the pricing dock.`
  - expected: `Anthropic released a new model, update the pricing doc.`
- **a-prod-03@Karen** [product]
  - heard:    `Migrate the sessions table from PostGas to Redis.`
  - expected: `Migrate the sessions table from PostgreSQL to Redis.`
  - missed: PostgreSQL
- **a-prod-08@Karen** [product]
  - heard:    `Switch the build from Webpack to Veid.`
  - expected: `Switch the build from webpack to Vite.`
  - missed: Vite
- **a-prod-12@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `The TRPC router needs an OAuth middle way.`
  - output:   `The tRPC router needs an OAuth middle way.`
  - expected: `The tRPC router needs an auth middleware.`
- **a-prod-20@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Kafka consumer lagspiked after the deploy.`
  - expected: `Kafka consumer lag spiked after the deploy.`
- **a-prod-23@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `The Playwright tests a flaky on the build server.`
  - expected: `The Playwright tests are flaky on the build server.`
- **a-prod-26@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Run the evil locally with Ollama first.`
  - expected: `Run the eval locally with Ollama first.`
- **a-prod-31@Karen** [product, terms recovered, Whisper mangled another word]
  - heard:    `Keshe the Postgres query results in Redis for an hour.`
  - output:   `Keshe the PostgreSQL query results in Redis for an hour.`
  - expected: `Cache the PostgreSQL query results in Redis for an hour.`
- **a-acr-11@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Add the retention KPI to the OKR dock.`
  - expected: `Add the retention KPI to the OKR doc.`
- **a-acr-14@Karen** [acronym, terms recovered, Whisper mangled another word]
  - heard:    `Compare TTSLagency against the STT pipeline.`
  - expected: `Compare TTS latency against the STT pipeline.`
- **a-person-02@Karen** [person]
  - heard:    `Xiivhan Reilly owns the onboarding flow now.`
  - expected: `Siobhan Reilly owns the onboarding flow now.`
  - missed: Siobhan Reilly
- **a-person-03@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Lube and Kwame Mensah on the data pipeline.`
  - expected: `Loop in Kwame Mensah on the data pipeline.`
- **a-person-04@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Shouying Zhao wrote the original matcha.`
  - output:   `Xiuying Zhao wrote the original matcha.`
  - expected: `Xiuying Zhao wrote the original matcher.`
- **a-person-10@Karen** [person, terms recovered, Whisper mangled another word]
  - heard:    `Get Priyanka Raghunathan sign off on the schema.`
  - expected: `Get Priyanka Raghunathan's sign off on the schema.`
- **a-ident-04@Karen** [identifier, terms recovered, Whisper mangled another word]
  - heard:    `Add a dryrun flag to harvestRepo.`
  - expected: `Add a dry run flag to harvestRepo.`
- **a-prose-10@Karen** [prose, expected-hard, negative]
  - heard:    `There was a light drizzle all afternoon.`
  - output:   `There was a light Drizzle all afternoon.`
  - expected: `There was a light drizzle all afternoon.`
  - spurious: "drizzle" -> "Drizzle" (alias, 1.00)
- **a-prose-11@Karen** [prose, expected-hard, negative]
  - heard:    `The neon sign outside the diner finally got fixed.`
  - output:   `The Neon sign outside the diner finally got fixed.`
  - expected: `The neon sign outside the diner finally got fixed.`
  - spurious: "neon" -> "Neon" (alias, 1.00)
- **a-prose-12@Karen** [prose, expected-hard, negative]
  - heard:    `Please whisper, the baby is asleep.`
  - output:   `Please Whisper, the baby is asleep.`
  - expected: `Please whisper, the baby is asleep.`
  - spurious: "whisper" -> "Whisper" (alias, 1.00)
- **a-prose-15@Karen** [prose, expected-hard, negative]
  - heard:    `He can be a bit pedantic about commas.`
  - output:   `He can be a bit Pydantic about commas.`
  - expected: `He can be a bit pedantic about commas.`
  - spurious: "pedantic" -> "Pydantic" (phonetic, 0.90)
