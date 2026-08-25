import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNestedWindowsAppContainer, NESTED_WINDOWS_TEST_FILES } from "../scripts/run-tests.mjs";

test("npm test delegates through the sandbox-aware test entrypoint", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts.test,
    "node --preserve-symlinks --preserve-symlinks-main scripts/run-tests.mjs",
  );
  assert.equal(fs.existsSync(path.join(root, "scripts", "run-tests.mjs")), true);
});

test("nested Windows detection is bound to the trusted workspace-local profile", () => {
  assert.equal(isNestedWindowsAppContainer({
    platform: "win32",
    localAppData: "C:\\project\\.webgpt-bridge\\windows-profile\\AppData\\Local",
    cwd: "C:\\project",
  }), true);
  assert.equal(isNestedWindowsAppContainer({
    platform: "win32",
    localAppData: "C:\\Users\\runner\\AppData\\Local",
    cwd: "C:\\project",
  }), false);
  assert.equal(isNestedWindowsAppContainer({
    platform: "darwin",
    localAppData: "/project/.webgpt-bridge/windows-profile/AppData/Local",
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
