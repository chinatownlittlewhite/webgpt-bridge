import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  createSandboxProbeEnvironment,
  evaluateSandboxProbeChecks,
  promoteVerifiedSandboxAdapter,
  verifySandboxAdapter,
} from "../src/sandbox-verify.js";
import { nativeSandboxVerificationRequirements } from "../src/native-sandbox.js";

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

test("Windows sandbox probe supplies a workspace-local LOCALAPPDATA required by AppContainer", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-win-probe-env-"));
  try {
    const env = createSandboxProbeEnvironment(workspace, {
      platform: "win32",
      sourceEnv: {
        PATH: "C:\\tools",
        SystemRoot: "C:\\Windows",
        LOCALAPPDATA: "C:\\host-private\\Local",
      },
    });
    assert.equal(env.PATH, "C:\\tools");
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.notEqual(env.LOCALAPPDATA, "C:\\host-private\\Local");
    assert.ok(env.LOCALAPPDATA.startsWith(workspace));
    assert.ok(env.APPDATA.startsWith(workspace));
    assert.ok(env.USERPROFILE.startsWith(workspace));
    assert.equal(fs.statSync(env.LOCALAPPDATA).isDirectory(), true);
    assert.equal(fs.statSync(env.APPDATA).isDirectory(), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Windows no-network verification may block loopback while still requiring external isolation", () => {
  const probeResult = {
    insideWrite: true,
    outsideReadBlocked: true,
    outsideWriteBlocked: true,
    loopbackAllowed: false,
    externalNetworkBlocked: true,
  };
  const windows = evaluateSandboxProbeChecks({
    probeResult,
    loopbackConnected: false,
    requireNetworkBlocked: true,
    requireLoopback: false,
  });
  assert.equal(windows.passed, true);
  assert.equal(windows.checks.networkPolicySatisfied, true);

  const loopbackRequired = evaluateSandboxProbeChecks({
    probeResult,
    loopbackConnected: false,
    requireNetworkBlocked: true,
    requireLoopback: true,
  });
  assert.equal(loopbackRequired.passed, false);
  assert.equal(loopbackRequired.checks.networkPolicySatisfied, false);
});

test("native sandbox verification requirements preserve stricter Windows no-network semantics", () => {
  assert.deepEqual(nativeSandboxVerificationRequirements({ platform: "win32", allowNetwork: false }), {
    requireNetworkBlocked: true,
    requireLoopback: false,
    timeoutMs: 30_000,
  });
  assert.deepEqual(nativeSandboxVerificationRequirements({ platform: "darwin", allowNetwork: false }), {
    requireNetworkBlocked: true,
    requireLoopback: true,
    timeoutMs: 5_000,
  });
  assert.deepEqual(nativeSandboxVerificationRequirements({ platform: "win32", allowNetwork: true }), {
    requireNetworkBlocked: false,
    requireLoopback: false,
    timeoutMs: 30_000,
  });
});

test("Windows native helper preserves Win32 error codes in diagnostics", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "native", "windows-sandbox", "Program.cs"), "utf8");
  assert.match(source, /Win32Exception win32/);
  assert.match(source, /NativeErrorCode/);
});

test("Windows helper does not claim a custom Unicode environment when inheriting the parent environment", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "native", "windows-sandbox", "Program.cs"), "utf8");
  assert.match(source, /var flags = ExtendedStartupInfoPresent \| CreateSuspended;/);
  assert.doesNotMatch(source, /CreateUnicodeEnvironment/);
  assert.match(source, /IntPtr lpEnvironment/);
});

test("Windows helper passes only valid inheritable standard handles into AppContainer", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "native", "windows-sandbox", "Program.cs"), "utf8");
  assert.match(source, /PrepareInheritableStdHandle/);
  assert.match(source, /DuplicateHandle/);
  assert.match(source, /CreateFileW\("NUL"/);
  assert.doesNotMatch(source, /hStdInput = Native\.GetStdHandle/);
  assert.doesNotMatch(source, /hStdOutput = Native\.GetStdHandle/);
  assert.doesNotMatch(source, /hStdError = Native\.GetStdHandle/);
});

test("Windows AppContainer child inherits the helper cwd instead of restating a drive path", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "native", "windows-sandbox", "Program.cs"), "utf8");
  assert.match(source, /string\? lpCurrentDirectory/);
  assert.match(source, /Inherit it here instead of restating a drive-qualified path/);
  assert.match(source, /null,\s*ref startup,/s);
});

test("Windows helper grants runtime ACLs through Win32 APIs without spawning icacls", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "native", "windows-sandbox", "Program.cs"), "utf8");
  assert.match(source, /GrantTraversalAcl\(Path\.GetDirectoryName\(executable\)!, appContainerSid\)/);
  assert.match(source, /GrantTraversalAcl\(resolved, appContainerSid\)/);
  assert.match(source, /Native\.GetNamedSecurityInfoW/);
  assert.match(source, /Native\.SetEntriesInAclW/);
  assert.match(source, /Native\.SetNamedSecurityInfoW/);
  assert.match(source, /if \(profile\.Created\)\s*\{\s*GrantAcl\(workspace, appContainerSid, modify: true\);\s*\}/s);
  assert.doesNotMatch(source, /icacls\.exe/);
  assert.doesNotMatch(source, /Process\.Start\(psi\)/);
  const traversalStart = source.indexOf("private static void GrantTraversalAcl");
  const traversalEnd = source.indexOf("private static int LaunchInAppContainer", traversalStart);
  const traversalBody = source.slice(traversalStart, traversalEnd);
  assert.match(traversalBody, /inherit: false/);
  assert.doesNotMatch(traversalBody, /recursive: true/);
});

test("native sandbox verification uses a small workspace-local probe directory", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, "..", "src", "sandbox-verify.js"), "utf8");
  assert.match(source, /const probeWorkspace = fs\.mkdtempSync\(path\.join\(createWorkspaceTemp\(root\), "sandbox-probe-"\)\);/);
  assert.match(source, /workspace: probeWorkspace/);
  assert.match(source, /fs\.rmSync\(probeWorkspace, \{ recursive: true, force: true \}\);/);
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
