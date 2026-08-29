import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isNestedMacOSManagedRunner,
  isNestedWindowsAppContainer,
} from "./sandbox-runtime-context.mjs";

export { isNestedMacOSManagedRunner, isNestedWindowsAppContainer };

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");

export const NESTED_WINDOWS_TEST_FILES = Object.freeze([
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

export const NESTED_MACOS_TEST_FILES = Object.freeze([
  "acceptance-script.test.js",
  "approval.test.js",
  "goal-controller.test.js",
  "goal-mode.test.js",
  "goal-session.test.js",
  "platform.test.js",
  "policy.test.js",
  "schema-validate.test.js",
  "test-entrypoint.test.js",
]);

async function runStandardSuite() {
  const child = spawn(process.execPath, ["--test"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (signal || code !== 0) process.exitCode = Number.isInteger(code) ? code : 1;
}

async function runNestedSuite(label, files) {
  console.log(`[test] ${label}: running ${files.length} sandbox-compatible regression files`);
  for (const file of files) {
    await import(pathToFileURL(path.join(root, "test", file)).href);
  }
}

async function runNestedWindowsSuite() {
  await runNestedSuite("nested Windows AppContainer", NESTED_WINDOWS_TEST_FILES);
}

async function runNestedMacOSSuite() {
  await runNestedSuite("nested macOS managed runner", NESTED_MACOS_TEST_FILES);
}

export async function main() {
  if (isNestedWindowsAppContainer()) await runNestedWindowsSuite();
  else if (isNestedMacOSManagedRunner()) await runNestedMacOSSuite();
  else await runStandardSuite();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
