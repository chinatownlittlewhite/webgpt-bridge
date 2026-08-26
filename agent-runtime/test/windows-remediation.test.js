import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const buildNativeSource = fs.readFileSync(new URL("../scripts/build-native.mjs", import.meta.url), "utf8");
const doctorSource = fs.readFileSync(new URL("../scripts/doctor.mjs", import.meta.url), "utf8");
const sandboxVerifySource = fs.readFileSync(new URL("../src/sandbox-verify.js", import.meta.url), "utf8");

test("Windows native build publishes one combined host and prefers NativeAOT with a single-file fallback", () => {
  assert.match(buildNativeSource, /native\/windows-host\/LocalProjectCoding\.WindowsHost\.csproj/);
  assert.match(buildNativeSource, /lpc-windows-host\.exe/);
  assert.match(buildNativeSource, /PublishAot=true/);
  assert.match(buildNativeSource, /PublishSingleFile=true/);
  assert.match(buildNativeSource, /"--self-contained",\s*"true"/);
  assert.doesNotMatch(buildNativeSource, /nativeProjects\s*=\s*\[/);
});

test("Windows host preparation probe is read-only, structured, and fixed to the product capability", async () => {
  const nativeSandbox = await import("../src/native-sandbox.js");
  assert.equal(typeof nativeSandbox.probeWindowsHostPreparation, "function");
  if (typeof nativeSandbox.probeWindowsHostPreparation !== "function") return;

  const missing = nativeSandbox.probeWindowsHostPreparation({
    platform: "win32",
    helperPath: "C:\\Bridge\\lpc-windows-host-prep.exe",
    existsSync: () => false,
  });
  assert.equal(missing.status, "helper_missing");
  assert.equal(missing.usable, false);
  assert.equal(missing.capabilityName, "com.localagenthost.desktop.null-device");

  let invocation;
  const ready = nativeSandbox.probeWindowsHostPreparation({
    platform: "win32",
    helperPath: "C:\\Bridge\\lpc-windows-host-prep.exe",
    existsSync: () => true,
    spawnSyncImpl: (executable, args, options) => {
      invocation = { executable, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          status: "ready",
          capabilityName: "com.localagenthost.desktop.null-device",
          capabilitySid: "S-1-15-3-123",
          target: "NUL",
        }),
        stderr: "",
      };
    },
  });
  assert.deepEqual(invocation.args, ["host-prep", "--check", "--json"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(ready.status, "ready");
  assert.equal(ready.usable, true);
  assert.equal(ready.capabilityName, "com.localagenthost.desktop.null-device");
});

test("Windows NUL sandbox probe preserves the failing syscall diagnostics", () => {
  assert.match(sandboxVerifySource, /nullDeviceFailure/);
  assert.match(sandboxVerifySource, /nullDeviceStage\s*=\s*"open"/);
  assert.match(sandboxVerifySource, /nullDeviceStage\s*=\s*"write"/);
  assert.match(sandboxVerifySource, /nullDeviceStage\s*=\s*"read"/);
  assert.match(sandboxVerifySource, /stage:\s*nullDeviceStage/);
  assert.match(sandboxVerifySource, /code:\s*error\?\.code/);
  assert.match(sandboxVerifySource, /errno:\s*error\?\.errno/);
  assert.match(sandboxVerifySource, /syscall:\s*error\?\.syscall/);
  assert.match(sandboxVerifySource, /path:\s*error\?\.path/);
});

test("Windows NUL sandbox probe uses Node's platform null-device path", () => {
  assert.match(sandboxVerifySource, /fs\.openSync\(os\.devNull,\s*"r\+"\)/);
  assert.doesNotMatch(sandboxVerifySource, /fs\.openSync\("NUL",\s*"r\+"\)/);
});

test("Windows doctor treats dotnet as a build-host concern rather than a target runtime prerequisite", () => {
  assert.doesNotMatch(doctorSource, /check\("\.NET 8 SDK\/runtime"[^\n]*true\)/);
  assert.match(doctorSource, /Windows AppContainer sandbox helper/);
  assert.match(doctorSource, /probeWindowsHostPreparation/);
  assert.match(doctorSource, /Windows host preparation/);
});

test("doctor uses the trusted GitHub CLI resolver and reports resolved path/version diagnostics", () => {
  assert.match(doctorSource, /resolveGitHubCli/);
  assert.match(doctorSource, /gh\.resolvedPath/);
  assert.match(doctorSource, /gh\.version/);
});

test("sandbox preparation diagnostics distinguish disabled, missing helper, verification failure, and ready", async () => {
  const nativeSandbox = await import("../src/native-sandbox.js");
  assert.equal(typeof nativeSandbox.sandboxPreparationDiagnostic, "function");
  if (typeof nativeSandbox.sandboxPreparationDiagnostic !== "function") return;

  const disabled = nativeSandbox.sandboxPreparationDiagnostic(null, { enabled: false, platform: "win32", allowNetwork: true });
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.usable, false);

  const missing = nativeSandbox.sandboxPreparationDiagnostic({
    discovery: { available: false, reason: "Windows AppContainer helper not found at C:\\Bridge\\lpc-windows-sandbox.exe", expectedPath: "C:\\Bridge\\lpc-windows-sandbox.exe" },
    verification: null,
    summary: { name: "none", enforced: false, autoRunSafe: false },
  }, { enabled: true, platform: "win32", allowNetwork: true });
  assert.equal(missing.status, "helper_missing");
  assert.equal(missing.expectedPath, "C:\\Bridge\\lpc-windows-sandbox.exe");
  assert.equal(missing.recoverable, true);

  const failed = nativeSandbox.sandboxPreparationDiagnostic({
    discovery: { available: true, reason: "Windows AppContainer helper found", expectedPath: "C:\\Bridge\\lpc-windows-sandbox.exe" },
    verification: { passed: false, reason: "sandbox probe failed to execute", probe: { code: 2147516566 } },
    summary: { name: "windows-appcontainer", enforced: true, autoRunSafe: false },
  }, { enabled: true, platform: "win32", allowNetwork: true });
  assert.equal(failed.status, "verification_failed");
  assert.equal(failed.errorCode, 2147516566);
  assert.equal(failed.usable, false);

  const hostPreparationFailed = nativeSandbox.sandboxPreparationDiagnostic({
    discovery: { available: true, reason: "Windows AppContainer helper found", expectedPath: "C:\\Bridge\\lpc-windows-sandbox.exe" },
    hostPreparation: {
      status: "capability_ace_missing",
      usable: false,
      capabilityName: "com.localagenthost.desktop.null-device",
      remediation: "Repair the Windows installation as administrator.",
    },
    verification: { passed: false, reason: "Windows host preparation is capability_ace_missing", checks: null },
    summary: { name: "windows-appcontainer", enforced: true, autoRunSafe: false },
  }, { enabled: true, platform: "win32", allowNetwork: false });
  assert.equal(hostPreparationFailed.status, "host_preparation_failed");
  assert.equal(hostPreparationFailed.usable, false);
  assert.equal(hostPreparationFailed.hostPreparation.status, "capability_ace_missing");

  const aclFailure = nativeSandbox.sandboxPreparationDiagnostic({
    discovery: { available: true, reason: "Windows AppContainer helper found", expectedPath: "C:\\Bridge\\lpc-windows-sandbox.exe" },
    verification: {
      passed: false,
      reason: "sandbox probe failed to execute",
      probe: {
        code: 125,
        stderr: 'lpc-windows-sandbox: {"type":"sandbox_initialization_error","api":"SetNamedSecurityInfoW","target":"C:\\\\Program Files\\\\GitHub CLI\\\\gh.exe","win32":5,"securityInformation":"DACL"}',
      },
    },
    summary: { name: "windows-appcontainer", enforced: true, autoRunSafe: false },
  }, { enabled: true, platform: "win32", allowNetwork: false });
  assert.equal(aclFailure.status, "sandbox_initialization_error");
  assert.equal(aclFailure.errorCode, 5);
  assert.equal(aclFailure.processExitCode, 125);
  assert.equal(aclFailure.api, "SetNamedSecurityInfoW");
  assert.equal(aclFailure.target, "C:\\Program Files\\GitHub CLI\\gh.exe");
  assert.equal(aclFailure.securityInformation, "DACL");
  assert.match(aclFailure.reason, /SetNamedSecurityInfoW/);

  const ready = nativeSandbox.sandboxPreparationDiagnostic({
    discovery: { available: true, reason: "Windows AppContainer helper found", expectedPath: "C:\\Bridge\\lpc-windows-sandbox.exe" },
    verification: { passed: true },
    summary: { name: "windows-appcontainer", enforced: true, autoRunSafe: true },
  }, { enabled: true, platform: "win32", allowNetwork: true });
  assert.equal(ready.status, "ready");
  assert.equal(ready.usable, true);
});
