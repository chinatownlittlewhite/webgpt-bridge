import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "scripts", "acceptance.mjs"), "utf8");

test("acceptance isolates nested unit-test audit writes from the main audit chain", () => {
  assert.match(source, /function runHost\(argv, \{ cwd = root, env = \{\} \} = \{\}\)/);
  assert.match(source, /env: \{ \.\.\.process\.env, \.\.\.env \}/);
  assert.match(source, /runHost\(\["npm", "test"\], \{ env: \{ LPC_DISABLE_AUDIT: "true" \} \}\);/);
});

test("acceptance reports native sandbox verification details on failure", () => {
  assert.match(source, /native sandbox probe must pass:/);
  assert.match(source, /JSON\.stringify\(server\.runtime\.normalSandbox\.verification\)/);
});
