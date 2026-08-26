import test from "node:test";
import assert from "node:assert/strict";
import { killProcessTree } from "../src/process-tree.js";

test("macOS managed-process kill signals the parent guard so it can clean descendants", async () => {
  const signals = [];
  const child = { pid: 4242, kill(signal) { signals.push(signal); return true; } };
  const killed = await killProcessTree(child, { platform: "darwin", force: true });
  assert.equal(killed, true);
  assert.deepEqual(signals, ["SIGTERM"]);
});
