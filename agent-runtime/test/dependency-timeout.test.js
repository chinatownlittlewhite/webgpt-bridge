import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("dependency synchronization uses a development-scale timeout instead of the generic 120 second budget", () => {
  const source = fs.readFileSync(new URL("../src/dependency.js", import.meta.url), "utf8");
  assert.match(source, /timeoutMs\s*=\s*10\s*\*\s*60_000/);
  assert.doesNotMatch(source, /timeoutMs\s*=\s*120_000/);
});
