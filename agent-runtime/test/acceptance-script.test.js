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

test("Windows native developer smoke uses the production command timeout budget", () => {
  assert.match(source, /timeoutMs: process\.platform === "win32" \? 120_000 : 30_000/);
});

test("Windows acceptance mirrors the desktop Git broker architecture", () => {
  assert.match(source, /\\\\\\\\\.\\\\pipe\\\\webgpt-bridge-acceptance-/);
  assert.match(source, /createAcceptanceGitBroker/);
  assert.match(source, /createGitTool/);
  assert.match(source, /localBrokerSocket: gitBrokerSocket/);
  assert.match(source, /process\.platform === "win32" \? \[\["node", "--version"\], \["npm", "--version"\]\]/);
  assert.match(source, /await git\.invoke\(\{ action: "status", cwd: path\.relative\(root, repo\) \}\)/);
});
