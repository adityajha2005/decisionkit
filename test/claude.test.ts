// The "claude" provider runs `claude -p`. Here a fake `claude` on PATH stands in for it: no login, no quota.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { decide, loadConfig } from "../src/decide.ts";

const dir = mkdtempSync(join(tmpdir(), "fakeclaude-"));
const LOG = join(dir, "calls.jsonl");
const realPath = process.env.PATH;

before(() => {
  writeFileSync(join(dir, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
let stdin = ""; process.stdin.on("data", (d) => (stdin += d)).on("end", () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ args, hasKey: !!process.env.ANTHROPIC_API_KEY, claudecode: process.env.CLAUDECODE ?? null, stdin }) + "\\n");
  const mode = process.env.FAKE_CLAUDE_MODE;
  if (mode === "auth") { console.log(JSON.stringify({ is_error: true, api_error_status: 401, result: "Not logged in. Run /login" })); process.exit(1); }
  if (mode === "stray") { console.log(JSON.stringify({ structured_output: { answers: [{ key: "q0", probabilities: { banana: 1 } }] } })); return; }
  console.log(JSON.stringify({
    structured_output: { answers: [
      { key: "q0", probabilities: { bug: 0.9, feature: 0.06, docs: 0.06 } },   // sums to 1.02: renormalized
      { key: "q1", probabilities: { true: 0.2, false: 0.8 } },
      { key: "q2", probabilities: { low: 0.1, mid: 0.3, high: 0.6 } },
    ] },
    usage: { input_tokens: 2, cache_creation_input_tokens: 1200, output_tokens: 90 },
    modelUsage: { "claude-haiku-5-5": {} },
  }));
});
`);
  chmodSync(join(dir, "claude"), 0o755);
  process.env.PATH = `${dir}${delimiter}${realPath}`;
});
after(() => { process.env.PATH = realPath; delete process.env.FAKE_CLAUDE_MODE; });

const req = {
  context: "Export CSV returns HTTP 500 since v2.3",
  questions: [
    { id: "kind", type: "choice", instructions: "Kind?", options: [{ value: "bug" }, { value: "feature" }, { value: "docs" }] },
    { id: "migration", type: "binary", instructions: "Needs a DB migration?" },
    { id: "sev", type: "score", instructions: "Severity?", levels: [{ label: "low" }, { label: "mid" }, { label: "high" }] },
  ],
};
const cfg = () => loadConfig({ DECISIONKIT_PROVIDER: "claude", DECISIONKIT_USAGE_LOG: "false", PATH: process.env.PATH });

test("claude: no key needed; answers mapped, renormalized, labeled self-reported, cost null", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-be-used";
  process.env.CLAUDECODE = "1";
  try {
    const c = cfg();
    assert.ok(!("error" in c));
    assert.equal(c.model, "haiku");
    assert.equal(c.timeoutMs, 30000);
    const r = await decide(req, c);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.provider, "claude");
    assert.equal(r.model, "claude-haiku-5-5");
    assert.equal(r.estimated_cost_usd, null);
    assert.match(r.notes[1]!, /self-reported/);
    const kind = r.answers.kind as { choice: string; probabilities: Record<string, number> };
    assert.equal(kind.choice, "bug");
    assert.ok(Math.abs(Object.values(kind.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.equal((r.answers.migration as { probability_true: number }).probability_true, 0.2);
    assert.ok(Math.abs((r.answers.sev as { expected_level: number }).expected_level - 1.5) < 1e-9);
    assert.equal(r.usage.input_tokens, 1202);

    const call = JSON.parse(readFileSync(LOG, "utf8").trim().split("\n").at(-1)!);
    assert.equal(call.hasKey, false, "ANTHROPIC_API_KEY must not reach claude -p (it would bypass the subscription)");
    assert.equal(call.claudecode, null);
    assert.match(call.stdin, /Export CSV returns HTTP 500/);
    assert.ok(!call.args.join(" ").includes("Export CSV"), "the prompt goes over stdin, never argv");
    for (const flag of ["--json-schema", "--strict-mcp-config", "--no-session-persistence", "--system-prompt"]) assert.ok(call.args.includes(flag), flag);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDECODE;
  }
});

test("claude: not logged in is an auth error, tried once", async () => {
  process.env.FAKE_CLAUDE_MODE = "auth";
  const before = readFileSync(LOG, "utf8").split("\n").filter(Boolean).length;
  const r = await decide(req, cfg());
  delete process.env.FAKE_CLAUDE_MODE;
  assert.equal(!r.ok && r.error.kind, "auth");
  assert.equal(readFileSync(LOG, "utf8").split("\n").filter(Boolean).length - before, 1);
});

test("claude: an answer outside the allowed options is rejected", async () => {
  process.env.FAKE_CLAUDE_MODE = "stray";
  const r = await decide(req, cfg());
  delete process.env.FAKE_CLAUDE_MODE;
  assert.equal(!r.ok && r.error.kind, "provider_response_invalid");
});

test("claude: missing CLI is a config error", () => {
  const c = loadConfig({ DECISIONKIT_PROVIDER: "claude", PATH: "/nonexistent" });
  assert.match((c as { error: string }).error, /claude CLI is not on PATH/);
});
