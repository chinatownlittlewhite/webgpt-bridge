import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const buildNativeSource = fs.readFileSync(new URL("../scripts/build-native.mjs", import.meta.url), "utf8");
const doctorSource = fs.readFileSync(new URL("../scripts/doctor.mjs", import.meta.url), "utf8");

test("Windows native sandbox publish is win-x64 self-contained without trimming or single-file modes", () => {
  assert.match(buildNativeSource, /"-r",\s*"win-x64"/);
  assert.match(buildNativeSource, /"--self-contained",\s*"true"/);
  assert.doesNotMatch(buildNativeSource, /"--self-contained",\s*"false"/);
  assert.doesNotMatch(buildNativeSource, /PublishSingleFile|PublishTrimmed|PublishAot|NativeAOT/i);
});

test("Windows doctor treats dotnet as a build-host concern rather than a target runtime prerequisite", () => {
  assert.doesNotMatch(doctorSource, /check\("\.NET 8 SDK\/runtime"[^\n]*true\)/);
  assert.match(doctorSource, /Windows AppContainer sandbox helper/);
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
