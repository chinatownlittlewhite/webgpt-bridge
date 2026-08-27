import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as testEntrypoint from "../scripts/run-tests.mjs";

const { isNestedWindowsAppContainer, NESTED_WINDOWS_TEST_FILES } = testEntrypoint;

test("npm test delegates through the sandbox-aware test entrypoint", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const runnerSource = fs.readFileSync(path.join(root, "scripts", "run-tests.mjs"), "utf8");
  assert.equal(
    packageJson.scripts.test,
    "node --preserve-symlinks --preserve-symlinks-main scripts/run-tests.mjs",
  );
  assert.equal(fs.existsSync(path.join(root, "scripts", "run-tests.mjs")), true);
  assert.equal(
    packageJson.scripts.lint,
    "node --preserve-symlinks --preserve-symlinks-main scripts/lint.mjs",
  );
  assert.doesNotMatch(runnerSource, /\bawait main\(\)/);
  assert.match(runnerSource, /\bmain\(\)\.catch\(/);
});

test("nested Windows detection is bound to the trusted workspace-local profile", () => {
  assert.equal(isNestedWindowsAppContainer({
    platform: "win32",
    userProfile: "C:\\project\\.webgpt-bridge\\windows-profile",
    cwd: "C:\\project",
  }), true);
  assert.equal(isNestedWindowsAppContainer({
    platform: "win32",
    userProfile: "C:\\Users\\runner",
    cwd: "C:\\project",
  }), false);
  assert.equal(isNestedWindowsAppContainer({
    platform: "darwin",
    userProfile: "/project/.webgpt-bridge/windows-profile",
    cwd: "/project",
  }), false);
});

test("nested macOS managed-runner detection is bound to the trusted workspace environment", () => {
  assert.equal(
    typeof testEntrypoint.isNestedMacOSManagedRunner,
    "function",
    "test entrypoint must expose the trusted nested-macOS detector",
  );
  if (typeof testEntrypoint.isNestedMacOSManagedRunner !== "function") return;
  const detect = testEntrypoint.isNestedMacOSManagedRunner;
  assert.equal(detect({
    platform: "darwin",
    home: "/project",
    tmpdir: "/project/.webgpt-bridge/tmp",
    cwd: "/project",
  }), true);
  assert.equal(detect({
    platform: "darwin",
    home: "/Users/runner",
    tmpdir: "/private/tmp",
    cwd: "/project",
  }), false);
  assert.equal(detect({
    platform: "darwin",
    home: "/project",
    tmpdir: "/private/tmp",
    cwd: "/project",
  }), false);
  assert.equal(detect({
    platform: "linux",
    home: "/project",
    tmpdir: "/project/.webgpt-bridge/tmp",
    cwd: "/project",
  }), false);
});

test("nested Windows suite stays explicit and excludes host-fixture integration tests", () => {
  assert.deepEqual(NESTED_WINDOWS_TEST_FILES, [
    "acceptance-script.test.js",
    "approval.test.js",
    "goal-controller.test.js",
    "goal-mode.test.js",
    "goal-session.test.js",
    "platform.test.js",
    "policy.test.js",
    "sandbox.test.js",
    "schema-validate.test.js",
    "test-entrypoint.test.js",
    "windows-appcontainer-temp.test.js",
  ]);
  assert.equal(NESTED_WINDOWS_TEST_FILES.includes("workspace.test.js"), false);
  assert.equal(NESTED_WINDOWS_TEST_FILES.includes("local-broker-client.test.js"), false);
});
