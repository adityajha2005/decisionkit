import { parseArgs } from "node:util";
import { ADAPTERS, decide, loadConfig, status } from "./decide.ts";
import type { Question } from "./schema.ts";

const HELP = `decisionkit — ask a decision API a closed question about some text.

Usage (context comes from stdin, or --context):
  decisionkit binary "<question>"                       prints: true|false <p_true>
  decisionkit choice "<question>" <option> <option>...   prints: <choice> <p>
  decisionkit score  "<question>" <level> <level>...     levels low→high; prints: <most likely> <p> (expected <n>)
  decisionkit rank   "<question>" <candidate> <candidate>...   prints candidates best first
  decisionkit status                                    provider, connectivity, usage totals
  decisionkit                                           (no arguments) run as an MCP server

Options:
  --context <text>    use this instead of stdin
  --threshold <p>     binary: answer is true only if p_true >= p (default 0.5)
                      choice/score: exit 1 if the top probability is below p
  --json              print the full result as JSON
  --quiet             don't print which provider received the data (stderr)

Exit codes: 0 = true / confident, 1 = false / below threshold, 2 = error.
Configure with DECISIONKIT_PROVIDER (jev | openrouter | openai) and that provider's
DECISIONKIT_*_API_KEY. Your text is sent to that provider.`;

/** Returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true,
      options: { context: { type: "string" }, threshold: { type: "string" }, json: { type: "boolean" }, quiet: { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    return usage((e as Error).message);
  }
  const { values: opt, positionals: [cmd, question, ...items] } = parsed;
  if (opt.help || cmd === "help") { console.log(HELP); return 0; }

  const cfg = loadConfig();
  if (cmd === "status") {
    console.log(JSON.stringify(await status(cfg, process.env, true), null, 2));
    return "error" in cfg ? 2 : 0;
  }

  const threshold = opt.threshold === undefined ? undefined : Number(opt.threshold);
  if (threshold !== undefined && !(threshold >= 0 && threshold <= 1)) return usage("--threshold must be a number from 0 to 1");
  if (!question) return usage(`missing question for "${cmd}"`);

  const q = toQuestion(cmd!, question, items);
  if (typeof q === "string") return usage(q);

  const context = opt.context ?? (process.stdin.isTTY ? "" : await readStdin());
  if (!context.trim()) return usage("no context: pipe text on stdin or pass --context");

  const r = await decide({ context, questions: [q] }, cfg);
  if (!opt.quiet && r.ok) {
    process.stderr.write(`decisionkit: sent to ${ADAPTERS[r.provider].label} (${r.model}) · ${r.latency_ms} ms · $${(r.estimated_cost_usd ?? 0).toFixed(6)}\n`);
  }
  if (!r.ok) {
    if (opt.json) console.log(JSON.stringify(r, null, 2));
    process.stderr.write(`decisionkit: ${r.error.kind}: ${r.error.message}\n`);
    return 2;
  }
  if (opt.json) console.log(JSON.stringify(r, null, 2));

  const a = r.answers.q!;
  if (a.type === "binary") {
    const yes = a.probability_true >= (threshold ?? 0.5);
    if (!opt.json) console.log(`${yes} ${round(a.probability_true)}`);
    return yes ? 0 : 1;
  }
  if (a.type === "choice" || a.type === "score") {
    const top = a.type === "choice" ? a.choice : a.most_likely;
    const p = a.probabilities[top] ?? 0;
    if (!opt.json) console.log(a.type === "choice" ? `${top} ${round(p)}` : `${top} ${round(p)} (expected ${round(a.expected_level)})`);
    return threshold !== undefined && p < threshold ? 1 : 0;
  }
  if (a.type === "rank") {
    if (!opt.json) for (const x of a.ranking) console.log(`${round(x.expected_level)}\t${items[Number(x.candidate_id.slice(1))]}`);
    return 0;
  }
  return 2; // unreachable: refusals are errors above
}

function toQuestion(cmd: string, instructions: string, items: string[]): Question | string {
  if (!["binary", "choice", "score", "rank"].includes(cmd)) return `unknown command "${cmd}"`;
  if (cmd === "binary") return items.length ? "binary takes no options" : { id: "q", type: "binary", instructions };
  if (items.length < 2) return `${cmd} needs at least 2 options`;
  if (cmd === "choice") return { id: "q", type: "choice", instructions, options: items.map((value) => ({ value })) };
  if (cmd === "score") return { id: "q", type: "score", instructions, levels: items.map((label) => ({ label })) };
  // Candidate ids must match ^[a-z0-9_]+$, so index them; the text is printed back on output.
  return { id: "q", type: "rank", instructions, candidates: items.map((text, i) => ({ id: `c${i}`, text })) };
}

function usage(msg: string) {
  process.stderr.write(`decisionkit: ${msg}\nRun "decisionkit --help" for usage.\n`);
  return 2;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}
