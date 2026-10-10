import * as z from "zod/v4";
import { type Adapter, type Compiled, type WireAnswer, InvalidResponse } from "../schema.ts";

// Contract: https://docs.typesafe.ai/api.md (verified 2026-10-10)
const Prob = z.number().min(0).max(1);
const Response = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.discriminatedUnion("type", [
    z.object({ type: z.literal("noul"), noul: Prob }),
    z.object({ type: z.literal("choice"), choice: z.string(), probabilities: z.record(z.string(), Prob), confidence: Prob.optional() }),
    z.object({ type: z.literal("score"), score: z.number(), probabilities: z.record(z.string(), Prob), confidence: Prob.optional() }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().optional() }),
});

const levelText = (l: { label: string; description?: string }) => (l.description ? `${l.label}: ${l.description}` : l.label);

export const jev: Adapter = {
  name: "jev",
  label: "Jev (TypeSafe AI)",
  path: "/v1/systemone",
  defaultModel: "jev-latest",

  compile(qs, context, model) {
    const questions: Record<string, unknown> = {};
    for (const q of qs) {
      if (q.type === "binary") questions[q.key] = { type: "noul", instructions: q.instructions, ...(q.criteria && { criteria: q.criteria }) };
      if (q.type === "choice") questions[q.key] = { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.value, o.description ?? null])) };
      if (q.type === "score") questions[q.key] = { type: "score", instructions: q.instructions, criteria: q.levels.map(levelText) };
    }
    return { state: context, model, questions };
  },

  parse(json, qs) {
    const r = Response.safeParse(json);
    if (!r.success) throw new InvalidResponse(`Jev response did not match the documented schema: ${z.prettifyError(r.error)}`);
    const answers = qs.map((q): WireAnswer => {
      const a = r.data.answers[q.key];
      if (!a) throw new InvalidResponse(`Jev response has no answer for question ${q.key}`);
      if (q.type === "binary" && a.type === "noul") return { type: "binary", probability_true: a.noul };
      if (q.type === "choice" && a.type === "choice") return { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
      if (q.type === "score" && a.type === "score") return { type: "score", expected_level: a.score, probabilities: byLabel(a.probabilities, q), confidence: a.confidence };
      throw new InvalidResponse(`Jev answered ${q.key} with type ${a.type}, expected ${q.type}`);
    });
    return { model: r.data.model, answers, usage: r.data.usage };
  },

  classify(status) {
    if (status === 401 || status === 403) return { kind: "auth", retryable: false };
    if (status === 429) return { kind: "rate_limited", retryable: true };
    if (status === 529 || status >= 500) return { kind: "overloaded", retryable: true };
    return { kind: "invalid_request", retryable: false }; // 422 and other 4xx
  },
};

// Jev keys score probabilities by level index ("0", "1", …).
function byLabel(p: Record<string, number>, q: Extract<Compiled, { type: "score" }>) {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p)) {
    const level = q.levels[Number(k)];
    if (!/^\d+$/.test(k) || !level) throw new InvalidResponse(`Jev score probability key ${k} is not a level index`);
    out[level.label] = v;
  }
  return out;
}
