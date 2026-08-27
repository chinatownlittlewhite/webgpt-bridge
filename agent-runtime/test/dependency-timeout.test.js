import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createDependencySyncRunner } from "../src/dependency.js";

test("dependency synchronization uses a development-scale timeout instead of the generic 120 second budget", () => {
  const source = fs.readFileSync(new URL("../src/dependency.js", import.meta.url), "utf8");
  assert.match(source, /timeoutMs\s*=\s*10\s*\*\s*60_000/);
  assert.doesNotMatch(source, /timeoutMs\s*=\s*120_000/);
});

test("the command runner accepts the dependency synchronization timeout budget", () => {
  assert.doesNotThrow(() => createDependencySyncRunner({ workspace: process.cwd() }));
});
