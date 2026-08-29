const test = require("node:test");
const assert = require("node:assert/strict");

function createFixture({ responses = [] } = {}) {
  const prompts = [];
  const logs = [];
  const dialog = {
    async showMessageBox(...args) {
      const options = args.at(-1);
      prompts.push(options);
      return { response: responses.length ? responses.shift() : 1 };
    },
  };
  const { createHostSecurity } = require("../src/host/host-security.cjs");
  const security = createHostSecurity({
    dialog,
    dialogOwner: () => undefined,
    appendLog: (source, line) => logs.push({ source, line }),
  });
  return { security, prompts, logs };
}

test("full_control auto-approves ordinary requests but never bypasses explicit Host consent", async () => {
  const fixture = createFixture();
  fixture.security.setApprovalMode("full_control");

  assert.equal(await fixture.security.confirmLocalOperation({
    kind: "terminal-command",
    argv: ["git", "status"],
    cwd: "/workspace",
    policy: { rule: "default-ask" },
  }), true);
  assert.equal(fixture.prompts.length, 0);

  for (const request of [
    { kind: "sensitive-access", operation: "read", path: "/home/user/.ssh/id_ed25519" },
    { kind: "known-folder-access", folder: "desktop", operation: "read", path: "/home/user/Desktop/a.txt" },
    { kind: "host-path-access", operation: "read", path: "/home/user/other/a.txt", permissionClass: "host-read:/home/user/other" },
  ]) {
    assert.equal(await fixture.security.confirmLocalOperation(request), true);
  }
  assert.equal(fixture.prompts.length, 3);
});

test("connection-scoped approval is remembered while sensitive approval remains single-use", async () => {
  const fixture = createFixture();
  fixture.security.setApprovalMode("development");

  const known = { kind: "known-folder-access", folder: "documents", operation: "read", path: "/home/user/Documents/a.txt" };
  assert.equal(await fixture.security.confirmLocalOperation(known), true);
  assert.equal(await fixture.security.confirmLocalOperation(known), true);
  assert.equal(fixture.prompts.length, 1);

  const sensitive = { kind: "sensitive-access", operation: "read", path: "/home/user/.ssh/id_ed25519" };
  assert.equal(await fixture.security.confirmLocalOperation(sensitive), true);
  assert.equal(await fixture.security.confirmLocalOperation(sensitive), true);
  assert.equal(fixture.prompts.length, 3);

  fixture.security.clearApprovals();
  assert.equal(await fixture.security.confirmLocalOperation(known), true);
  assert.equal(fixture.prompts.length, 4);
});

test("Host command immutable deny never opens a confirmation prompt", async () => {
  const fixture = createFixture();
  fixture.security.setApprovalMode("full_control");
  const result = await fixture.security.confirmHostCommandApproval({
    request: {
      argv: ["bash", "-lc", "true"],
      cwd: "/workspace",
      policy: { decision: "deny", rule: "always-deny", reason: "shell disabled" },
      sandbox: { enforced: true, autoRunSafe: true },
      sandboxAccess: { read: [], write: [] },
    },
  });
  assert.deepEqual(result, { approved: false });
  assert.equal(fixture.prompts.length, 0);
  assert.match(fixture.logs.at(-1).line, /已拒绝/);
});

test("Host command approval validates the trusted request shape", async () => {
  const fixture = createFixture();
  await assert.rejects(() => fixture.security.confirmHostCommandApproval({ request: { argv: [], cwd: "/workspace" } }), /格式无效/);
  await assert.rejects(() => fixture.security.confirmHostCommandApproval({ request: { argv: ["git", "status"], cwd: "" } }), /工作目录/);
});
