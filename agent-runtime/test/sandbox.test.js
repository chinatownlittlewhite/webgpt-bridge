import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createBubblewrapAdapter,
  createMacOSSandboxExecAdapter,
  createMacOSSeatbeltAdapter,
  createNoSandboxAdapter,
  createWindowsAppContainerAdapter,
  normalizeSandboxAdapter,
  sandboxSummary,
  wrapWithSandbox,
} from "../src/sandbox.js";
import {
  promoteVerifiedSandboxAdapter,
  verifySandboxAdapter,
} from "../src/sandbox-verify.js";

test("default sandbox adapter is explicitly unsafe for unattended execution", () => {
  const adapter = createNoSandboxAdapter();
  assert.deepEqual(sandboxSummary(adapter), {
    name: "none",
    enforced: false,
    autoRunSafe: false,
    verificationId: "none",
    capabilities: {
      readIsolation: "none",
      writeIsolation: "none",
      networkIsolation: "none",
      processIsolation: "unknown",
    },
  });
  assert.deepEqual(
    wrapWithSandbox(adapter, { argv: ["node", "--version"], cwd: ".", workspace: "." }),
    ["node", "--version"],
  );
});

test("Linux Bubblewrap adapter builds an isolated workspace command with dynamic grants", () => {
  const adapter = createBubblewrapAdapter();
  const wrapped = wrapWithSandbox(adapter, {
    argv: ["node", "--test"],
    cwd: "/workspace/project",
    workspace: "/workspace",
    extraReadPaths: ["/trusted/runtime"],
    extraWritePaths: ["/trusted/git-meta"],
  });

  assert.equal(wrapped[0], "/usr/bin/bwrap");
  assert.ok(wrapped.includes("--unshare-user"));
  assert.ok(wrapped.includes("--unshare-pid"));
  assert.ok(wrapped.includes("--unshare-net"));
  assert.ok(wrapped.includes("--new-session"));
  assert.ok(wrapped.includes("--die-with-parent"));
  assert.ok(wrapped.includes("/trusted/runtime"));
  assert.ok(wrapped.includes("/trusted/git-meta"));
  assert.deepEqual(wrapped.slice(-3), ["--", "node", "--test"]);
  const bindIndex = wrapped.lastIndexOf("--bind");
  assert.deepEqual(wrapped.slice(bindIndex, bindIndex + 3), ["--bind", "/workspace", "/workspace"]);
  assert.equal(adapter.autoRunSafe, false);
});

test("Bubblewrap network policy is fingerprint-bound", () => {
  const isolated = createBubblewrapAdapter();
  const networked = createBubblewrapAdapter({ allowNetwork: true });
  assert.notEqual(isolated.verificationId, networked.verificationId);
  const wrapped = wrapWithSandbox(networked, {
    argv: ["true"],
    cwd: "/workspace",
    workspace: "/workspace",
  });
  assert.equal(wrapped.includes("--unshare-net"), false);
});

test("macOS Seatbelt adapter generates deny-default profile and dynamic grants", () => {
  const adapter = createMacOSSeatbeltAdapter();
  const wrapped = wrapWithSandbox(adapter, {
    argv: ["node", "--test"],
    cwd: "/tmp/project",
    workspace: "/tmp/project",
    extraReadPaths: ["/tmp/trusted-runtime"],
    extraWritePaths: ["/tmp/git-meta"],
  });

  assert.equal(wrapped[0], "/usr/bin/sandbox-exec");
  assert.equal(wrapped[1], "-p");
  assert.match(wrapped[2], /\(deny default\)/);
  assert.match(wrapped[2], /\(deny network\*\)/);
  assert.match(wrapped[2], /\(allow network-inbound \(local tcp "localhost:\*"\)\)/);
  assert.match(wrapped[2], /\(allow network-outbound \(remote tcp "localhost:\*"\)\)/);
  assert.match(wrapped[2], /\(literal "\/"\)/, "Node needs read access to the filesystem root metadata during startup");
  assert.match(wrapped[2], /\/tmp\/project/);
  assert.match(wrapped[2], /\/tmp\/trusted-runtime/);
  assert.match(wrapped[2], /\/tmp\/git-meta/);
  assert.deepEqual(wrapped.slice(-2), ["node", "--test"]);
  assert.equal(adapter.enforced, true);
  assert.equal(adapter.autoRunSafe, false);
  assert.equal(adapter.capabilities.processIsolation, "seatbelt-policy");
});

test("legacy macOS constructor remains fingerprinted and unverified by default", () => {
  const adapter = createMacOSSandboxExecAdapter();
  const networked = createMacOSSandboxExecAdapter({ allowNetwork: true });
  assert.notEqual(networked.verificationId, adapter.verificationId);
  assert.equal(adapter.autoRunSafe, false);
});

test("macOS verified Seatbelt permits localhost while blocking external network", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("native Seatbelt verification runs on macOS");
    return;
  }
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-seatbelt-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const report = await verifySandboxAdapter({
    adapter: createMacOSSeatbeltAdapter(),
    workspace,
  });

  if (report.probe?.stderr?.includes("sandbox_apply: Operation not permitted")) {
    t.skip("a process already inside Seatbelt cannot apply a nested Seatbelt profile");
    return;
  }
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.checks.networkPolicySatisfied, true);
});

test("Windows AppContainer adapter passes only trusted helper arguments and parent pid", () => {
  const adapter = createWindowsAppContainerAdapter({
    helperPath: "/trusted/lpc-windows-sandbox.exe",
    extraReadPaths: ["/trusted/static-runtime"],
  });
  const wrapped = wrapWithSandbox(adapter, {
    argv: ["/trusted/node.exe", "script.js"],
    cwd: "/workspace/project",
    workspace: "/workspace/project",
    extraReadPaths: ["/trusted/runtime"],
    extraWritePaths: ["/workspace/git-meta"],
  });
  assert.equal(wrapped[0], "/trusted/lpc-windows-sandbox.exe");
  assert.ok(wrapped.includes("--parent-pid"));
  assert.ok(wrapped.includes(String(process.pid)));
  assert.ok(wrapped.includes("--network"));
  assert.ok(wrapped.includes("deny"));
  assert.ok(wrapped.includes("--read-path"));
  assert.ok(wrapped.includes("--write-path"));
  assert.deepEqual(wrapped.slice(-3), ["--", "/trusted/node.exe", "script.js"]);
  assert.equal(adapter.capabilities.processIsolation, "windows-job-object");
  assert.equal(adapter.autoRunSafe, false);
});

test("sandbox cannot become auto-run safe without a matching passing verification report", () => {
  const adapter = createMacOSSeatbeltAdapter();
  assert.throws(
    () => promoteVerifiedSandboxAdapter(adapter, { passed: false, adapter: { name: adapter.name, verificationId: adapter.verificationId } }),
    /passing verification report/,
  );

  const promoted = promoteVerifiedSandboxAdapter(adapter, {
    passed: true,
    adapter: { name: adapter.name, verificationId: adapter.verificationId },
  });
  assert.equal(promoted.enforced, true);
  assert.equal(promoted.autoRunSafe, true);

  const networked = createMacOSSeatbeltAdapter({ allowNetwork: true });
  assert.notEqual(networked.verificationId, adapter.verificationId);
  assert.throws(
    () => promoteVerifiedSandboxAdapter(networked, { passed: true, adapter: { name: adapter.name, verificationId: adapter.verificationId } }),
    /exact sandbox configuration/,
  );
});

test("verification rejects an unenforced adapter without spawning", async () => {
  const report = await verifySandboxAdapter({ adapter: createNoSandboxAdapter(), workspace: "." });
  assert.equal(report.passed, false);
  assert.match(report.reason, /not enforced/);
});

test("sandbox adapter shape is validated", () => {
  assert.throws(() => normalizeSandboxAdapter({ name: "broken", enforced: true }), /wrapArgv/);
  assert.throws(
    () => normalizeSandboxAdapter({ name: "bad", enforced: true, autoRunSafe: "yes", wrapArgv() {} }),
    /autoRunSafe/,
  );
  assert.throws(
    () => wrapWithSandbox({ name: "bad-output", enforced: true, wrapArgv: () => [] }, { argv: ["node"], cwd: ".", workspace: "." }),
    /non-empty argv/,
  );
});
