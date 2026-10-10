import * as z from "zod/v4";
import { type Adapter, type Compiled, type WireAnswer, InvalidResponse } from "../schema.ts";

// Contract: https://developers.openai.com/api/docs/guides/decisions (public beta, verified 2026-10-10)
const Prob = z.number().min(0).max(1);
const Name = z.string().optional();
const Response = z.object({
  model: z.string(),
  answers: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("predicate"), name: Name, probability: Prob }),
    z.object({
      type: z.literal("choice"), name: Name, choice: z.union([z.string(), z.boolean()]),
      probabilities: z.array(z.object({ value: z.union([z.string(), z.boolean()]), probability: Prob })), confidence: Prob.optional(),
    }),
    z.object({
      type: z.literal("score"), name: Name, score: z.number(),
      probabilities: z.array(z.object({ value: z.number().int().nonnegative(), label: z.string().optional(), probability: Prob })), confidence: Prob.optional(),
    }),
    z.object({ type: z.literal("refusal"), name: Name }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative().optional() }),
});

export const openai: Adapter = {
  name: "openai",
  label: "OpenAI Decisions API",
  path: "/v1/decisions",
  defaultModel: "gpt-6-luna",

  compile(qs, context, model) {
    const questions = qs.map((q) => {
      // ponytail: predicate has no criteria field, so criteria are folded into the text (noted in results).
      if (q.type === "binary") return { type: "predicate", name: q.key, instructions: withCriteria(q) };
      if (q.type === "choice") return { type: "choice", name: q.key, instructions: q.instructions, choices: q.options };
      return { type: "score", name: q.key, instructions: q.instructions, levels: q.levels };
    });
    return { model, input: context, questions };
  },

  parse(json, qs) {
    const r = Response.safeParse(json);
    if (!r.success) throw new InvalidResponse(`OpenAI response did not match the documented schema: ${z.prettifyError(r.error)}`);
    if (r.data.answers.length !== qs.length) throw new InvalidResponse(`OpenAI returned ${r.data.answers.length} answers for ${qs.length} questions`);
    const answers = qs.map((q, i): WireAnswer => {
      // Answers come back in question order; prefer the echoed name when present.
      const a = r.data.answers.find((x) => x.name === q.key) ?? r.data.answers[i]!;
      if (a.type === "refusal") return { type: "refused" };
      if (q.type === "binary" && a.type === "predicate") return { type: "binary", probability_true: a.probability };
      if (q.type === "choice" && a.type === "choice") {
        return { type: "choice", choice: String(a.choice), probabilities: Object.fromEntries(a.probabilities.map((p) => [String(p.value), p.probability])), confidence: a.confidence };
      }
      if (q.type === "score" && a.type === "score") {
        const probabilities: Record<string, number> = {};
        for (const p of a.probabilities) {
          const level = q.levels[p.value];
          if (!level) throw new InvalidResponse(`OpenAI score level index ${p.value} is out of range`);
          probabilities[level.label] = p.probability;
        }
        return { type: "score", expected_level: a.score, probabilities, confidence: a.confidence };
      }
      throw new InvalidResponse(`OpenAI answered ${q.key} with type ${a.type}, expected ${q.type}`);
    });
    return { model: r.data.model, answers, usage: r.data.usage };
  },

  classify(status, body) {
    if (status === 401 || status === 403) return { kind: "auth", retryable: false };
    if (status === 429) {
      // ponytail: OpenAI-wide convention, not verified for /v1/decisions specifically.
      const code = (body as { error?: { code?: string } } | null)?.error?.code;
      return code === "insufficient_quota" ? { kind: "quota", retryable: false } : { kind: "rate_limited", retryable: true };
    }
    if (status >= 500) return { kind: "overloaded", retryable: true };
    return { kind: "invalid_request", retryable: false };
  },
};

function withCriteria(q: Extract<Compiled, { type: "binary" }>) {
  const c = q.criteria;
  if (!c?.true && !c?.false) return q.instructions;
  return [q.instructions, c.true && `True means: ${c.true}`, c.false && `False means: ${c.false}`].filter(Boolean).join("\n");
}
