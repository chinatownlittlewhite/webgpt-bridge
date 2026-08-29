const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const policy = require("../src/local-policy.cjs");

test("Desktop path and action adapters expose canonical rule and remember metadata", (t) => {
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "webgpt-policy-adapter-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const known = path.join(root, "Desktop");
  const outside = path.join(root, "other");
  const sensitive = path.join(root, ".ssh");
  const system = path.join(root, "System");
  for (const directory of [workspace, known, outside, sensitive, system]) fs.mkdirSync(directory, { recursive: true });

  const options = {
    workspaceRoot: workspace,
    knownFolderRoots: [known],
    sensitiveRoots: [sensitive],
    systemRoots: [system],
    appDataRoots: [],
    homeDir: root,
  };

  assert.equal(policy.classifyLocalPath(path.join(workspace, "a.txt"), { ...options, operation: "read" }).rule, "workspace-path");
  assert.equal(policy.classifyLocalPath(path.join(known, "a.txt"), { ...options, operation: "read" }).rule, "known-folder-read");
  assert.equal(policy.classifyLocalPath(path.join(outside, "a.txt"), { ...options, operation: "read" }).rule, "ordinary-host-read");
  assert.equal(policy.classifyLocalPath(path.join(sensitive, "config"), { ...options, operation: "read" }).rule, "sensitive-path");
  assert.equal(policy.classifyLocalPath(path.join(system, "config"), { ...options, operation: "read" }).rule, "system-path");

  const sensitiveRead = policy.classifyLocalAction({ kind: "read", sensitive: true, approvalMode: "full_control" });
  assert.equal(sensitiveRead.rule, "sensitive-read");
  assert.equal(sensitiveRead.rememberScope, "single-use");
  assert.equal(sensitiveRead.permissionClass, null);
  assert.equal(policy.classifyLocalAction({ kind: "update", sensitive: true, approvalMode: "full_control" }).rule, "sensitive-mutation");
});

test("Desktop terminal and Host-command adapters preserve canonical deny and sandbox ordering", () => {
  const classification = { decision: "approval_required", rule: "git-mutation", reason: "mutation" };
  const terminal = policy.classifyLocalTerminalApproval({
    argv: ["git", "commit", "-m", "x"],
    classification,
    approvalMode: "development",
  });
  assert.equal(terminal.decision, "confirm");
  assert.equal(terminal.rule, "git-mutation");

  const expanded = policy.classifyHostCommandApproval({
    argv: ["node", "script.mjs"],
    policy: { decision: "approval_required", rule: "runtime-execution", reason: "runtime" },
    sandbox: { enforced: true, autoRunSafe: true },
    sandboxAccess: { read: ["/outside"], write: [] },
  }, "full_control");
  assert.equal(expanded.decision, "confirm");
  assert.equal(expanded.rule, "sandbox-expansion");
  assert.equal(expanded.permissionClass, "host:sandbox-expansion:read:/outside|write:");
  assert.equal(expanded.rememberScope, "connection");

  const denied = policy.classifyHostCommandApproval({
    argv: ["sudo", "rm", "-rf", "/"],
    policy: { decision: "deny", rule: "always-deny", reason: "blocked" },
    sandbox: { enforced: false, autoRunSafe: false },
    sandboxAccess: { read: ["/"], write: ["/"] },
  }, "full_control");
  assert.equal(denied.decision, "deny");
  assert.equal(denied.rule, "always-deny");
});

test("Desktop local policy is a thin adapter over the canonical shared decision engine", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "src", "local-policy.cjs"), "utf8");
  const terminalBroker = fs.readFileSync(path.join(root, "src", "local-terminal-broker.cjs"), "utf8");
  assert.match(source, /security-policy-core\.cjs/);
  assert.match(source, /authorizeSecurityOperation/);
  assert.match(source, /type:\s*"filesystem-path"/);
  assert.match(source, /type:\s*"filesystem-action"/);
  assert.match(source, /type:\s*"terminal-command"/);
  assert.match(source, /type:\s*"host-command"/);
  assert.doesNotMatch(terminalBroker, /const BLOCKED_EXECUTABLES = new Set/);
});
