import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, loadConfig } from "../src/decide.ts";
import { config, fake, KEY, JEV_CHOICE_RESPONSE, OPENAI_CHOICE_RESPONSE, choiceRequest } from "./helpers.ts";

const JEV_VALUES = ["billing", "technical", "sales"];
const OPENAI_VALUES = ["billing", "technical", "shipping", "other"];

test("jev: builds the documented request body and normalizes the doc example", async () => {
  const f = fake([{ body: JEV_CHOICE_RESPONSE }]);
  const r = await decide(choiceRequest(JEV_VALUES), config("jev"), f.deps);
  assert.equal(f.calls[0]!.url, "http://127.0.0.1:1/v1/systemone");
  assert.equal((f.calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  assert.deepEqual(f.calls[0]!.body, {
    state: "Help! My payouts have been failing for 3 days.", model: "jev-latest",
    questions: { q0: { type: "choice", instructions: "Which team should handle this?", criteria: { billing: null, technical: null, sales: null } } },
  });
  assert.ok(r.ok);
  assert.equal(r.provider, "jev");
  assert.equal(r.model, "jev-1.13.0");
  assert.deepEqual(r.answers.department, { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12, sales: 0 }, native: { confidence: 0.81 } });
  assert.deepEqual(r.usage, { input_tokens: 318, output_tokens: 34 });
  assert.ok(Math.abs(r.estimated_cost_usd! - 318 * 0.042 / 1e6) < 1e-12);
  assert.match(r.notes[0]!, /Jev/);
});

test("openai: builds the documented request body and normalizes the doc example", async () => {
  const f = fake([{ body: OPENAI_CHOICE_RESPONSE }]);
  const r = await decide(choiceRequest(OPENAI_VALUES), config("openai"), f.deps);
  assert.equal(f.calls[0]!.url, "http://127.0.0.1:1/v1/decisions");
  assert.deepEqual(f.calls[0]!.body, {
    model: "gpt-6-luna", input: "Help! My payouts have been failing for 3 days.",
    questions: [{ type: "choice", name: "q0", instructions: "Which team should handle this?", choices: OPENAI_VALUES.map((value) => ({ value })) }],
  });
  assert.ok(r.ok);
  assert.equal(r.answers.department!.type, "choice");
  assert.deepEqual(r.answers.department, { type: "choice", choice: "billing", probabilities: { billing: 0.95, technical: 0.02, shipping: 0.01, other: 0.02 }, native: { confidence: 0.93 } });
});

test("provider switching: same request, same result shape on both providers", async () => {
  const req = {
    context: "ctx",
    questions: [
      { id: "flag", type: "binary", instructions: "Is it urgent?", criteria: { true: "customer blocked" } },
      { id: "sev", type: "score", instructions: "Severity?", levels: [{ label: "low" }, { label: "mid" }, { label: "high", description: "outage" }] },
    ],
  };
  const jevR = await decide(req, config("jev"), fake([{ body: { model: "jev-1.13.0", usage: { input_tokens: 10 }, answers: {
    q0: { type: "noul", noul: 0.7 }, q1: { type: "score", score: 1.1, legend: {}, probabilities: { "0": 0.1, "1": 0.7, "2": 0.2 }, confidence: 0.5 } } } }]).deps);
  const f = fake([{ body: { model: "gpt-6-luna", usage: { input_tokens: 10 }, answers: [
    { type: "predicate", name: "q0", probability: 0.7 },
    { type: "score", name: "q1", score: 1.1, probabilities: [{ value: 0, label: "low", probability: 0.1 }, { value: 1, label: "mid", probability: 0.7 }, { value: 2, label: "high", probability: 0.2 }], confidence: 0.5 }] } }]);
  const oaR = await decide(req, config("openai"), f.deps);
  assert.ok(jevR.ok && oaR.ok);
  assert.deepEqual(jevR.answers, oaR.answers);
  assert.deepEqual(oaR.answers.sev, { type: "score", expected_level: 1.1, most_likely: "mid", probabilities: { low: 0.1, mid: 0.7, high: 0.2 }, native: { confidence: 0.5 } });
  // OpenAI predicates have no criteria field: folded into the text, and disclosed.
  assert.equal(f.calls[0]!.body.questions[0].instructions, "Is it urgent?\nTrue means: customer blocked");
  assert.ok(oaR.notes.some((n) => /criteria/.test(n)));
  assert.ok(!jevR.notes.some((n) => /criteria/.test(n)));
});

test("rank fans out into score questions and reassembles sorted", async () => {
  const req = { context: "bug: export fails", questions: [{ id: "files", type: "rank", instructions: "How relevant is this file to the bug?",
    candidates: [{ id: "a", text: "csv_writer.py" }, { id: "b", text: "README.md" }, { id: "c", text: "export_view.py" }] }] };
  const score = (s: number) => ({ type: "score", score: s, probabilities: { "0": 0.2, "1": 0.2, "2": 0.2, "3": 0.2, "4": 0.2 } });
  const f = fake([{ body: { model: "jev-1.13.0", usage: { input_tokens: 50 }, answers: { q0: score(3.6), q1: score(0.2), q2: score(2.9) } } }]);
  const r = await decide(req, config("jev"), f.deps);
  assert.equal(Object.keys(f.calls[0]!.body.questions).length, 3);
  assert.match(f.calls[0]!.body.questions.q2.instructions, /Candidate: export_view.py/);
  assert.ok(r.ok);
  assert.deepEqual(r.answers.files, { type: "rank", derived: true, ranking: [
    { candidate_id: "a", expected_level: 3.6 }, { candidate_id: "c", expected_level: 2.9 }, { candidate_id: "b", expected_level: 0.2 }] });
  assert.ok(r.notes.some((n) => /derived/.test(n)));
});

test("invalid provider responses are never reported as success", async () => {
  const cases: unknown[] = [
    { ...JEV_CHOICE_RESPONSE, answers: {} },                                                                           // missing answer
    { ...JEV_CHOICE_RESPONSE, answers: { q0: { ...JEV_CHOICE_RESPONSE.answers.q0, choice: "marketing" } } },         // choice not offered
    { ...JEV_CHOICE_RESPONSE, answers: { q0: { ...JEV_CHOICE_RESPONSE.answers.q0, probabilities: { billing: 1.5 } } } }, // p > 1
    { ...JEV_CHOICE_RESPONSE, answers: { q0: { ...JEV_CHOICE_RESPONSE.answers.q0, probabilities: { billing: 0.5, technical: 0.1 } } } }, // Σp ≠ 1
    { ...JEV_CHOICE_RESPONSE, answers: { q0: { type: "noul", noul: 0.5 } } },                                         // wrong type
    { model: "jev-1.13.0" },                                                                                           // no answers
    "<html>gateway</html>",                                                                                            // non-JSON
  ];
  for (const body of cases) {
    const r = await decide(choiceRequest(JEV_VALUES), config("jev"), fake([{ body }]).deps);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(!r.ok && r.error.kind, "provider_response_invalid");
  }
});

test("openai refusal is an error, with any other answers attached", async () => {
  const r = await decide(choiceRequest(OPENAI_VALUES), config("openai"), fake([{ body: { model: "gpt-6-luna", usage: { input_tokens: 5 }, answers: [{ type: "refusal", name: "q0" }] } }]).deps);
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "refused");
  assert.deepEqual(r.answers, { department: { type: "refused" } });
});

test("401: auth error, no retry, key never echoed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dk-"));
  const f = fake([{ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}` } } }]);
  const r = await decide(choiceRequest(OPENAI_VALUES), config("openai", { usageLog: true, dataDir: dir }), f.deps);
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "auth");
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(r).includes(KEY));
  const log = readFileSync(join(dir, "usage.jsonl"), "utf8");
  assert.ok(!log.includes(KEY) && !log.includes("payouts"), "usage log must hold no key and no context");
  assert.equal(JSON.parse(log).error_kind, "auth");
});

test("429 with Retry-After is retried, then succeeds", async () => {
  const f = fake([{ status: 429, headers: { "retry-after": "1" } }, { body: JEV_CHOICE_RESPONSE }]);
  const r = await decide(choiceRequest(JEV_VALUES), config("jev"), f.deps);
  assert.ok(r.ok);
  assert.equal(r.attempts, 2);
  assert.deepEqual(f.sleeps, [1000]);
});

test("retries are capped at 3 attempts", async () => {
  const f = fake([{ status: 529 }]);
  const r = await decide(choiceRequest(JEV_VALUES), config("jev", { timeoutMs: 60000 }), f.deps);
  assert.ok(!r.ok);
  assert.equal(r.error.kind, "overloaded");
  assert.equal(f.calls.length, 3);
});

test("non-retryable statuses are not retried", async () => {
  for (const [status, kind, provider, body] of [
    [422, "invalid_request", "jev", {}], [400, "invalid_request", "openai", {}],
    [429, "quota", "openai", { error: { code: "insufficient_quota", message: "out of credit" } }],
  ] as const) {
    const f = fake([{ status, body }]);
    const r = await decide(choiceRequest(JEV_VALUES), config(provider), f.deps);
    assert.equal(!r.ok && r.error.kind, kind);
    assert.equal(f.calls.length, 1, `${status} must not retry`);
  }
});

test("no retry when the backoff would pass the deadline", async () => {
  const f = fake([{ status: 429, headers: { "retry-after": "30" } }, { body: JEV_CHOICE_RESPONSE }]);
  const r = await decide(choiceRequest(JEV_VALUES), config("jev", { timeoutMs: 5000 }), f.deps);
  assert.equal(!r.ok && r.error.kind, "rate_limited");
  assert.equal(f.calls.length, 1);
});

test("a hanging provider times out within the deadline", async () => {
  const f = fake(["hang"]);
  f.deps.now = Date.now; // real clock for the real AbortSignal timer
  const t = Date.now();
  const r = await decide(choiceRequest(JEV_VALUES), config("jev", { timeoutMs: 1000 }), f.deps);
  assert.equal(!r.ok && r.error.kind, "timeout");
  assert.ok(Date.now() - t < 1500);
});

test("network errors retry, then report network", async () => {
  const f = fake([new TypeError("fetch failed")]);
  const r = await decide(choiceRequest(JEV_VALUES), config("jev", { timeoutMs: 60000 }), f.deps);
  assert.equal(!r.ok && r.error.kind, "network");
  assert.equal(f.calls.length, 3);
});

test("config: provider required, provider key required, ambient keys ignored", async () => {
  assert.match((loadConfig({}) as { error: string }).error, /No provider/);
  assert.match((loadConfig({ DECISIONKIT_PROVIDER: "gemini" }) as { error: string }).error, /must be/);
  assert.match((loadConfig({ DECISIONKIT_PROVIDER: "openai", OPENAI_API_KEY: "sk-ambient" }) as { error: string }).error, /DECISIONKIT_OPENAI_API_KEY is not set/);
  // Unset plugin userConfig may arrive as a literal placeholder.
  assert.ok("error" in loadConfig({ DECISIONKIT_PROVIDER: "jev", DECISIONKIT_TYPESAFE_API_KEY: "${user_config.typesafe_api_key}" }));
  assert.ok("error" in loadConfig({ DECISIONKIT_PROVIDER: "jev", DECISIONKIT_TYPESAFE_API_KEY: "k", DECISIONKIT_BASE_URL: "https://evil.example" }));
  assert.ok("error" in loadConfig({ DECISIONKIT_PROVIDER: "jev", DECISIONKIT_TYPESAFE_API_KEY: "k", DECISIONKIT_TIMEOUT_MS: "5" }));

  const c = loadConfig({ DECISIONKIT_PROVIDER: "openai", DECISIONKIT_OPENAI_API_KEY: "k", DECISIONKIT_MODEL: "${user_config.model}", DECISIONKIT_TIMEOUT_MS: "", XDG_STATE_HOME: "/x" });
  assert.ok(!("error" in c));
  assert.equal(c.model, "gpt-6-luna");
  assert.equal(c.timeoutMs, 15000);
  assert.equal(c.dataDir, "/x/decisionkit");
  assert.equal(c.usageLog, true);

  const r = await decide(choiceRequest(JEV_VALUES), loadConfig({}), fake([]).deps);
  assert.equal(!r.ok && r.error.kind, "config");
});

test("invalid requests never reach the provider", async () => {
  const f = fake([{ body: JEV_CHOICE_RESPONSE }]);
  const r = await decide({ context: "c", questions: [{ id: "a", type: "choice", instructions: "i", options: [{ value: "x" }] }] }, config("jev"), f.deps);
  assert.equal(!r.ok && r.error.kind, "invalid_request");
  assert.equal(f.calls.length, 0);
});

test("2-decimal rounding on a 10-level rubric is not rejected", async () => {
  const levels = Array.from({ length: 10 }, (_, i) => ({ label: `l${i}` }));
  const probabilities = Object.fromEntries(levels.map((_, i) => [String(i), 0.096])); // Σ = 0.96
  const f = fake([{ body: { model: "jev-1.13.0", usage: { input_tokens: 1 }, answers: { q0: { type: "score", score: 4.5, probabilities } } } }]);
  const r = await decide({ context: "c", questions: [{ id: "s", type: "score", instructions: "i", levels }] }, config("jev"), f.deps);
  assert.ok(r.ok, JSON.stringify(r));
});

test("a body that fails mid-read is a typed error, not a throw", async () => {
  const f = fake([]);
  f.deps.fetch = (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => { throw new TypeError("terminated"); } })) as unknown as typeof fetch;
  const r = await decide(choiceRequest(["billing", "technical"]), config("jev", { timeoutMs: 60000 }), f.deps);
  assert.equal(!r.ok && r.error.kind, "network");
});
