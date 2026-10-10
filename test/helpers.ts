import type { Config } from "../src/decide.ts";
import type { ProviderName } from "../src/schema.ts";

export const KEY = "sk-test-SECRET-1234567890";

export const config = (provider: ProviderName, over: Partial<Config> = {}): Config => ({
  provider, apiKey: KEY, model: provider === "jev" ? "jev-latest" : "gpt-6-luna",
  baseUrl: "http://127.0.0.1:1", timeoutMs: 5000, usageLog: false, dataDir: "/nonexistent", ...over,
});

type Step = { status?: number; body?: unknown; headers?: Record<string, string> } | Error | "hang";

/** Scripted fetch: one step per call. Records requests. Fake clock: sleep advances now(). */
export function fake(steps: Step[]) {
  let t = 1_000_000;
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const sleeps: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step === "hang") {
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    if (step instanceof Error) throw step;
    const text = typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {});
    return new Response(text, { status: step.status ?? 200, headers: step.headers });
  }) as typeof globalThis.fetch;
  return {
    calls, sleeps,
    deps: { fetch, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } },
  };
}

// Verbatim from https://docs.typesafe.ai/api.md (2026-10-10)
export const JEV_CHOICE_RESPONSE = {
  model: "jev-1.13.0",
  answers: { q0: { type: "choice", choice: "billing", probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 }, confidence: 0.81 } },
  usage: { input_tokens: 318, output_tokens: 34 },
};

// Verbatim answer from https://developers.openai.com/api/docs/guides/decisions (2026-10-10)
export const OPENAI_CHOICE_RESPONSE = {
  model: "gpt-6-luna",
  answers: [{ type: "choice", name: "q0", choice: "billing",
    probabilities: [{ value: "billing", probability: 0.95 }, { value: "technical", probability: 0.02 }, { value: "shipping", probability: 0.01 }, { value: "other", probability: 0.02 }],
    confidence: 0.93 }],
  usage: { input_tokens: 120, output_tokens: 0 },
};

export const choiceRequest = (values: string[]) => ({
  context: "Help! My payouts have been failing for 3 days.",
  questions: [{ id: "department", type: "choice", instructions: "Which team should handle this?", options: values.map((value) => ({ value })) }],
});
