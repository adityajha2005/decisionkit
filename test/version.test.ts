import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

test("version is the same in package.json, plugin.json, server.ts and the README install line", () => {
  const v = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).version, v);
  assert.match(read("src/server.ts"), new RegExp(`VERSION = "${v.replace(/\./g, "\\.")}"`));
  assert.ok(read("README.md").includes(`@adxtya21/decisionkit@${v}`), "README pinned install line");
  assert.ok(read("CHANGELOG.md").includes(`## ${v}`), "CHANGELOG entry");
});
