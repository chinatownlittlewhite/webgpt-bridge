import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isManagedNestedSandbox,
  isNestedMacOSManagedRunner,
  isNestedWindowsAppContainer,
} from "../scripts/sandbox-runtime-context.mjs";

test("managed nested sandbox detection requires trusted workspace-local paths", () => {
  assert.equal(isNestedWindowsAppContainer({
    platform: "win32",
    userProfile: "C:\\project\\.webgpt-bridge\\windows-profile",
    cwd: "C:\\project",
  }), true);
  assert.equal(isManagedNestedSandbox({
    platform: "win32",
    userProfile: "C:\\project\\.webgpt-bridge\\windows-profile",
    cwd: "C:\\project",
  }), true);
  assert.equal(isManagedNestedSandbox({
    platform: "win32",
    userProfile: "C:\\Users\\runner",
    cwd: "C:\\project",
  }), false);

  assert.equal(isNestedMacOSManagedRunner({
    platform: "darwin",
    home: "/project",
    tmpdir: "/project/.webgpt-bridge/tmp",
    cwd: "/project/agent-runtime",
  }), true);
  assert.equal(isManagedNestedSandbox({
    platform: "darwin",
    home: "/project",
    tmpdir: "/project/.webgpt-bridge/tmp",
    cwd: "/project/agent-runtime",
  }), true);
  assert.equal(isManagedNestedSandbox({
    platform: "darwin",
    home: "/Users/runner",
    tmpdir: "/private/tmp",
    cwd: "/project/agent-runtime",
  }), false);
  assert.equal(isManagedNestedSandbox({
    platform: "linux",
    home: "/project",
    tmpdir: "/project/.webgpt-bridge/tmp",
    cwd: "/project",
  }), false);
});

test("canonical registry sync switches to projection-only validation in a managed nested sandbox", () => {
  const source = fs.readFileSync(new URL("../scripts/sync-canonical-registry.mjs", import.meta.url), "utf8");
  assert.match(source, /import\s*\{\s*isManagedNestedSandbox\s*\}\s*from\s*"\.\/sandbox-runtime-context\.mjs"/);
  assert.match(source, /if\s*\(isManagedNestedSandbox\(\)\)\s*\{[\s\S]*validateProjectedRuntimeFiles\(\)/);
  assert.match(source, /else\s*\{[\s\S]*syncCanonicalRuntimeFiles\(\)/);
});
