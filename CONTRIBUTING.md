# Contributing to decisionkit

Thanks for helping. decisionkit is small on purpose: 7 source files, 2 runtime dependencies (bundled), and no framework. Contributions that keep it that way are the easiest to merge.

**Before you change code, read [AGENTS.md](AGENTS.md).** It has the layout, the commands and the hard rules. The most important rules:

- Never report a decision that didn't happen.
- Read only `DECISIONKIT_*` variables.
- Never log keys or prompt content.
- Make no claims that a benchmark doesn't support.

## Setup (2 minutes, no API keys)

```bash
git clone https://github.com/adityajha2005/decisionkit && cd decisionkit
npm ci
npm run check      # typecheck + 29 tests against local mock providers
```

You need Node ≥ 22 to run the tests (they run `.ts` directly). The published package itself runs on Node ≥ 20.

## Making a change

1. Keep the diff small and focused. Prefer the standard library over a new dependency.
2. Add or update a test. Every behavior change needs a test that fails without it.
3. `npm run check && npm run build`, and commit `dist/server.mjs` with any `src/` change. CI fails on a stale bundle.
4. If you touched `.claude-plugin/`, run `claude plugin validate --strict .claude-plugin/plugin.json`.
5. Update `CHANGELOG.md` under an "Unreleased" heading. Maintainers bump versions at release time.

### Adding a provider

A provider is an `Adapter` in `src/providers/` (see `src/schema.ts`). It is pure data mapping with no I/O:

- **`compile(questions, context, model)`:** the HTTP request body.
- **`parse(json, questions)`:** validate with Zod against the provider's **documented** response, and map to neutral answers. Throw `InvalidResponse` on any mismatch.
- **`classify(status, body)`:** map HTTP errors to an error kind, and say whether to retry.

Then:

1. Register it in `ADAPTERS` and `PRICES` (`src/decide.ts`), and in the config's key and base URL maps.
2. Add the option and its sensitive key setting to `.claude-plugin/plugin.json`.
3. Add tests:
   - a golden request body
   - a response fixture copied verbatim from the provider's docs, with source URL and date
   - error classification
   - the shared contract test (same request, same result shape)
4. Record the verified contract in `docs/ARCHITECTURE.md`, and mark anything you couldn't confirm as UNVERIFIED.

### Adding benchmark tasks

- **Add new tasks in a new task-set file;** never edit labels in an existing set after results exist.
- **Get every label checked blind** by someone who hasn't seen your answers. Rewrite or drop anything they find ambiguous.
- **Spread the answers out:** balance binary labels and shuffle the position of the correct rank candidate.
- **Update `bench/RESULTS.md` with the caveats,** and commit only the result files it cites.

## Pull request checklist

- [ ] `npm run check` passes, and `dist/` is rebuilt
- [ ] New behavior has a test
- [ ] No keys, `.env` or prompt content in code, logs, fixtures or results
- [ ] Docs updated (README for users, AGENTS.md for contributors, ARCHITECTURE.md for contracts)
- [ ] Any performance or accuracy claim links to a benchmark result

## To-do (open for contributors)

`good first issue` = small and self-contained, with no provider keys needed.

| Area | Task | |
|---|---|---|
| CLI | Accept level and option descriptions, e.g. `"SEV1: full outage or data loss"`. Bare labels give the model no rubric; a live `score` run split between SEV2 and SEV1 without one. | good first issue |
| CLI | `decisionkit batch`: read JSONL from stdin and decide every line in one process. This avoids the ~0.85 s cold start per call. | good first issue |
| CI | Add `windows-latest` to the test matrix, and fix any path issues | good first issue |
| Bundle | Shrink `dist/server.mjs` (~820 kB) by checking what the MCP SDK and Zod pull in | good first issue |
| Docs | Live-verify and document Cursor and VS Code setup (Codex is already done) | good first issue |
| Bench | More hard, blind-checked tasks (target n ≥ 300), then add reliability bins and ECE to measure calibration | |
| Providers | Verify TypeSafe's direct API (`api.typesafe.ai`) live. So far only the OpenRouter route is tested. | needs a TypeSafe key |
| Release | Publish from GitHub Actions with npm trusted publishing and provenance | |
| Claude Desktop | Ship an `.mcpb` bundle so the key is stored in the OS keychain instead of plaintext config | |
| Plugin | Verify keychain cleanup on uninstall, and the secure-store backend on Linux | |
| Providers | OpenAI image inputs (OpenAI only; needs a per-provider capability check) | |

Open an issue before starting anything large, so we can agree on the approach.

## Reporting bugs

Include:

- `decisionkit --help | head -1`
- your Node version
- the provider
- the output of `decisionkit status`, which shows setting **names** only, never values

Never paste API keys or private context into an issue.
