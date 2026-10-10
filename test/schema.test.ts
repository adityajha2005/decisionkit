import { test } from "node:test";
import assert from "node:assert/strict";
import { DecideRequest } from "../src/schema.ts";

const ok = (r: unknown) => assert.ok(DecideRequest.safeParse(r).success, JSON.stringify(r));
const bad = (r: unknown) => assert.ok(!DecideRequest.safeParse(r).success, JSON.stringify(r));
const q = (extra: object) => ({ context: "c", questions: [{ id: "a", instructions: "i", ...extra }] });
const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `o${i}` }));
const lvls = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `l${i}` }));

test("accepts each question type", () => {
  ok(q({ type: "binary" }));
  ok(q({ type: "binary", criteria: { true: "yes", false: "no" } }));
  ok(q({ type: "choice", options: opts(2) }));
  ok(q({ type: "choice", options: opts(255) }));
  ok(q({ type: "score", levels: lvls(10) }));
  ok(q({ type: "rank", candidates: [{ id: "x", text: "a" }, { id: "y", text: "b" }] }));
});

test("rejects out-of-contract requests", () => {
  bad({ context: "", questions: [{ id: "a", type: "binary", instructions: "i" }] });
  bad({ context: { not: "text" }, questions: [{ id: "a", type: "binary", instructions: "i" }] });
  bad({ context: "c", questions: [] });
  bad(q({ type: "choice", options: opts(1) }));
  bad(q({ type: "choice", options: opts(256) }));
  bad(q({ type: "choice", options: [{ value: "x" }, { value: "x" }] }));
  bad(q({ type: "score", levels: lvls(1) }));
  bad(q({ type: "score", levels: lvls(11) }));
  bad(q({ type: "rank", candidates: [{ id: "x", text: "a" }] }));
  bad(q({ type: "classify" }));
  bad({ context: "c", questions: [{ id: "Bad Id", type: "binary", instructions: "i" }] });
  bad({ context: "c", questions: [{ id: "a", type: "binary", instructions: "i" }, { id: "a", type: "binary", instructions: "j" }] });
});
