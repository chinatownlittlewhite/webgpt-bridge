import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../src/policy.js";

test("read-only git commands are allowed", () => {
  assert.equal(classifyCommand(["git", "status"]).decision, "allow");
  assert.equal(classifyCommand(["git", "diff", "--stat"]).decision, "allow");
  assert.equal(classifyCommand(["git", "branch", "--show-current"]).decision, "allow");
});

test("git mutations and path-sensitive modes require approval", () => {
  assert.equal(classifyCommand(["git", "commit", "-m", "x"]).decision, "approval_required");
  assert.equal(classifyCommand(["git", "branch", "new-branch"]).decision, "approval_required");
  assert.equal(
    classifyCommand(["git", "diff", "--no-index", "/etc/hosts", "/etc/passwd"]).decision,
    "approval_required",
  );
  assert.equal(classifyCommand(["git", "diff", "--output=patch.txt"]).decision, "approval_required");
  assert.equal(classifyCommand(["git", "show", "--ext-diff"]).decision, "approval_required");
  assert.equal(classifyCommand(["git", "log", "--textconv"]).decision, "approval_required");
});

test("package installation requires approval", () => {
  assert.equal(classifyCommand(["npm", "install"]).decision, "approval_required");
});

test("known project checks are allowed", () => {
  assert.equal(classifyCommand(["npm", "run", "lint"]).decision, "allow");
  assert.equal(classifyCommand(["node", "--test"]).decision, "allow");
  assert.equal(classifyCommand(["go", "test", "./..."]).decision, "allow");
  assert.equal(classifyCommand(["cargo", "check"]).decision, "allow");
});

test("privilege escalation and remote file-transfer commands are denied", () => {
  assert.equal(classifyCommand(["sudo", "echo", "x"]).decision, "deny");
  assert.equal(classifyCommand(["scp", "a", "host:b"]).decision, "deny");
  assert.equal(classifyCommand(["sftp", "host"]).decision, "deny");
});

test("unknown commands ask by default", () => {
  assert.equal(classifyCommand(["some-tool", "--flag"]).decision, "approval_required");
});

test("executable paths are rejected to prevent PATH-policy impersonation", () => {
  assert.throws(() => classifyCommand(["/tmp/git", "status"]), /trusted PATH/);
});
