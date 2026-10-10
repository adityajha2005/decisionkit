// End-to-end: the real bundle (or an installed bin, via DK_SERVER_BIN) over stdio,
// talking to a localhost mock provider. Run `npm run build` first.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { JEV_CHOICE_RESPONSE, choiceRequest } from "./helpers.ts";

const BIN = process.env.DK_SERVER_BIN ?? join(import.meta.dirname, "..", "dist", "server.mjs");
let http: Server;
let base: string;
const seen: { url: string; auth?: string }[] = [];

before(async () => {
  http = createServer((req, res) => {
    seen.push({ url: req.url!, auth: req.headers.authorization });
    req.resume().on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/models") return res.end(JSON.stringify({ models: [] }));
      res.end(JSON.stringify(JEV_CHOICE_RESPONSE));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(() => http.close());

async function connect(env: Record<string, string>) {
  const command = BIN.endsWith(".mjs") ? process.execPath : BIN;
  const args = BIN.endsWith(".mjs") ? [BIN] : [];
  const client = new Client({ name: "decisionkit-test", version: "0" });
  await client.connect(new StdioClientTransport({ command, args, env: { PATH: process.env.PATH!, ...env }, stderr: "ignore" }));
  return client;
}

const text = (r: any) => JSON.parse(r.content[0].text);

test("stdio: lists tools, decides via the mock provider, logs usage, reports status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dkstate-"));
  const client = await connect({
    DECISIONKIT_PROVIDER: "jev", DECISIONKIT_TYPESAFE_API_KEY: "sk-e2e-SECRET", DECISIONKIT_BASE_URL: base, XDG_STATE_HOME: dir,
  });
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["decide", "status"]);
    assert.match(tools.find((t) => t.name === "decide")!.description!, /third party/);

    const r = await client.callTool({ name: "decide", arguments: choiceRequest(["billing", "technical", "sales"]) });
    assert.notEqual(r.isError, true);
    const body = text(r);
    assert.equal(body.ok, true);
    assert.equal(body.answers.department.choice, "billing");
    assert.equal(seen.at(-1)!.auth, "Bearer sk-e2e-SECRET");

    const s = text(await client.callTool({ name: "status", arguments: {} }));
    assert.equal(s.ready, true);
    assert.deepEqual(s.ping.ok, true);
    assert.equal(s.usage.calls, 1);
    assert.ok(!JSON.stringify(s).includes("sk-e2e-SECRET"), "status must never show key values");

    const log = readFileSync(join(dir, "decisionkit", "usage.jsonl"), "utf8");
    assert.ok(!log.includes("payouts") && !log.includes("sk-e2e-SECRET"));
  } finally {
    await client.close();
  }
});

test("stdio: misconfiguration is an isError result, not a crash", async () => {
  const client = await connect({ DECISIONKIT_PROVIDER: "openai", OPENAI_API_KEY: "ambient-should-be-ignored" });
  try {
    const r = await client.callTool({ name: "decide", arguments: choiceRequest(["a", "b"]) });
    assert.equal(r.isError, true);
    assert.equal(text(r).error.kind, "config");
    const s = text(await client.callTool({ name: "status", arguments: { ping: false } }));
    assert.equal(s.ready, false);
  } finally {
    await client.close();
  }
});
