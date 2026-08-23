import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalRequest, requestHostApproval } from "../src/approval.js";

const base = {
  argv: ["node", "--test"],
  resolvedArgv: ["/trusted/node", "--test"],
  platform: "linux",
  cwd: ".",
  env: { NODE_ENV: "test" },
  policy: {
    decision: "approval_required",
    rule: "unsandboxed-execution",
    baseRule: "project-check",
    reason: "approval required",
  },
  sandbox: {
    name: "none",
    enforced: false,
    autoRunSafe: false,
    verificationId: "none",
  },
  sandboxAccess: { read: [], write: [] },
};

test("approval id is stable for equivalent requests", () => {
  const a = createApprovalRequest(base);
  const b = createApprovalRequest({ ...base, env: { NODE_ENV: "test" } });
  assert.equal(a.id, b.id);
  assert.match(a.id, /^[a-f0-9]{64}$/);
});

test("approval id changes when original/resolved argv, platform, cwd, env, or sandbox grants change", () => {
  const original = createApprovalRequest(base).id;
  assert.notEqual(createApprovalRequest({ ...base, argv: ["node", "--test", "x.js"] }).id, original);
  assert.notEqual(createApprovalRequest({ ...base, resolvedArgv: ["/trusted/node2", "--test"] }).id, original);
  assert.notEqual(createApprovalRequest({ ...base, platform: "windows" }).id, original);
  assert.notEqual(createApprovalRequest({ ...base, cwd: "subproject" }).id, original);
  assert.notEqual(createApprovalRequest({ ...base, env: { NODE_ENV: "production" } }).id, original);
  assert.notEqual(createApprovalRequest({ ...base, sandboxAccess: { read: ["/runtime"], write: [] } }).id, original);
  assert.notEqual(createApprovalRequest({ ...base, sandboxAccess: { read: [], write: ["/managed"] } }).id, original);
});

test("approval request snapshots are immutable", () => {
  const request = createApprovalRequest(base);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.argv), true);
  assert.equal(Object.isFrozen(request.resolvedArgv), true);
  assert.equal(Object.isFrozen(request.env), true);
  assert.equal(Object.isFrozen(request.policy), true);
  assert.equal(Object.isFrozen(request.sandbox), true);
  assert.equal(Object.isFrozen(request.sandboxAccess), true);
  assert.equal(Object.isFrozen(request.sandboxAccess.read), true);
  assert.equal(Object.isFrozen(request.sandboxAccess.write), true);
});

test("host approval helper distinguishes missing, denied, approved, and error", async () => {
  const request = createApprovalRequest(base);
  assert.deepEqual(await requestHostApproval(undefined, request), { status: "missing", approved: false });
  assert.deepEqual(await requestHostApproval(() => false, request), { status: "denied", approved: false });
  assert.deepEqual(await requestHostApproval(() => true, request), { status: "approved", approved: true });
  const failed = await requestHostApproval(() => {
    throw new Error("boom");
  }, request);
  assert.equal(failed.status, "error");
  assert.match(failed.error, /boom/);
});
