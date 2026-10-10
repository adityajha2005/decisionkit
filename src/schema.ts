import * as z from "zod/v4";

// Caps follow Jev's documented limits (the stricter provider), so validation
// doesn't change when the provider does.
const id = z.string().regex(/^[a-z0-9_]{1,40}$/, "ids are 1-40 chars of a-z, 0-9, _");
const text = z.string().trim().min(1);

const uniqueBy = <T>(key: (t: T) => string, what: string) =>
  [(arr: T[]) => new Set(arr.map(key)).size === arr.length, `${what} must be unique`] as const;

const Level = z.object({ label: text.max(100), description: text.max(1000).optional() });
const Levels = z.array(Level).min(2).max(10).refine(...uniqueBy((l: z.infer<typeof Level>) => l.label, "level labels"));

export const Question = z.discriminatedUnion("type", [
  z.object({
    id, type: z.literal("binary"), instructions: text,
    criteria: z.object({ true: text.optional(), false: text.optional() }).optional(),
  }),
  z.object({
    id, type: z.literal("choice"), instructions: text,
    options: z.array(z.object({ value: text.max(200), description: text.max(1000).optional() }))
      .min(2).max(255).refine(...uniqueBy((o: { value: string }) => o.value, "option values")),
  }),
  z.object({ id, type: z.literal("score"), instructions: text, levels: Levels }),
  z.object({
    id, type: z.literal("rank"), instructions: text,
    candidates: z.array(z.object({ id, text }))
      .min(2).max(20).refine(...uniqueBy((c: { id: string }) => c.id, "candidate ids")),
    levels: Levels.optional(),
  }),
]);

export const DecideRequest = z.object({
  context: text.describe("All evidence the decision needs, as plain text. Sent to the external provider."),
  questions: z.array(Question).min(1).max(16).refine(...uniqueBy((q: { id: string }) => q.id, "question ids")),
  tag: z.string().max(64).optional().describe("Local usage-log label. Never sent to the provider."),
});

export type Question = z.infer<typeof Question>;
export type DecideRequest = z.infer<typeof DecideRequest>;
export type Level = z.infer<typeof Level>;

/** A question as sent on the wire: rank is already fanned out into score questions. */
export type Compiled =
  | { key: string; type: "binary"; instructions: string; criteria?: { true?: string; false?: string } }
  | { key: string; type: "choice"; instructions: string; options: { value: string; description?: string }[] }
  | { key: string; type: "score"; instructions: string; levels: Level[] };

/** What an adapter returns per compiled question, before assembly. */
export type WireAnswer =
  | { type: "binary"; probability_true: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence?: number }
  | { type: "score"; expected_level: number; probabilities: Record<string, number>; confidence?: number }
  | { type: "refused" };

export type Answer =
  | { type: "binary"; probability_true: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; native: { confidence?: number } }
  | { type: "score"; expected_level: number; most_likely: string; probabilities: Record<string, number>; native: { confidence?: number } }
  | { type: "rank"; derived: true; ranking: { candidate_id: string; expected_level: number }[] }
  | { type: "refused" };

export type ErrorKind =
  | "config" | "invalid_request" | "auth" | "rate_limited" | "quota" | "overloaded"
  | "timeout" | "network" | "provider_response_invalid" | "refused";

export type ProviderName = "jev" | "openai";

export type DecideResult =
  | {
      ok: true; provider: ProviderName; model: string; request_id: string;
      latency_ms: number; attempts: number;
      usage: { input_tokens: number; output_tokens?: number };
      estimated_cost_usd: number | null;
      answers: Record<string, Answer>;
      notes: string[];
    }
  | {
      ok: false; provider: ProviderName | null; request_id: string;
      error: { kind: ErrorKind; status?: number; message: string; retryable: boolean };
      answers?: Record<string, Answer>;
    };

export type Adapter = {
  name: ProviderName;
  label: string;
  path: string;
  defaultModel: string;
  compile(qs: Compiled[], context: string, model: string): unknown;
  /** Throws InvalidResponse when the body doesn't match the provider contract. */
  parse(json: unknown, qs: Compiled[]): { model: string; answers: WireAnswer[]; usage: { input_tokens: number; output_tokens?: number } };
  classify(status: number, body: unknown): { kind: ErrorKind; retryable: boolean };
};

export class InvalidResponse extends Error {}
