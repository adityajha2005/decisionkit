# Benchmark results (2026-10-10)

The same tasks went to two decision APIs through decisionkit and to Claude Haiku 5.5 asked directly. The raw per-task results are in `results-*.json` next to this file.

**Read this first:**
- The tasks are hand-written software-engineering decisions, so they are not a general benchmark.
- With n = 100, accuracy differences of a few points are noise. The 95% confidence intervals overlap.
- Nothing here shows that one system is more accurate than another.

## Task set v2: 100 tasks (`tasks-v2.jsonl`, the headline set)

There are 25 tasks of each type:
- **binary:** breaking API change? needs a DB migration?
- **choice:** work-item kind (6 options), owning team (5 options)
- **score:** code-review severity, incident severity
- **rank:** the most relevant file for a bug, with plausible distractors. Answer positions are shuffled.

Labels were checked by a blind second annotator. It agreed with 99 of the 100 original labels. It flagged 11 tasks as debatable, and those were rewritten until a fresh blind check rated them clear. The generator is `gen_tasks_v2.py`.

| System | Model | Correct | 95% CI | Brier | Median latency | p95 | Cost, 100 tasks |
|---|---|---|---|---|---|---|---|
| decisionkit → OpenAI Decisions API | `gpt-6-luna` | 99 | 95–100 | 0.007 | 135 ms | 216 ms | $0.0028 |
| decisionkit → Jev via OpenRouter | `~typesafe/jev-latest` (jev-1.13) | 97 | 92–99 | 0.025 | 524 ms | 588 ms | $0.0018 |
| Haiku 5.5, Messages API via OpenRouter | `anthropic/claude-haiku-5.5`, effort low, enum-constrained output | 97 | 92–99 | — | 1,803 ms | 2,482 ms | $0.0045 |
| Haiku 5.5 via Claude Code (`claude -p`) | `claude-haiku-5-5` | 95 | 89–98 | — | 3,998 ms | 5,090 ms | $0.0208 |

What the table shows:
- **Cost.** Against Haiku called directly, Jev was about 2.5x cheaper and OpenAI Decisions about 1.6x cheaper on these tasks.
  - The `claude -p` row costs about 4.6x more than direct Haiku, because every call carries Claude Code's own ~3.5k-token system prompt.
  - Comparing against `claude -p` overstates the decision APIs' advantage.
- **Latency.**
  - OpenAI Decisions was about 13x faster than direct Haiku, and Jev about 3.4x.
  - Haiku's figure includes its default adaptive thinking at low effort.
  - Jev's figure includes the OpenRouter hop; TypeSafe's direct API was not measured.
  - `claude -p` latency includes starting a process for every task.
- **Probabilities.** Only the decision APIs return a probability per answer. Brier score (lower is better) is reported only for them.
- **Misses.**
  - OpenAI: r02.
  - Jev: s13, i07, r12.
  - Haiku direct: s13, i03, i07.
  - Severity scoring (s, i) is the hardest category for every system.

## Task set v1: 20 tasks (`tasks.jsonl`, the first smoke test)

| System | Correct | Cost, 20 tasks | Median latency |
|---|---|---|---|
| OpenAI Decisions (`gpt-6-luna`) | 19 | $0.0005 | 219 ms |
| Jev via OpenRouter (jev-1.13) | 18 | $0.00033 | 514 ms |
| Haiku 5.5 via `claude -p` | 18 | $0.004 | 3.7 s |

v1 task brk-5 has a debatable label; every system "missed" it.

## Method

- **Same prompt for both Haiku baselines:** the context, the question, and "Answer with exactly one of: …". The direct-API run also constrains the answer with a structured-output enum.
- **Cost:**
  - Decision APIs: provider-reported where available (OpenRouter `usage.cost`), otherwise tokens × the dated price table in `src/decide.ts`.
  - Direct Haiku: tokens × $0.10 / $0.50 per 1M (input / output).
  - `claude -p`: its reported `total_cost_usd`.
- **Confidence intervals:** Wilson 95% intervals on accuracy.
- **Isolation:** the `claude -p` baseline runs with no user settings, hooks, plugins, MCP servers or tools, and no session persistence.

Reproduce:

```bash
DECISIONKIT_PROVIDER=openai     node --env-file=.env bench/run.ts --tasks tasks-v2.jsonl
DECISIONKIT_PROVIDER=openrouter node --env-file=.env bench/run.ts --tasks tasks-v2.jsonl
node --env-file=.env bench/run.ts --anthropic --via-openrouter --tasks tasks-v2.jsonl
node bench/run.ts --claude --tasks tasks-v2.jsonl
```

## Where the latency goes (2026-10-10)

| Component | Time |
|---|---|
| decisionkit itself (validation, mapping, response checks), against a localhost mock, 200 calls | 0.25 ms median, 0.7 ms p95 |
| Provider round trip, warm (OpenAI Decisions / Jev via OpenRouter) | 135 ms / 524 ms median |
| First call on a cold connection (DNS + TLS) | up to ~1.7 s. **Removed:** the server now opens the connection at startup. |
| One headless Claude Code session (Haiku) that calls `status` and `decide` | 23.5 s total, of which 22.3 s was Claude's own model time. `decide` took 562 ms. |

**In Claude Code, the agent's own turns dominate.** Tool loading made a measurable difference:

- **Setup:** one `decide` task, Haiku, mock provider, 3 runs each.
- **Tools loaded on demand (the default):** 3 turns, 4.6 s median.
- **`alwaysLoad: true`:** 2 turns, 3.6 s median.
- **Why:** with `alwaysLoad`, Claude skips the tool-search turn. The plugin now sets it.
