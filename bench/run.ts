// Usage:
//   DECISIONKIT_PROVIDER=jev DECISIONKIT_TYPESAFE_API_KEY=… DECISIONKIT_MODEL=jev-1.13.0 node bench/run.ts
//   DECISIONKIT_PROVIDER=openai DECISIONKIT_OPENAI_API_KEY=… node bench/run.ts
//   node bench/run.ts --claude            # baseline: same tasks through `claude -p`
// Prints accuracy, Brier score, latency and cost per task type; writes bench/results-<system>-<date>.json.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { decide, loadConfig } from "../src/decide.ts";
import type { Question } from "../src/schema.ts";

type Task = { id: string; context: string; question: Question; label: string | boolean };
type Row = { id: string; type: string; correct: boolean | null; p_label?: number; latency_ms: number; cost_usd: number | null; error?: string };

const tasks: Task[] = readFileSync(join(import.meta.dirname, "tasks.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const claude = process.argv.includes("--claude");
const cfg = loadConfig({ ...process.env, DECISIONKIT_USAGE_LOG: "false" });
if (!claude && "error" in cfg) { console.error(cfg.error); process.exit(1); }
const system = claude ? "claude" : (cfg as { provider: string }).provider;

const rows: Row[] = [];
for (const t of tasks) {
  const row = claude ? viaClaude(t) : await viaDecide(t);
  rows.push(row);
  process.stderr.write(`${t.id}: ${row.error ?? (row.correct ? "✓" : "✗")}\n`);
}

async function viaDecide(t: Task): Promise<Row> {
  const r = await decide({ context: t.context, questions: [t.question] }, cfg);
  const base = { id: t.id, type: t.question.type };
  if (!r.ok) return { ...base, correct: null, latency_ms: 0, cost_usd: null, error: r.error.kind };
  const a = r.answers[t.question.id]!;
  let correct = false, p_label: number | undefined;
  if (a.type === "binary") { p_label = t.label === true ? a.probability_true : 1 - a.probability_true; correct = p_label > 0.5; }
  if (a.type === "choice") { p_label = a.probabilities[t.label as string] ?? 0; correct = a.choice === t.label; }
  if (a.type === "score") { p_label = a.probabilities[t.label as string] ?? 0; correct = a.most_likely === t.label; }
  if (a.type === "rank") correct = a.ranking[0]?.candidate_id === t.label;
  return { ...base, correct, p_label, latency_ms: r.latency_ms, cost_usd: r.estimated_cost_usd };
}

function viaClaude(t: Task): Row {
  const q = t.question;
  const allowed = q.type === "binary" ? ["true", "false"] : q.type === "choice" ? q.options.map((o) => o.value)
    : q.type === "score" ? q.levels.map((l) => l.label) : q.candidates.map((c) => c.id);
  const detail = q.type === "rank" ? q.candidates.map((c) => `${c.id}: ${c.text}`).join("\n") : "";
  const prompt = `${t.context}\n\nQuestion: ${q.instructions}\n${detail}\nAnswer with exactly one of: ${allowed.join(", ")}${q.type === "rank" ? " (the best candidate id)" : ""}. Reply with only that value.`;
  const t0 = Date.now();
  try {
    const out = JSON.parse(execFileSync("claude", ["-p", "--output-format", "json", prompt], { encoding: "utf8", timeout: 120000 }));
    const answer = String(out.result).trim().replace(/[`"'.]/g, "");
    return { id: t.id, type: q.type, correct: answer === String(t.label), latency_ms: Date.now() - t0, cost_usd: out.total_cost_usd ?? null };
  } catch (e) {
    return { id: t.id, type: q.type, correct: null, latency_ms: 0, cost_usd: null, error: (e as Error).message.slice(0, 80) };
  }
}

// ponytail: n is tiny; Wilson interval keeps us honest about it. Reliability bins skipped until n ≥ 100.
const wilson = (k: number, n: number) => {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(c - m) / d, (c + m) / d].map((x) => Math.round(x * 100));
};
const pct = (xs: number[], q: number) => xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] : null;

const summary = ["all", "binary", "choice", "score", "rank"].map((type) => {
  const rs = rows.filter((r) => type === "all" || r.type === type);
  const done = rs.filter((r) => r.correct !== null);
  const k = done.filter((r) => r.correct).length;
  const withP = done.filter((r) => r.p_label !== undefined);
  return {
    type, n: rs.length, errors: rs.length - done.length,
    accuracy: done.length ? Math.round((100 * k) / done.length) : null, ci95: wilson(k, done.length),
    brier: withP.length ? Number((withP.reduce((s, r) => s + (1 - r.p_label!) ** 2, 0) / withP.length).toFixed(3)) : null,
    p50_ms: pct(done.map((r) => r.latency_ms), 0.5), p95_ms: pct(done.map((r) => r.latency_ms), 0.95),
    cost_usd: Number(rs.reduce((s, r) => s + (r.cost_usd ?? 0), 0).toFixed(6)),
  };
});
console.table(summary);
const model = claude ? "claude -p default" : (cfg as { model: string }).model;
const file = join(import.meta.dirname, `results-${system}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ system, model, date: new Date().toISOString(), summary, rows }, null, 2));
console.log(`wrote ${file}`);
