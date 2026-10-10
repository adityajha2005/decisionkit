// CLI end-to-end: the real bundle (or installed bin via DK_SERVER_BIN) against a localhost mock Jev.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";

const BIN = process.env.DK_SERVER_BIN ?? join(import.meta.dirname, "..", "dist", "server.mjs");
let http: Server;
let env: Record<string, string>;

before(async () => {
  // Deterministic answers: noul 0.9; choice puts 0.7 on the first option; score is most likely level 1; rank scores candidate i as i.
  http = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c)).on("end", async () => {
      res.setHeader("content-type", "application/json");
      const body = JSON.parse(b || "{}");
      const answers: Record<string, unknown> = {};
      for (const [k, q] of Object.entries<any>(body.questions ?? {})) {
        if (q.type === "noul") answers[k] = { type: "noul", noul: 0.9 };
        if (q.type === "choice") {
          const o = Object.keys(q.criteria);
          answers[k] = { type: "choice", choice: o[0], probabilities: Object.fromEntries(o.map((x, i) => [x, i ? 0.3 / (o.length - 1) : 0.7])) };
        }
        if (q.type === "score") {
          const i = Number(k.slice(1));
          answers[k] = { type: "score", score: i, probabilities: Object.fromEntries(q.criteria.map((_: unknown, j: number) => [String(j), j === 1 ? 1 : 0])) };
        }
      }
      res.end(JSON.stringify({ model: "jev-mock", answers, usage: { input_tokens: 10 } }));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  env = { PATH: process.env.PATH!, DECISIONKIT_PROVIDER: "jev", DECISIONKIT_TYPESAFE_API_KEY: "k", DECISIONKIT_USAGE_LOG: "false",
    DECISIONKIT_BASE_URL: `http://127.0.0.1:${(http.address() as { port: number }).port}` };
});
after(() => http.close());

// Async spawn: the mock provider runs in this process, so a blocking spawnSync would deadlock it.
function run(args: string[], input?: string, extraEnv: Record<string, string> = {}): Promise<{ out: string; err: string; code: number | null }> {
  const [cmd, pre] = BIN.endsWith(".mjs") ? [process.execPath, [BIN]] : [BIN, []];
  const p = spawn(cmd, [...pre, ...args], { env: { ...env, ...extraEnv } });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.stdin.end(input ?? "");
  return new Promise((resolve) => p.on("close", (code) => resolve({ out: out.trim(), err, code })));
}

test("binary: answer and grep-style exit codes, threshold respected", async () => {
  const loose = await run(["binary", "Is this breaking?"], "diff");
  assert.deepEqual([loose.out, loose.code], ["true 0.9", 0]);
  const strict = await run(["binary", "Is this breaking?", "--threshold", "0.95"], "diff");
  assert.deepEqual([strict.out, strict.code], ["false 0.9", 1]);
});

test("choice: reads stdin, prints choice and probability, threshold gates exit code", async () => {
  const r = await run(["choice", "Kind?", "bug", "feature", "docs"], "Export CSV returns 500");
  assert.deepEqual([r.out, r.code], ["bug 0.7", 0]);
  assert.equal((await run(["choice", "Kind?", "bug", "feature", "--threshold", "0.8"], "x")).code, 1);
});

test("score and rank output", async () => {
  assert.equal((await run(["score", "Severity?", "low", "mid", "high"], "x")).out, "mid 1 (expected 0)");
  // rank: mock scores candidate i as level i, so the last candidate ranks first; texts are printed back.
  assert.deepEqual((await run(["rank", "Relevant?", "README.md", "csv_writer.py"], "bug")).out.split("\n"), ["1\tcsv_writer.py", "0\tREADME.md"]);
});

test("discloses the provider on stderr; --quiet hides it; --json prints the full result", async () => {
  assert.match((await run(["binary", "q"], "x")).err, /sent to Jev \(TypeSafe AI\)/);
  assert.equal((await run(["binary", "q", "--quiet"], "x")).err, "");
  const j = await run(["binary", "q", "--json", "--quiet"], "x");
  assert.equal(JSON.parse(j.out).ok, true);
});

test("errors exit 2 with a message, never a fake answer", async () => {
  for (const [args, input, extra, msg] of [
    [["binary", "q"], "", {}, /no context/],
    [["choice", "q", "only-one"], "x", {}, /at least 2 options/],
    [["frobnicate", "q"], "x", {}, /unknown command/],
    [["binary", "q"], "x", { DECISIONKIT_PROVIDER: "" }, /config: No provider/],
    [["binary", "q", "--threshold", "2"], "x", {}, /threshold/],
  ] as const) {
    const r = await run([...args], input, { ...extra });
    assert.equal(r.code, 2, `${args.join(" ")} -> ${r.err}`);
    assert.equal(r.out, "");
    assert.match(r.err, msg);
  }
});

test("formatted view (--pretty): bars and a highlighted winner; same exit codes; piped default stays plain", async () => {
  const c = await run(["choice", "Kind?", "bug", "feature", "docs", "--pretty"], "x", { NO_COLOR: "1" });
  assert.equal(c.code, 0);
  assert.match(c.out, /● bug\s+█+░*\s+70%/);
  assert.match(c.err, /sent to Jev \(TypeSafe AI\)/);
  const b = await run(["binary", "q", "--pretty", "--threshold", "0.95"], "x", { NO_COLOR: "1" });
  assert.equal(b.code, 1);
  assert.match(b.out, /✘ no/);
  assert.doesNotMatch(c.out, /\x1b\[/, "NO_COLOR disables escape codes");
  assert.equal((await run(["choice", "Kind?", "bug", "feature"], "x")).out, "bug 0.7"); // piped: unchanged
});
