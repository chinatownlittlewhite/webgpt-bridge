import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuditLogger } from "../src/audit.js";

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("audit logger creates a contiguous hash chain and redacts secret-key fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-audit-"));
  const logger = createAuditLogger({ workspace: root });
  logger.record({ type: "one", token: "do-not-log", nested: { password: "hidden", visible: "ok" } });
  logger.record({ type: "two", value: 2 });

  const lines = fs.readFileSync(logger.file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].event.token, "[REDACTED]");
  assert.equal(lines[0].event.nested.password, "[REDACTED]");
  assert.equal(lines[0].event.nested.visible, "ok");
  assert.equal(lines[1].previousHash, lines[0].hash);
  assert.equal(lines[1].sequence, lines[0].sequence + 1);

  for (const entry of lines) {
    const base = {
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      event: entry.event,
    };
    assert.equal(entry.hash, hash(JSON.stringify(base)));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test("audit logger redacts common command-line secret forms", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-audit-argv-"));
  const logger = createAuditLogger({ workspace: root });
  logger.record({
    type: "command",
    argv: [
      "tool",
      "--token",
      "plain-token",
      "--password=hunter2",
      "Authorization: Bearer abc123",
      "https://user:pass@example.invalid/path",
    ],
  });
  const entry = JSON.parse(fs.readFileSync(logger.file, "utf8").trim());
  assert.deepEqual(entry.event.argv, [
    "tool",
    "--token",
    "[REDACTED]",
    "--password=[REDACTED]",
    "Authorization: Bearer [REDACTED]",
    "https://[REDACTED]@example.invalid/path",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("disabled audit logger performs no filesystem writes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-audit-disabled-"));
  const logger = createAuditLogger({ workspace: root, enabled: false });
  assert.equal(logger.enabled, false);
  assert.equal(logger.record({ token: "x" }), null);
  assert.equal(fs.existsSync(path.join(root, ".webgpt-bridge", "audit.jsonl")), false);
  fs.rmSync(root, { recursive: true, force: true });
});
