# Changelog

## 0.4.0 (2026-10-10)

- **New provider `claude`: use your Claude Code subscription, no API key.**
  - Answers come from `claude -p` with the user's own login, isolated per call: no tools, MCP servers, settings or saved session.
  - A short system prompt keeps input around 1.2k tokens instead of Claude Code's ~3.5k.
  - `ANTHROPIC_API_KEY` is stripped from the child process, so a shell key can't move it off the subscription.
  - The prompt goes over stdin, never argv.
  - Probabilities are Claude's **self-reported** estimates, and every result says so. Cost is reported as "your Claude plan" (`null`).
  - About 4–5 s per call; the default timeout is 30 s.
- The plugin lists `claude` as the first provider option.

## 0.3.0 (2026-10-10)

- **Formatted CLI view at a terminal:** the question as a header, a probability bar per option with the winner highlighted, and a dim footer with the provider, model, latency and cost.
  - Piped or scripted output is unchanged (`bug 0.94`).
  - `--plain` / `--pretty` force either view.
  - `NO_COLOR` disables color.
- `rank` bars use the absolute 0–4 relevance scale, so a weak winner never looks strong.

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
