#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { decide, loadConfig, status } from "./decide.ts";
import { type DecideResult, DecideRequest } from "./schema.ts";

export const VERSION = "0.1.0";

// Loaded under Claude Code (always) and Codex, VS Code, Gemini CLI. Capped at 2,048 chars.
const INSTRUCTIONS = `decisionkit sends a text context plus typed questions to an EXTERNAL decision API
(provider and model are named in every result) and returns probabilities.

Use \`decide\` when ALL hold:
- the answer is from a closed set: yes/no (binary), one of listed options (choice),
  an ordered rubric (score), or an ordering of listed candidates (rank);
- everything needed fits in \`context\` as text you write into the call;
- it is a judgment over text (classify, route, triage, grade, rank), not computation,
  code generation, or fact lookup;
- a probability is useful (e.g. to flag low-certainty cases) or the user asked for it.

Do NOT use it when:
- the context would include secrets, credentials, personal data, or code the user has
  not cleared for sending to this third party;
- the answer is deterministic (a test, regex, or type check decides it);
- a wrong answer has side effects and no human will review it.

Rules:
- Put constraints in \`instructions\`. There is no rationale in results; do not invent one.
- Probabilities are provider estimates, not verified calibrated. Choose thresholds by the
  cost of mistakes; report uncertainty to the user.
- If the result has isError, report the error. Never substitute your own answer as if it
  came from the tool.
- \`rank\` is derived from independent scores; treat close values as ties.
- Call \`status\` to see the active provider, connectivity, and usage totals.`;

// The tool description is the one place every MCP client shows the model.
const DECIDE_DESCRIPTION = `Ask an external decision API (Jev or OpenAI Decisions; the result names which) closed-form questions about a text context: binary (probability true), choice (one of listed options), score (ordered rubric, 0-based), rank (order listed candidates; derived). Returns provider probability estimates, not verified calibrated, and no rationale. Use only for judgments over text with a closed answer set. NEVER put secrets, credentials, personal data, or code the user hasn't cleared into context: it is sent to a third party. If the result is an error, report it; never substitute your own answer.`;

const cfg = loadConfig();
const server = new McpServer({ name: "decisionkit", version: VERSION }, { instructions: INSTRUCTIONS });

server.registerTool("decide", {
  title: "Decide (external decision API)",
  description: DECIDE_DESCRIPTION,
  inputSchema: DecideRequest,
  annotations: { openWorldHint: true }, // deliberately not readOnlyHint: some clients auto-approve those
}, async (args) => {
  const r = await decide(args, cfg).catch((e: Error): DecideResult => ({
    ok: false, provider: null, request_id: "unknown",
    error: { kind: "network", retryable: false, message: `Unexpected failure: ${e.name}` }, // message omitted: may carry request data
  }));
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: !r.ok };
});

server.registerTool("status", {
  title: "decisionkit status",
  description: "Show decisionkit's active provider and model, which DECISIONKIT_* settings it can see (names only, never values), a free connectivity check, and local usage totals (calls, errors, latency, tokens, estimated cost).",
  inputSchema: z.object({ ping: z.boolean().optional().describe("Check connectivity with the provider's free model-listing endpoint. Default true.") }),
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ ping }) => {
  try {
    const s = await status(cfg, process.env, ping ?? true);
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `status failed: ${(e as Error).name}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(JSON.stringify({ level: "info", msg: "decisionkit ready", version: VERSION, provider: "error" in cfg ? null : cfg.provider }) + "\n");
