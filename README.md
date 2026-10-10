# decisionkit

A provider-neutral **decision tool** for Claude Code and any other MCP client. Your agent asks closed-form questions about a piece of text. A specialized decision API answers with probabilities:

- **Jev** by TypeSafe AI — `POST api.typesafe.ai/v1/systemone`
- **OpenAI Decisions API** (public beta) — `POST api.openai.com/v1/decisions`

> **Requires Node.js ≥ 20 on your `PATH`.** Claude Code's native installer doesn't include Node. If the server shows as failed in `/mcp`, this is the usual cause.

## What it sends, and to whom

Every `decide` call sends the `context` and questions that your agent writes **to the provider you selected**. Each result names that provider and model.

- Nothing is sent anywhere else.
- Nothing is sent automatically. decisionkit only runs when the agent chooses to call the tool.
- In Claude Code, each call shows you the payload in a permission prompt. Some other clients auto-approve tools; check yours.
- Don't let the agent send secrets, credentials, personal data or code you haven't cleared for a third party. The tool's description tells the agent the same.

## What you get back

| Question type | You get |
|---|---|
| `binary` | `probability_true` |
| `choice` (2–255 options) | `choice` plus a probability per option |
| `score` (2–10 ordered levels) | `expected_level` (0-based, probability-weighted), `most_likely`, a probability per level |
| `rank` (2–20 candidates) | Candidates sorted by score. **Derived** from one score question per candidate, so treat close values as ties. |

What the results do and don't promise:

- **Probabilities are the provider's estimates.** They haven't been verified as calibrated for your task; choose thresholds with your own labeled data.
- **There is no rationale.** Neither provider returns one, and decisionkit never invents one.
- Provider-specific fields (such as `confidence`) are kept under `native`.
- Failures, refusals and invalid provider responses always come back as errors (`isError`). They are never presented as a decision.

## Install: Claude Code

```bash
claude plugin marketplace add adityajha2005/decisionkit
claude plugin install decisionkit@decisionkit
```

Then run `/plugin configure decisionkit@decisionkit` inside Claude Code. Pick a **provider** (required, no default) and paste that provider's API key. Keys are masked and stored in your OS secure store. You can change the other settings later in `/config`.

| Setting | Notes |
|---|---|
| `provider` | `jev` or `openai` |
| `typesafe_api_key` / `openai_api_key` | Only the selected provider's key is used. Your shell's `OPENAI_API_KEY` is **never** read. |
| `model` | Blank means the default: `jev-latest` or `gpt-6-luna` |
| `timeout_ms` | Total time per decision, including retries. Default 15000. |
| `usage_log` | Local JSONL of ids, timings, tokens and estimated cost. Never prompt content. |

**Check it:** run `/decisionkit:status`, or ask Claude to call the `status` tool. It reports the provider, model, a free connectivity check (`GET /v1/models`) and usage totals.

**Remove it:** `claude plugin uninstall decisionkit@decisionkit`. This deletes the usage log along with the plugin.

**Fewer prompts (optional):** if you're comfortable sending context without a prompt each time, add the tool to `permissions.allow` in your settings. Claude Code names plugin tools `mcp__plugin_decisionkit_decisionkit__decide`; confirm the exact name in `/mcp` before adding it.

## Install: other AI apps (any model)

The same server ships on npm. Install it once, with a pinned version:

```bash
npm i -g decisionkit@0.1.0
```

In every client, decisionkit reads **only** `DECISIONKIT_*` variables:

- `DECISIONKIT_PROVIDER`: `jev` or `openai`
- `DECISIONKIT_TYPESAFE_API_KEY` or `DECISIONKIT_OPENAI_API_KEY`
- `DECISIONKIT_MODEL`, `DECISIONKIT_TIMEOUT_MS`, `DECISIONKIT_USAGE_LOG` (optional)

Put the key in your shell profile and reference it from the client config. Writing it into the config file stores it in plaintext.

<details><summary><b>Codex CLI</b> — <code>~/.codex/config.toml</code></summary>

Codex starts MCP servers with an **empty environment**, so the key must be forwarded explicitly with `env_vars`.

```toml
[mcp_servers.decisionkit]
command = "decisionkit"
env = { DECISIONKIT_PROVIDER = "openai" }
env_vars = ["DECISIONKIT_OPENAI_API_KEY"]
startup_timeout_sec = 30
```
</details>

<details><summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code></summary>

```json
{ "mcpServers": { "decisionkit": {
  "command": "decisionkit",
  "env": { "DECISIONKIT_PROVIDER": "openai", "DECISIONKIT_OPENAI_API_KEY": "${env:DECISIONKIT_OPENAI_API_KEY}" } } } }
```
</details>

<details><summary><b>VS Code / GitHub Copilot</b> — <code>.vscode/mcp.json</code></summary>

VS Code prompts for the key and stores it itself.

```json
{
  "inputs": [{ "type": "promptString", "id": "dk-key", "description": "decisionkit provider API key", "password": true }],
  "servers": { "decisionkit": { "type": "stdio", "command": "decisionkit",
    "env": { "DECISIONKIT_PROVIDER": "openai", "DECISIONKIT_OPENAI_API_KEY": "${input:dk-key}" } } }
}
```
</details>

<details><summary><b>Gemini CLI</b> — <code>~/.gemini/settings.json</code></summary>

Gemini CLI strips inherited variables whose names contain `KEY`, so the key must be listed in `env`.

```json
{ "mcpServers": { "decisionkit": { "command": "decisionkit",
  "env": { "DECISIONKIT_PROVIDER": "openai", "DECISIONKIT_OPENAI_API_KEY": "$DECISIONKIT_OPENAI_API_KEY" } } } }
```
</details>

<details><summary><b>Claude Desktop, Windsurf, Zed</b></summary>

- **Claude Desktop** (`claude_desktop_config.json`, key `mcpServers`) and **Zed** (`settings.json`, key `context_servers`): these take the key as plaintext in `env`. A keychain-backed Claude Desktop bundle is planned.
- **Windsurf** (`mcp_config.json`, key `mcpServers`): supports `${env:DECISIONKIT_OPENAI_API_KEY}`.
</details>

Then ask your agent to call `status`. The `env_vars_seen` field lists which `DECISIONKIT_*` names actually reached the server (names only, never values).

## Example

> "Triage these five issues with decisionkit: bug, feature, refactor or docs? Flag anything under 70% probability for me to check."

The agent sends something like this:

```json
{ "context": "Issue #412: Clicking 'Export CSV' on /reports returns HTTP 500 since v2.3…",
  "questions": [
    { "id": "kind", "type": "choice", "instructions": "What kind of work item is this?",
      "options": [{ "value": "bug" }, { "value": "feature" }, { "value": "refactor" }, { "value": "docs" }] },
    { "id": "needs_migration", "type": "binary", "instructions": "Does fixing this likely require a database migration?" } ] }
```

## Cost and limits

- **Price as of 2026-10-10:** Jev $0.042 and OpenAI $0.10 per 1M input tokens; neither charges for output. `status` reports estimated cost from this table. The OpenAI figure is a lower bound, since regional and long-context multipliers aren't modeled.
- **Retries:** up to 3 attempts, only for rate limits, overloads and network errors. `Retry-After` is honored, and nothing is retried past the timeout. Every retry is billed.
- **No savings claims.** We make no claim that this is cheaper, faster or more accurate than asking your agent directly. `bench/` measures that, and results will be published with their sample sizes.

## Development

```bash
npm ci
npm run check      # typecheck + tests (unit + stdio end-to-end against a mock provider)
npm run build      # bundles src/ into dist/server.mjs (committed: plugin installs don't run npm install)
node bench/run.ts  # with DECISIONKIT_* set; or --claude for the baseline
```

See `docs/ARCHITECTURE.md` for the design, the verified provider contracts and the risk register.

## License

MIT. Not affiliated with TypeSafe AI, OpenAI or Anthropic.
