import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const INTERNAL_STATE_DIR = ".webgpt-bridge";

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

export function isNestedWindowsAppContainer({
  platform = process.platform,
  userProfile = process.env.USERPROFILE,
  cwd = process.cwd(),
} = {}) {
  if (platform !== "win32" || typeof userProfile !== "string" || userProfile.length === 0) return false;
  const expected = path.win32.join(
    path.win32.resolve(cwd),
    INTERNAL_STATE_DIR,
    "windows-profile",
  );
  return path.win32.resolve(userProfile).toLowerCase() === expected.toLowerCase();
}

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

async function runNestedWindowsSuite() {
  console.log(`[test] nested Windows AppContainer: running ${NESTED_WINDOWS_TEST_FILES.length} sandbox-compatible regression files`);
  for (const file of NESTED_WINDOWS_TEST_FILES) {
    await import(pathToFileURL(path.join(root, "test", file)).href);
  }
}

export async function main() {
  if (isNestedWindowsAppContainer()) await runNestedWindowsSuite();
  else await runStandardSuite();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
