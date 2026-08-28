import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/policy.js";

test("Agent classifies ssh as approval-gated instead of always denied", () => {
  const result = classifyCommand(["ssh", "10.0.0.8", "uptime"]);
  assert.equal(result.decision, "approval_required");
  assert.equal(result.rule, "ssh-network");
});

test("Agent continues to deny scp and sftp", () => {
  for (const command of ["scp", "sftp"]) {
    const result = classifyCommand([command, "example"]);
    assert.equal(result.decision, "deny");
    assert.equal(result.rule, "always-deny");
  }
});
