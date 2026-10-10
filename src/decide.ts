import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { jev, jevOpenRouter } from "./providers/jev.ts";
import { openai } from "./providers/openai.ts";
import {
  type Adapter, type Answer, type Compiled, type DecideResult, type ErrorKind, type Level,
  type ProviderName, type WireAnswer, DecideRequest, InvalidResponse,
} from "./schema.ts";

export const ADAPTERS: Record<ProviderName, Adapter> = { jev, openrouter: jevOpenRouter, openai };

// USD per 1M input tokens; neither provider charges for output. OpenAI is a lower
// bound: regional and long-context multipliers are not modeled.
export const PRICES = { as_of: "2026-10-10", jev: 0.042, openrouter: 0.042, openai: 0.1 } as const;

const MAX_ATTEMPTS = 3;
const MAX_WIRE_QUESTIONS = 40; // after rank fan-out
const DEFAULT_RANK_LEVELS: Level[] = [
  { label: "irrelevant" }, { label: "slightly relevant" }, { label: "relevant" },
  { label: "highly relevant" }, { label: "best match" },
];
const CALIBRATION_NOTE = "Probabilities are the provider's estimates; they have not been verified as calibrated for your task.";

export type Config = {
  provider: ProviderName; apiKey: string; model: string; baseUrl: string;
  timeoutMs: number; usageLog: boolean; dataDir: string;
};

/** Plugin userConfig left blank can arrive as "" or as the literal "${user_config.x}". */
const unset = (v: string | undefined) => v === undefined || v.trim() === "" || v.includes("${");

/** Reads only DECISIONKIT_* names, so an unrelated OPENAI_API_KEY in the shell is never billed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config | { error: string } {
  const provider = env.DECISIONKIT_PROVIDER?.trim();
  if (unset(provider)) return { error: "No provider selected. Set DECISIONKIT_PROVIDER to \"jev\", \"openrouter\" or \"openai\" (in Claude Code: the plugin's provider setting)." };
  if (provider !== "jev" && provider !== "openrouter" && provider !== "openai") return { error: `DECISIONKIT_PROVIDER must be "jev", "openrouter" or "openai", got "${provider}".` };

  const keyVar = ({ jev: "DECISIONKIT_TYPESAFE_API_KEY", openrouter: "DECISIONKIT_OPENROUTER_API_KEY", openai: "DECISIONKIT_OPENAI_API_KEY" } as const)[provider];
  const apiKey = env[keyVar];
  if (unset(apiKey)) return { error: `Provider is "${provider}" but ${keyVar} is not set. Bare OPENAI_API_KEY / TYPESAFE_API_KEY / OPENROUTER_API_KEY are deliberately ignored.` };

  let baseUrl: string = ({ jev: "https://api.typesafe.ai", openrouter: "https://openrouter.ai", openai: "https://api.openai.com" } as const)[provider];
  if (!unset(env.DECISIONKIT_BASE_URL)) {
    // Test hook only: loopback, so a key can never be redirected to a third host.
    const u = env.DECISIONKIT_BASE_URL!.replace(/\/+$/, "");
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u)) return { error: "DECISIONKIT_BASE_URL may only point at http://127.0.0.1 or http://localhost." };
    baseUrl = u;
  }

  let timeoutMs = 15000;
  if (!unset(env.DECISIONKIT_TIMEOUT_MS)) {
    timeoutMs = Number(env.DECISIONKIT_TIMEOUT_MS);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) return { error: "DECISIONKIT_TIMEOUT_MS must be an integer from 1000 to 60000." };
  }

  return {
    provider,
    apiKey: apiKey!.trim(),
    model: unset(env.DECISIONKIT_MODEL) ? ADAPTERS[provider].defaultModel : env.DECISIONKIT_MODEL!.trim(),
    baseUrl,
    timeoutMs,
    usageLog: !/^(false|0|no|off)$/i.test(env.DECISIONKIT_USAGE_LOG?.trim() ?? ""),
    dataDir: dataDir(env),
  };
}

export function dataDir(env: NodeJS.ProcessEnv = process.env) {
  if (!unset(env.CLAUDE_PLUGIN_DATA)) return env.CLAUDE_PLUGIN_DATA!;
  if (!unset(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME!, "decisionkit");
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "decisionkit");
  return join(homedir(), ".local", "state", "decisionkit");
}

type Deps = { fetch: typeof fetch; now: () => number; sleep: (ms: number) => Promise<void> };
const realDeps: Deps = { fetch: globalThis.fetch, now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export async function decide(input: unknown, loaded: Config | { error: string }, deps: Deps = realDeps): Promise<DecideResult> {
  const request_id = `dk_${randomUUID()}`;
  const fail = (provider: ProviderName | null, kind: ErrorKind, message: string, extra: { status?: number; retryable?: boolean } = {}): DecideResult =>
    ({ ok: false, provider, request_id, error: { kind, message, retryable: false, ...extra } });

  if ("error" in loaded) return fail(null, "config", loaded.error);
  const cfg: Config = loaded;
  const adapter = ADAPTERS[cfg.provider];
  const scrub = (s: string) => s.split(cfg.apiKey).join("***").slice(0, 500);

  const parsed = DecideRequest.safeParse(input);
  if (!parsed.success) return fail(cfg.provider, "invalid_request", z.prettifyError(parsed.error));
  const req = parsed.data;

  // Compile: rank → one score question per candidate, sharing the context.
  const wire: Compiled[] = [];
  const owner: { qid: string; candidate?: string }[] = [];
  for (const q of req.questions) {
    if (q.type === "rank") {
      for (const c of q.candidates) {
        owner.push({ qid: q.id, candidate: c.id });
        wire.push({ key: `q${wire.length}`, type: "score", instructions: `${q.instructions}\n\nCandidate: ${c.text}`, levels: q.levels ?? DEFAULT_RANK_LEVELS });
      }
    } else {
      owner.push({ qid: q.id });
      wire.push({ ...q, key: `q${wire.length}` } as Compiled);
    }
  }
  if (wire.length > MAX_WIRE_QUESTIONS) return fail(cfg.provider, "invalid_request", `Too many questions after expanding rank candidates (${wire.length} > ${MAX_WIRE_QUESTIONS}).`);

  const body = JSON.stringify(adapter.compile(wire, req.context, cfg.model));
  const start = deps.now();
  const deadline = start + cfg.timeoutMs;
  let attempts = 0;
  let outcome: DecideResult | undefined;
  let usage: { input_tokens: number; output_tokens?: number } | undefined;
  let model = cfg.model;

  while (!outcome) {
    attempts++;
    let res: Response;
    let text: string;
    try {
      res = await deps.fetch(cfg.baseUrl + adapter.path, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(deadline - deps.now()))),
      });
      text = await res.text(); // inside the try: the deadline can abort mid-body
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError" || err.name === "AbortError" || deps.now() >= deadline) {
        outcome = fail(cfg.provider, "timeout", `No response from ${adapter.label} within ${cfg.timeoutMs} ms.`, { retryable: true });
        break;
      }
      if (await backoff(null)) continue;
      outcome = fail(cfg.provider, "network", scrub(`Could not reach ${adapter.label}: ${err.message}`), { retryable: true });
      break;
    }

    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }

    if (res.ok) {
      try {
        if (json === null) throw new InvalidResponse(`${adapter.label} returned a non-JSON body.`);
        const out = adapter.parse(json, wire);
        model = out.model;
        usage = out.usage;
        outcome = assemble(out.answers);
      } catch (e) {
        if (!(e instanceof InvalidResponse)) throw e;
        outcome = fail(cfg.provider, "provider_response_invalid", scrub(e.message));
      }
      break;
    }

    const cls = adapter.classify(res.status, json);
    if (cls.retryable && (await backoff(res.headers.get("retry-after")))) continue;
    const providerMsg = (json as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
    outcome = fail(cfg.provider, cls.kind, scrub(`${adapter.label} returned HTTP ${res.status}: ${providerMsg}`), { status: res.status, retryable: cls.retryable });
  }

  logUsage(cfg, {
    request_id, provider: cfg.provider, model, tag: req.tag,
    question_types: req.questions.map((q) => q.type), wire_questions: wire.length,
    latency_ms: deps.now() - start, attempts, ok: outcome.ok,
    error_kind: outcome.ok ? undefined : outcome.error.kind,
    input_tokens: usage?.input_tokens, output_tokens: usage?.output_tokens, estimated_cost_usd: cost(cfg.provider, usage),
  });
  return outcome;

  /** Sleeps before a retry; false when out of attempts or the wait would pass the deadline. */
  async function backoff(retryAfter: string | null) {
    if (attempts >= MAX_ATTEMPTS) return false;
    const hinted = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;
    const wait = Math.round(hinted ?? 500 * 2 ** (attempts - 1) + Math.random() * 250);
    if (deps.now() + wait >= deadline) return false;
    await deps.sleep(wait);
    return true;
  }

  function assemble(wireAnswers: WireAnswer[]): DecideResult {
    const answers: Record<string, Answer> = {};
    const refused: string[] = [];
    for (const [i, a] of wireAnswers.entries()) {
      const q = wire[i]!;
      const { qid, candidate } = owner[i]!;
      if (a.type === "refused") { refused.push(qid); answers[qid] = { type: "refused" }; continue; }
      const bad = invariantError(q, a);
      if (bad) return fail(cfg.provider, "provider_response_invalid", `${adapter.label} answer for "${qid}" ${bad}.`);
      if (candidate) {
        if (answers[qid]?.type === "refused") continue;
        const r = (answers[qid] ??= { type: "rank", derived: true, ranking: [] }) as Extract<Answer, { type: "rank" }>;
        r.ranking.push({ candidate_id: candidate, expected_level: (a as Extract<WireAnswer, { type: "score" }>).expected_level });
      } else if (a.type === "binary") {
        answers[qid] = a;
      } else if (a.type === "choice") {
        answers[qid] = { type: "choice", choice: a.choice, probabilities: a.probabilities, native: { confidence: a.confidence } };
      } else {
        const most_likely = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0]![0];
        answers[qid] = { type: "score", expected_level: a.expected_level, most_likely, probabilities: a.probabilities, native: { confidence: a.confidence } };
      }
    }
    for (const a of Object.values(answers)) if (a.type === "rank") a.ranking.sort((x, y) => y.expected_level - x.expected_level);

    if (refused.length) {
      return { ok: false, provider: cfg.provider, request_id, answers,
        error: { kind: "refused", retryable: false, message: `${adapter.label} declined to answer: ${[...new Set(refused)].join(", ")}. No decision was made for those questions.` } };
    }
    const notes = [`Sent to ${adapter.label}.`, CALIBRATION_NOTE];
    if (cfg.provider === "openai" && req.questions.some((q) => q.type === "binary" && q.criteria)) notes.push("Binary criteria were appended to the instructions text (OpenAI predicates have no criteria field).");
    if (req.questions.some((q) => q.type === "rank")) notes.push("Rank is derived from independent per-candidate scores; treat close values as ties.");
    return {
      ok: true, provider: cfg.provider, model, request_id, latency_ms: deps.now() - start, attempts,
      usage: usage!, estimated_cost_usd: cost(cfg.provider, usage), answers, notes,
    };
  }
}

function invariantError(q: Compiled, a: WireAnswer): string | null {
  if (a.type === "binary") return null; // range already enforced by the response schema
  if (a.type === "refused") return null;
  const allowed = q.type === "choice" ? q.options.map((o) => o.value) : q.type === "score" ? q.levels.map((l) => l.label) : [];
  const probs = Object.entries(a.probabilities);
  const stray = probs.find(([k]) => !allowed.includes(k));
  if (stray) return `has a probability for "${stray[0]}", which is not one of the supplied ${q.type === "choice" ? "options" : "levels"}`;
  const sum = probs.reduce((s, [, p]) => s + p, 0);
  // Providers round to ~2 decimals, so allow per-entry rounding slack.
  if (Math.abs(sum - 1) > Math.max(0.02, probs.length * 0.005)) return `has probabilities summing to ${sum.toFixed(3)}, not 1`;
  if (a.type === "choice" && !allowed.includes(a.choice)) return `chose "${a.choice}", which is not one of the supplied options`;
  if (a.type === "score" && (a.expected_level < 0 || a.expected_level > allowed.length - 1)) return `has expected level ${a.expected_level} outside 0..${allowed.length - 1}`;
  return null;
}

function cost(provider: ProviderName, usage?: { input_tokens: number; cost?: number }) {
  if (!usage) return null;
  return usage.cost ?? (usage.input_tokens * PRICES[provider]) / 1e6; // provider-reported cost wins
}

const logFile = (cfg: { dataDir: string }) => join(cfg.dataDir, "usage.jsonl");

/** Ids, counts, timings and tokens only — never context, instructions or keys. */
function logUsage(cfg: Config, rec: Record<string, unknown>) {
  if (!cfg.usageLog) return;
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    appendFileSync(logFile(cfg), JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  } catch (e) {
    process.stderr.write(JSON.stringify({ level: "warn", msg: "usage log not writable", error: (e as Error).message }) + "\n");
  }
}

/** Config (no secret values), a free connectivity check, and usage totals. */
export async function status(cfg: Config | { error: string }, env: NodeJS.ProcessEnv, ping: boolean, deps: Pick<Deps, "fetch" | "now"> = realDeps) {
  const seen = Object.keys(env).filter((k) => k.startsWith("DECISIONKIT_") && !unset(env[k])).sort();
  const out: Record<string, unknown> = { env_vars_seen: seen, price_table_as_of: PRICES.as_of };
  if ("error" in cfg) return { ...out, ready: false, config_error: cfg.error, usage: usageSummary(dataDir(env)) };

  Object.assign(out, { ready: true, provider: ADAPTERS[cfg.provider].label, model: cfg.model, timeout_ms: cfg.timeoutMs, usage_log: cfg.usageLog ? logFile(cfg) : "off" });
  if (ping) {
    // A sibling GET .../models exists on every provider and consumes no tokens.
    const t = deps.now();
    try {
      const res = await deps.fetch(cfg.baseUrl + ADAPTERS[cfg.provider].path.replace(/[^/]+$/, "models"), { headers: { authorization: `Bearer ${cfg.apiKey}` }, signal: AbortSignal.timeout(5000) });
      out.ping = { ok: res.ok, status: res.status, latency_ms: deps.now() - t };
    } catch (e) {
      out.ping = { ok: false, error: (e as Error).name };
    }
  }
  // With logging off, report that rather than another process's history from the shared log.
  out.usage = cfg.usageLog ? usageSummary(cfg.dataDir) : "logging off";
  return out;
}

export function usageSummary(dir: string) {
  let lines: Record<string, any>[];
  try {
    lines = readFileSync(join(dir, "usage.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return { calls: 0 };
  }
  const lat = lines.map((l) => l.latency_ms as number).sort((a, b) => a - b);
  const errors: Record<string, number> = {};
  for (const l of lines) if (!l.ok) errors[l.error_kind] = (errors[l.error_kind] ?? 0) + 1;
  return {
    calls: lines.length,
    ok: lines.filter((l) => l.ok).length,
    errors,
    by_provider: lines.reduce<Record<string, number>>((m, l) => ({ ...m, [l.provider]: (m[l.provider] ?? 0) + 1 }), {}),
    latency_ms: { p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] },
    input_tokens: lines.reduce((s, l) => s + (l.input_tokens ?? 0), 0),
    estimated_cost_usd: Number(lines.reduce((s, l) => s + (l.estimated_cost_usd ?? 0), 0).toFixed(6)),
    since: lines[0]?.ts,
  };
}
