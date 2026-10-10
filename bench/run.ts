// Usage:
//   DECISIONKIT_PROVIDER=jev DECISIONKIT_TYPESAFE_API_KEY=… DECISIONKIT_MODEL=jev-1.13.0 node bench/run.ts
//   DECISIONKIT_PROVIDER=openai DECISIONKIT_OPENAI_API_KEY=… node bench/run.ts
//   add --tasks tasks-v1.jsonl to run another set from bench/tasks/ (default tasks-v2.jsonl); results go to bench/results/
//   node --env-file=.env bench/run.ts --anthropic  # baseline: same prompt straight to the Messages API (Haiku 5.5)
//     add --via-openrouter to send it through OpenRouter (anthropic/claude-haiku-5.5) with DECISIONKIT_OPENROUTER_API_KEY
//   node bench/run.ts --claude            # baseline: same tasks through `claude -p` (BENCH_CLAUDE_MODEL, default haiku)
// Prints accuracy, Brier score, latency and cost per task type; writes bench/results-<system>-<date>.json.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { decide, loadConfig } from "../src/decide.ts";
import type { Question } from "../src/schema.ts";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";

type Task = { id: string; context: string; question: Question; label: string | boolean };
type Row = { id: string; type: string; correct: boolean | null; p_label?: number; latency_ms: number; cost_usd: number | null; error?: string };

const ti = process.argv.indexOf("--tasks");
const taskFile = ti > 0 ? process.argv[ti + 1]! : "tasks-v2.jsonl";
const taskSet = taskFile.replace(/^.*\//, "").replace(/\.jsonl$/, "");
const tasks: Task[] = readFileSync(join(import.meta.dirname, "tasks", taskFile.replace(/^.*\//, "")), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const claude = process.argv.includes("--claude");
// --anthropic: the same prompt sent straight to the Messages API (no Claude Code system prompt). Needs ANTHROPIC_API_KEY.
const direct = process.argv.includes("--anthropic");
// --via-openrouter: same request through OpenRouter's Anthropic-compatible endpoint, billed to DECISIONKIT_OPENROUTER_API_KEY.
const viaOpenRouter = process.argv.includes("--via-openrouter");
const DIRECT_MODEL = viaOpenRouter ? "anthropic/claude-haiku-5.5" : "claude-haiku-5-5";
const HAIKU_PRICE = { input: 0.1, output: 0.5 }; // USD per 1M tokens, claude-haiku-5-5 (<=100K prompt), as of 2026-10-06
// Declared before the task loop runs. apiKey: null stops the SDK also sending a stray ANTHROPIC_API_KEY to OpenRouter.
const anthropic = !direct ? null : viaOpenRouter
  ? new Anthropic({ baseURL: "https://openrouter.ai/api", apiKey: null, authToken: process.env.DECISIONKIT_OPENROUTER_API_KEY ?? null })
  : new Anthropic();
const CLAUDE_MODEL = process.env.BENCH_CLAUDE_MODEL ?? "haiku";
const resolvedModels = new Set<string>(); // what the alias actually ran, from claude -p modelUsage
const cfg = loadConfig({ ...process.env, DECISIONKIT_USAGE_LOG: "false" });
if (!claude && !direct && "error" in cfg) { console.error(cfg.error); process.exit(1); }
const system = direct ? (viaOpenRouter ? "haiku-via-openrouter" : "anthropic-haiku") : claude ? `claude-${CLAUDE_MODEL}` : (cfg as { provider: string }).provider;

const rows: Row[] = [];
for (const t of tasks) {
  const row = direct ? await viaAnthropic(t) : claude ? viaClaude(t) : await viaDecide(t);
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

function promptFor(t: Task) {
  const q = t.question;
  const allowed = q.type === "binary" ? ["true", "false"] : q.type === "choice" ? q.options.map((o) => o.value)
    : q.type === "score" ? q.levels.map((l) => l.label) : q.candidates.map((c) => c.id);
  const detail = q.type === "rank" ? q.candidates.map((c) => `${c.id}: ${c.text}`).join("\n") : "";
  const prompt = `${t.context}\n\nQuestion: ${q.instructions}\n${detail}\nAnswer with exactly one of: ${allowed.join(", ")}${q.type === "rank" ? " (the best candidate id)" : ""}. Reply with only that value.`;
  return { prompt, allowed };
}

async function viaAnthropic(t: Task): Promise<Row> {
  const { prompt, allowed } = promptFor(t);
  const t0 = Date.now();
  try {
    const res = await anthropic!.messages.parse({
      model: DIRECT_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      output_config: { effort: "low", format: zodOutputFormat(z.object({ answer: z.enum(allowed as [string, ...string[]]) })) },
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) throw new Error(`no answer (stop_reason ${res.stop_reason})`);
    const u = res.usage;
    const inputTokens = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return {
      id: t.id, type: t.question.type, correct: res.parsed_output.answer === String(t.label), latency_ms: Date.now() - t0,
      cost_usd: (inputTokens * HAIKU_PRICE.input + u.output_tokens * HAIKU_PRICE.output) / 1e6,
    };
  } catch (e) {
    return { id: t.id, type: t.question.type, correct: null, latency_ms: 0, cost_usd: null, error: (e as Error).message.slice(0, 300) };
  }
}

function viaClaude(t: Task): Row {
  const q = t.question;
  const { prompt } = promptFor(t);
  const t0 = Date.now();
  try {
    // Isolated: no user/project settings (so no hooks or plugins), no MCP servers, no tools, nothing saved.
    const out = JSON.parse(execFileSync("claude", ["-p", "--output-format", "json", "--model", CLAUDE_MODEL, "--setting-sources", "",
      "--strict-mcp-config", "--tools", "", "--disable-slash-commands", "--no-session-persistence", prompt], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }));
    for (const m of Object.keys(out.modelUsage ?? {})) resolvedModels.add(m);
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
const model = direct ? DIRECT_MODEL : claude ? ([...resolvedModels].join(",") || CLAUDE_MODEL) : (cfg as { model: string }).model;
const file = join(import.meta.dirname, "results", `results-${taskSet}-${system}-${new Date().toISOString().slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify({ task_set: taskSet, system, model, date: new Date().toISOString(), summary, rows }, null, 2));
console.log(`wrote ${file}`);
