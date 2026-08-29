import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyCommand } from "../src/policy.js";
import { effectiveCommandPolicy } from "../src/runner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(here, "..");

test("Agent command adapter preserves canonical rule ids and legacy approval_required transport", () => {
  assert.deepEqual(
    { decision: classifyCommand(["bash", "-c", "echo x"]).decision, rule: classifyCommand(["bash", "-c", "echo x"]).rule },
    { decision: "deny", rule: "always-deny" },
  );
  assert.deepEqual(
    { decision: classifyCommand(["git", "status"]).decision, rule: classifyCommand(["git", "status"]).rule },
    { decision: "allow", rule: "git-read-only" },
  );
  assert.deepEqual(
    { decision: classifyCommand(["git", "commit", "-m", "x"]).decision, rule: classifyCommand(["git", "commit", "-m", "x"]).rule },
    { decision: "approval_required", rule: "git-mutation" },
  );
  assert.deepEqual(
    { decision: classifyCommand(["npm", "install"]).decision, rule: classifyCommand(["npm", "install"]).rule },
    { decision: "approval_required", rule: "package-manager" },
  );
  assert.deepEqual(
    { decision: classifyCommand(["node", "script.mjs"]).decision, rule: classifyCommand(["node", "script.mjs"]).rule },
    { decision: "approval_required", rule: "runtime-execution" },
  );
  assert.deepEqual(
    { decision: classifyCommand(["ssh", "10.0.0.8", "uptime"]).decision, rule: classifyCommand(["ssh", "10.0.0.8", "uptime"]).rule },
    { decision: "approval_required", rule: "ssh-network" },
  );
});

test("Agent execution adapter never upgrades deny and canonicalizes sandbox downgrade rules", () => {
  const denied = effectiveCommandPolicy(
    { decision: "deny", rule: "always-deny", reason: "blocked" },
    { name: "verified", enforced: true, autoRunSafe: true },
  );
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "always-deny");

  const unverified = effectiveCommandPolicy(
    { decision: "allow", rule: "project-check", reason: "test command" },
    { name: "macos-seatbelt", enforced: true, autoRunSafe: false },
  );
  assert.equal(unverified.decision, "approval_required");
  assert.equal(unverified.rule, "unverified-sandbox");
  assert.equal(unverified.baseRule, "project-check");

  const unsandboxed = effectiveCommandPolicy(
    { decision: "allow", rule: "project-check", reason: "test command" },
    { name: "none", enforced: false, autoRunSafe: false },
  );
  assert.equal(unsandboxed.decision, "approval_required");
  assert.equal(unsandboxed.rule, "unsandboxed-execution");
});

test("Agent policy and runner are thin adapters over the shared canonical core", () => {
  const policySource = fs.readFileSync(path.join(agentRoot, "src", "policy.js"), "utf8");
  const runnerSource = fs.readFileSync(path.join(agentRoot, "src", "runner.js"), "utf8");
  assert.match(policySource, /\.\.\/\.\.\/shared\/security-policy-core\.cjs/);
  assert.match(policySource, /authorizeSecurityOperation/);
  assert.match(policySource, /isImmutableDeniedExecutable/);
  assert.doesNotMatch(policySource, /const ALWAYS_DENY = new Set/);
  assert.match(runnerSource, /\.\.\/\.\.\/shared\/security-policy-core\.cjs/);
  assert.match(runnerSource, /type:\s*"agent-execution"/);
});
