import { spawn } from "node:child_process";
import * as z from "zod/v4";
import { type Adapter, type Compiled, type WireAnswer, InvalidResponse } from "../schema.ts";

// Answers with the user's own Claude Code login via `claude -p` (headless mode): no extra API key.
// Isolated per call: no tools, MCP servers, settings or saved session, and a short system prompt
// instead of Claude Code's default (~1.2k input tokens instead of ~3.5k).
// Claude returns answers in words, so the probabilities here are Claude's SELF-REPORTED estimates,
// not model probabilities. Every result says so in `notes`.

const SYSTEM = "You are a careful decision engine for software teams. Answer every question only through the structured output. For each question give a probability for every allowed answer; the probabilities for one question must sum to 1. Be calibrated: use values near 0.5 when the text doesn't settle it.";

const allowed = (q: Compiled) =>
  q.type === "binary" ? ["true", "false"] : q.type === "choice" ? q.options.map((o) => o.value) : q.levels.map((l) => l.label);

const describe = (q: Compiled) => {
  if (q.type === "binary") {
    const c = q.criteria;
    return `${q.key} (yes/no): ${q.instructions}\n  answers: "true", "false"${c?.true ? `\n  true means: ${c.true}` : ""}${c?.false ? `\n  false means: ${c.false}` : ""}`;
  }
  if (q.type === "choice") return `${q.key} (pick one): ${q.instructions}\n  answers:\n${q.options.map((o) => `  - "${o.value}"${o.description ? `: ${o.description}` : ""}`).join("\n")}`;
  return `${q.key} (ordered scale, lowest first): ${q.instructions}\n  answers:\n${q.levels.map((l) => `  - "${l.label}"${l.description ? `: ${l.description}` : ""}`).join("\n")}`;
};

const Output = z.object({
  is_error: z.boolean().optional(),
  api_error_status: z.number().nullable().optional(),
  result: z.string().optional(),
  structured_output: z.object({
    answers: z.array(z.object({ key: z.string(), probabilities: z.record(z.string(), z.number().min(0).max(1)) })),
  }).optional(),
  usage: z.object({
    input_tokens: z.number().optional(), output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional(),
  }).optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

// Never let a key in the user's shell silently move this off their subscription, and let a nested
// `claude -p` start when decisionkit itself runs inside Claude Code (the plugin).
export function claudeEnv(env: NodeJS.ProcessEnv = process.env) {
  const out = { ...env };
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) delete out[k];
  return out;
}

export function runClaude(args: string[], stdin: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("claude", args, { env: claudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const onAbort = () => { p.kill("SIGTERM"); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.on("error", (e) => { signal.removeEventListener("abort", onAbort); reject(e); });
    p.on("close", (code) => { signal.removeEventListener("abort", onAbort); resolve({ code, stdout, stderr }); });
    p.stdin.end(stdin); // the prompt goes in on stdin: never in argv, never in the process list
  });
}

export const claude: Adapter = {
  name: "claude",
  label: "Claude (your Claude Code login)",
  path: "",
  defaultModel: "haiku",

  compile(qs, context, model) {
    const schema = {
      type: "object", required: ["answers"],
      properties: { answers: { type: "array", items: { type: "object", required: ["key", "probabilities"],
        properties: { key: { type: "string" }, probabilities: { type: "object", additionalProperties: { type: "number" } } } } } },
    };
    const prompt = `Context:\n"""\n${context}\n"""\n\nQuestions:\n${qs.map(describe).join("\n\n")}\n\nReturn one entry per question key, with a probability for every allowed answer.`;
    return { model, schema, prompt };
  },

  // `claude -p` instead of HTTP. Its outcome is wrapped as a Response so decide()'s deadline,
  // error classification, validation and usage log apply unchanged. No retries: each try uses quota.
  async exec(body, signal) {
    const { model, schema, prompt } = JSON.parse(body) as { model: string; schema: unknown; prompt: string };
    const args = ["-p", "--model", model, "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--system-prompt", SYSTEM, "--setting-sources", "", "--strict-mcp-config", "--tools", "",
      "--disable-slash-commands", "--no-session-persistence", "--effort", "low"];
    const r = await runClaude(args, prompt, signal);
    let json: { is_error?: boolean; api_error_status?: number | null; result?: string } | null = null;
    try { json = JSON.parse(r.stdout); } catch { /* fall through */ }
    if (r.code === 0 && json && !json.is_error) return new Response(r.stdout, { status: 200 });
    const msg = (json?.result ?? r.stderr ?? "").trim().slice(0, 300) || `claude exited with code ${r.code}`;
    const status = json?.api_error_status ?? (/log ?in|auth|credential/i.test(msg) ? 401 : /limit|quota/i.test(msg) ? 429 : 500);
    return new Response(JSON.stringify({ error: { message: msg } }), { status });
  },

  parse(json, qs) {
    const r = Output.safeParse(json);
    if (!r.success || !r.data.structured_output) throw new InvalidResponse(`claude -p returned no structured answers${r.success ? "" : `: ${z.prettifyError(r.error)}`}`);
    const byKey = new Map(r.data.structured_output.answers.map((a) => [a.key, a.probabilities]));
    const answers = qs.map((q): WireAnswer => {
      const raw = byKey.get(q.key);
      if (!raw) throw new InvalidResponse(`Claude gave no answer for ${q.key}`);
      const names = allowed(q);
      const stray = Object.keys(raw).find((k) => !names.includes(k));
      if (stray) throw new InvalidResponse(`Claude answered ${q.key} with "${stray}", which is not an allowed answer`);
      // Self-reported numbers rarely sum to exactly 1: renormalize, and refuse an all-zero answer.
      const total = names.reduce((s, n) => s + (raw[n] ?? 0), 0);
      if (total <= 0) throw new InvalidResponse(`Claude gave ${q.key} no probability mass`);
      const p = Object.fromEntries(names.map((n) => [n, (raw[n] ?? 0) / total]));
      if (q.type === "binary") return { type: "binary", probability_true: p.true! };
      const top = names.reduce((a, b) => (p[b]! > p[a]! ? b : a));
      if (q.type === "choice") return { type: "choice", choice: top, probabilities: p };
      return { type: "score", expected_level: names.reduce((s, n, i) => s + i * p[n]!, 0), probabilities: p };
    });
    const u = r.data.usage ?? {};
    return {
      model: Object.keys(r.data.modelUsage ?? {})[0] ?? "claude",
      answers,
      usage: {
        input_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        output_tokens: u.output_tokens,
      },
    };
  },

  classify(status) {
    if (status === 401 || status === 403) return { kind: "auth", retryable: false };
    if (status === 429) return { kind: "quota", retryable: false }; // subscription usage limit
    return { kind: "overloaded", retryable: false };
  },
};
