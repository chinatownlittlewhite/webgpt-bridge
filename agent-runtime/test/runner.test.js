import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRunner, runnerSecurityNotes } from "../src/runner.js";

const verifiedTestSandbox = Object.freeze({
  name: "test-verified",
  enforced: true,
  autoRunSafe: true,
  capabilities: {
    readIsolation: "test",
    writeIsolation: "test",
    networkIsolation: "test",
  },
  wrapArgv({ argv }) {
    return [...argv];
  },
});

const unverifiedTestSandbox = Object.freeze({
  ...verifiedTestSandbox,
  name: "test-unverified",
  autoRunSafe: false,
});

test("safe-looking commands still require approval without an OS sandbox", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root, timeoutMs: 10_000 });
  const result = await run({ argv: ["node", "--test"] });
  assert.equal(result.status, "approval_required");
  assert.equal(result.policy.rule, "unsandboxed-execution");
  assert.equal(result.policy.baseRule, "project-check");
  assert.equal(result.sandbox.name, "none");
  assert.equal(result.sandbox.autoRunSafe, false);
  assert.match(result.approvalRequest.id, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.approvalRequest.argv, ["node", "--test"]);
  assert.ok(Array.isArray(result.approvalRequest.resolvedArgv));
  assert.ok(path.isAbsolute(result.approvalRequest.resolvedArgv[0]));
  assert.equal(result.approvalRequest.cwd, ".");
  fs.rmSync(root, { recursive: true, force: true });
});

test("an enforced but unverified sandbox does not enable unattended execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({
    workspace: root,
    timeoutMs: 10_000,
    sandboxAdapter: unverifiedTestSandbox,
  });
  const result = await run({ argv: ["node", "--test"] });
  assert.equal(result.status, "approval_required");
  assert.equal(result.policy.rule, "unverified-sandbox");
  assert.equal(result.sandbox.enforced, true);
  assert.equal(result.sandbox.autoRunSafe, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("allowed command executes without approval when a verified sandbox is supplied", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  fs.writeFileSync(
    path.join(root, "sample.test.js"),
    'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => assert.equal(1, 1));\n',
  );

  const run = createCommandRunner({
    workspace: root,
    timeoutMs: 10_000,
    sandboxAdapter: verifiedTestSandbox,
  });
  const result = await run({ argv: ["node", "--test", "sample.test.js"] });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /pass 1/);
  assert.equal(result.sandbox.name, "test-verified");
  assert.equal(result.sandbox.autoRunSafe, true);
  assert.equal(result.approvalRequest, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("host approval is bound to the exact request before spawning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root, timeoutMs: 10_000 });
  let seen = null;
  const result = await run({
    argv: ["node", "-e", "process.stdout.write(process.env.NODE_ENV ?? '')"],
    env: { NODE_ENV: "test" },
    requestApproval(request) {
      seen = request;
      return true;
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "test");
  assert.deepEqual(seen.argv, ["node", "-e", "process.stdout.write(process.env.NODE_ENV ?? '')"]);
  assert.ok(path.isAbsolute(seen.resolvedArgv[0]));
  assert.deepEqual(seen.env, { NODE_ENV: "test" });
  assert.equal(seen.cwd, ".");
  assert.equal(result.approvalRequest.id, seen.id);
  fs.rmSync(root, { recursive: true, force: true });
});

test("host denial prevents spawning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root });
  const result = await run({
    argv: ["node", "-e", "process.exit(0)"],
    requestApproval() {
      return false;
    },
  });
  assert.equal(result.status, "approval_denied");
  assert.match(result.approvalRequest.id, /^[a-f0-9]{64}$/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("approval callback errors are surfaced without spawning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root });
  const result = await run({
    argv: ["node", "-e", "process.exit(0)"],
    requestApproval() {
      throw new Error("approval service unavailable");
    },
  });
  assert.equal(result.status, "approval_error");
  assert.match(result.error, /approval service unavailable/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("arbitrary runtime execution stops at approval when no host callback exists", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root });
  const result = await run({ argv: ["node", "-e", "console.log('hello')"] });
  assert.equal(result.status, "approval_required");
  assert.equal(result.policy.rule, "runtime-execution");
  fs.rmSync(root, { recursive: true, force: true });
});

test("blocked commands never request approval or spawn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root });
  let called = false;
  const result = await run({
    argv: ["sudo", "echo", "hello"],
    requestApproval() {
      called = true;
      return true;
    },
  });
  assert.equal(result.status, "denied");
  assert.equal(called, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unsafe environment injection is rejected before approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-"));
  const run = createCommandRunner({ workspace: root });
  let called = false;
  await assert.rejects(
    run({
      argv: ["node", "--test"],
      env: { NODE_OPTIONS: "--require=x" },
      requestApproval() {
        called = true;
        return true;
      },
    }),
    /not allowed/,
  );
  assert.equal(called, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("verified sandbox scope is narrowed to the resolved command cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-scope-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, "sample.test.js"),
    'import test from "node:test";\ntest("ok", () => {});\n',
  );
  let seenWorkspace = null;
  const sandbox = {
    ...verifiedTestSandbox,
    name: "scope-spy",
    wrapArgv({ argv, workspace }) {
      seenWorkspace = workspace;
      return [...argv];
    },
  };
  const run = createCommandRunner({ workspace: root, sandboxAdapter: sandbox, timeoutMs: 10_000 });
  const result = await run({
    argv: ["node", "--test", "sample.test.js"],
    cwd: "project",
  });
  assert.equal(result.status, "completed");
  assert.equal(seenWorkspace, fs.realpathSync(project));
  fs.rmSync(root, { recursive: true, force: true });
});

test("host-only sandbox access grants are approval-bound and are not model schema fields", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-grant-"));
  const extra = path.join(root, "managed-extra");
  fs.mkdirSync(extra);
  const run = createCommandRunner({ workspace: root });
  let seen = null;
  const result = await run({
    argv: ["node", "-e", "process.exit(0)"],
    sandboxExtraWritePaths: [extra],
    requestApproval(request) {
      seen = request;
      return false;
    },
  });
  assert.equal(result.status, "approval_denied");
  assert.deepEqual(seen.sandboxAccess.write, [path.resolve(extra)]);
  assert.deepEqual(seen.sandboxAccess.read, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("trusted temporary directories remain inside the command cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-runner-temp-"));
  const run = createCommandRunner({ workspace: root });
  const result = await run({
    argv: ["node", "-e", "process.stdout.write(require('node:os').tmpdir())"],
    requestApproval: () => true,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  const temp = fs.realpathSync(result.stdout);
  assert.ok(temp.startsWith(fs.realpathSync(root)));
  fs.rmSync(root, { recursive: true, force: true });
});

test("security notes describe final-acceptance sandbox, shim, and process-tree requirements", () => {
  assert.equal(runnerSecurityNotes.filesystemIsolation, "adapter-dependent");
  assert.equal(runnerSecurityNotes.networkIsolation, "adapter-dependent");
  assert.equal(runnerSecurityNotes.defaultSandbox, "none");
  assert.equal(runnerSecurityNotes.autoAllowRequiresVerifiedSandbox, true);
  assert.equal(runnerSecurityNotes.hostApprovalIsRequestBound, true);
  assert.equal(runnerSecurityNotes.approvalBindsResolvedArgv, true);
  assert.equal(runnerSecurityNotes.windowsBatchFilesRequireTrustedShim, true);
  assert.equal(runnerSecurityNotes.processTreeTermination, "platform-native");
  assert.equal(runnerSecurityNotes.sandboxScope, "resolved-cwd");
  assert.equal(runnerSecurityNotes.shell, false);
});
