import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  normalizedPlatform,
  platformSecurityNotes,
  resolvePlatformArgv,
} from "../src/platform.js";

test("current-platform node command resolves through trusted PATH without a shell", () => {
  const result = resolvePlatformArgv(["node", "--version"]);
  assert.equal(result.resolved, true);
  assert.equal(path.isAbsolute(result.argv[0]), true);
  assert.equal(result.logicalCommand, "node");
  assert.ok(Array.isArray(result.trustedReadPaths));
  assert.ok(result.trustedReadPaths.length >= 1);
});

test("model command names cannot select executable paths", () => {
  assert.throws(() => resolvePlatformArgv(["/tmp/node", "--version"]), /trusted PATH/);
  assert.throws(() => resolvePlatformArgv(["..\\node.exe", "--version"]), /trusted PATH/);
});

test("platform normalization and security notes freeze shellless Windows strategy", () => {
  assert.equal(normalizedPlatform("win32"), "windows");
  assert.equal(normalizedPlatform("darwin"), "macos");
  assert.equal(normalizedPlatform("linux"), "linux");
  assert.equal(platformSecurityNotes.windowsShellForModelCommands, false);
  assert.equal(platformSecurityNotes.windowsBatchFilesRequireTrustedShim, true);
  assert.equal(platformSecurityNotes.npmUsesNodeCliShimOnWindows, true);
  assert.equal(platformSecurityNotes.pnpmYarnUseTrustedRuntimeShimWhenNeeded, true);
  assert.equal(platformSecurityNotes.trustedRuntimeReadPathsAreHostDerived, true);
});

test("Windows acceptance resolves npm through a trusted non-shell runtime shim", (t) => {
  if (process.platform !== "win32") {
    t.skip("real Windows PATH resolution is validated on Windows final acceptance");
    return;
  }
  const result = resolvePlatformArgv(["npm", "--version"], { platform: "win32", env: process.env });
  assert.equal(result.resolved, true);
  assert.equal(result.usedTrustedShim, true);
  assert.match(path.win32.basename(result.argv[0]), /^node(?:\.exe)?$/i);
  assert.match(path.win32.basename(result.argv[1]), /^npm-cli\.js$/i);
  assert.ok(result.trustedReadPaths.length >= 1);
});
