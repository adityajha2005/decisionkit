# AGENTS.md

Instructions for anyone, human or coding agent, changing decisionkit. Read this before editing. `README.md` is for users; this file is for contributors. For setup, the PR checklist and the open to-do list, see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

decisionkit is a provider-neutral client for **decision APIs** (OpenAI Decisions, Jev by TypeSafe AI, and Jev via OpenRouter). One bundle, `dist/server.mjs`, is three things:

- **The `decisionkit` CLI**, when run with a subcommand
- **An MCP server**, when run with no arguments
- **The Claude Code plugin's server**, via `.claude-plugin/plugin.json`

## Layout

| Path | What it is |
|---|---|
| `src/schema.ts` | Zod request schema, the neutral `Answer`/`DecideResult` types, and the `Adapter` contract |
| `src/providers/jev.ts` | Jev adapter (`jev`), plus `jevOpenRouter`: the same API at OpenRouter's path |
| `src/providers/openai.ts` | OpenAI Decisions adapter |
| `src/decide.ts` | Config loading, the `decide()` core (validation, rank fan‑out, deadline and retries, invariant checks, usage log), `status()`, the dated price table |
| `src/server.ts` | `serve()`: MCP tools `decide` and `status`, the server instructions, connection pre‑warm |
| `src/cli.ts` | `runCli()`: `binary`, `choice`, `score`, `rank`, `status` |
| `src/main.ts` | Entry point: no arguments → `serve()`, otherwise → `runCli()` |
| `dist/server.mjs` | esbuild bundle. **Committed**, because plugin installs don't run `npm install`. |
| `.claude-plugin/` | Plugin manifest (`userConfig`, `alwaysLoad`) and a single‑plugin marketplace |
| `test/` | `node:test` suites: unit (`decide`, `schema`), MCP stdio end‑to‑end (`server`), CLI end‑to‑end (`cli`), and a version check |
| `bench/` | `run.ts` (runner), `tasks/` (v1: 20, v2: 100), `results/` (raw v2 results, committed), `RESULTS.md` |
| `docs/ARCHITECTURE.md` | Design, verified provider contracts with sources, risk register, build status |

Adapters are pure data mappers: `compile`, `parse`, `classify`. All I/O (fetch, timeout, retry, logging) lives in `decide.ts`. Keep it that way.

## Commands

```bash
npm ci
npm run check    # tsc + all tests. Must pass before every commit.
npm run build    # rebuild dist/server.mjs. Commit it with any src/ change (CI fails on a stale dist/).
claude plugin validate --strict . && claude plugin validate --strict .claude-plugin/plugin.json
```

The tests need no API keys; they run against local mock HTTP servers. Node ≥ 22 runs `.ts` files directly (type stripping), so there's no build step for tests.

## Hard rules

1. **Never report a decision that didn't happen.**
   - Any failure, refusal or invalid provider response is `ok: false`: MCP `isError`, CLI exit code `2`.
   - No canned answers, test modes or fallbacks in shipped code. Tests use localhost mocks through `DECISIONKIT_BASE_URL`, which only accepts loopback addresses.
2. **Read config only from `DECISIONKIT_*` variables.** Never read a bare `OPENAI_API_KEY`, `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`: a key already in the user's shell must never be billed silently.
3. **No silent provider fallback,** and no default provider. Both providers cost money.
4. **Never log or echo keys or prompt content.**
   - Error messages pass through `scrub()`.
   - The usage log stores ids, counts, timings and cost only.
   - Tests assert both of these.
5. **Disclose the provider.** Every result names it, and the CLI prints it on stderr. In MCP mode, stdout is the protocol channel: log to stderr only.
6. **Verify provider contracts against the providers' docs, and date them.**
   - Don't invent endpoints, fields, model ids or prices.
   - Mark anything unconfirmed as UNVERIFIED in `docs/ARCHITECTURE.md`.
   - Copy test fixtures verbatim from the provider docs.
7. **No accuracy, cost or speed claims without a benchmark run that supports them.** `bench/RESULTS.md` is the source. State sample sizes and caveats, and never call probabilities "calibrated".
8. **Don't normalize what isn't comparable.**
   - Provider `confidence` stays under `native`.
   - `rank` is labelled `derived`.
   - Emulated features (OpenAI binary `criteria`) are noted in `notes`.

## Benchmarks

- Run only the task set you mean to: `--tasks tasks-v2.jsonl`. Results go to `bench/results/results-<set>-<system>-<date>.json`. Commit only the ones `RESULTS.md` cites. Scan them for secrets first; they should only ever contain ids, timings and costs.
- **Never relabel a task after seeing model answers.**
  - Flag ambiguous tasks and replace them in a new version, or re-check the labels blind.
  - v2 labels were checked by a blind annotator: it agreed on 99/100, and 11 debatable tasks were rewritten until a fresh blind check rated them clear.
- **Baselines:** `--claude` runs `claude -p` with settings, MCP servers, tools and session saving turned off. Its cost includes Claude Code's ~3.5k‑token system prompt. Use `--anthropic` (optionally `--via-openrouter`) for a fair direct‑API comparison.
- Keys live in a gitignored `.env` and are loaded with `node --env-file=.env`. Never commit `.env`, and never print key values.

## Releasing

1. Bump the version in **all three places**: `package.json`, `.claude-plugin/plugin.json`, and `VERSION` in `src/server.ts`. `test/version.test.ts` fails if they differ.
2. Update `CHANGELOG.md`, and the pinned version in the README install line.
3. `npm run check && npm run build`, then commit and push; CI must be green.
4. Publish from a normal terminal: `npm publish --access public`. npm's 2FA browser approval can't finish inside a non-interactive shell. `prepublishOnly` rebuilds and reruns the tests first.
   - The npm package is **`@adxtya21/decisionkit`**: npm rejected the unscoped `decisionkit` as too close to `decision-kit`.
   - The installed command is `decisionkit`.
   - Published versions are immutable, so fixes need a new patch version.

## Gotchas we hit

- **`AbortSignal.timeout()` needs an integer.** Jittered backoff made it fractional, and every retry failed as a "network" error.
- **Don't use `spawnSync` in tests that also host the mock server.** It blocks the event loop, and the test deadlocks into a timeout. Use async `spawn`.
- **Codex** starts MCP servers with an empty environment (`env_vars` forwards keys), and `codex exec` blocks MCP calls that need approval (`tools.<name>.approval_mode = "approve"`).
- **Gemini CLI** strips inherited `*KEY*` variables.
- **Plugin `userConfig`:**
  - Blank values arrive as `""`, which `unset()` handles.
  - A CLI install doesn't prompt for settings; use `/plugin configure` or `--config`.
  - Sensitive values go to the OS keychain, never `settings.json`.
- **OpenRouter has two different Jev products.** `typesafe/jev-router` is a chat-model router, not the decision API. The decision API is `/api/v1/systemone` with model `~typesafe/jev-latest` or `typesafe/jev-1.13`.
- **`claude --allowedTools` is variadic** and swallows a trailing prompt argument. Pass the prompt on stdin.
