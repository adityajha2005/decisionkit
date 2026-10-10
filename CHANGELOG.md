# Changelog

## 0.2.1 (2026-10-10)

- Fix: when the usage log is off, `status` now reports `"logging off"` instead of totals from another process's shared log (found by an isolated install test of 0.2.0).
- The npm page now shows the restructured README (quickstart, troubleshooting).

## 0.2.0 (2026-10-10)

First npm release, as `@adxtya21/decisionkit`. The installed command is `decisionkit`.

- **CLI:** `decisionkit binary | choice | score | rank | status`.
  - Context comes from stdin or `--context`.
  - grep-style exit codes; `--threshold`, `--json` and `--quiet`.
  - The provider, latency and cost are disclosed on stderr.
  - With no arguments, `decisionkit` is still the MCP server.
- **New provider `openrouter`:** Jev's decision API served by OpenRouter (`DECISIONKIT_OPENROUTER_API_KEY`). It uses OpenRouter's reported cost, and HTTP 402 maps to `quota`.
- **Latency:**
  - The provider connection is opened at server startup (removes a ~1.7 s first call).
  - The plugin loads the tool up front (`alwaysLoad`): 3 → 2 Claude turns on first use.
- **Benchmarks:** 100 blind-checked tasks; results in `bench/RESULTS.md`.

## 0.1.0 (2026-10-10)

- MCP server and Claude Code plugin with `decide` and `status` tools.
- Jev and OpenAI Decisions adapters: neutral `binary` / `choice` / `score` questions plus derived `rank`.
- Zod validation, deadline-bounded retries, typed errors, `DECISIONKIT_*`-only config, and a usage log with no prompt content.
