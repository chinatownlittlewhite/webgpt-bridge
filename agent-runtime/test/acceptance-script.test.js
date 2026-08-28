import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "scripts", "acceptance.mjs"), "utf8");

test("acceptance isolates nested unit-test audit writes from the main audit chain", () => {
  assert.match(source, /function runHost\(argv, \{ cwd = root, env = \{\} \} = \{\}\)/);
  assert.match(source, /env: \{ \.\.\.process\.env, \.\.\.env \}/);
  assert.match(source, /runHost\(\["npm", "test"\], \{ env: \{ LPC_DISABLE_AUDIT: "true" \} \}\);/);
});

test("acceptance reports native sandbox verification details on failure", () => {
  assert.match(source, /native sandbox probe must pass:/);
  assert.match(source, /JSON\.stringify\(server\.runtime\.normalSandbox\.verification\)/);
});

test("Windows native developer smoke uses the production command timeout budget", () => {
  assert.match(source, /timeoutMs: process\.platform === "win32" \? 120_000 : 30_000/);
});

test("Windows acceptance mirrors the desktop Git broker architecture", () => {
  assert.match(source, /\\\\\\\\\.\\\\pipe\\\\webgpt-bridge-acceptance-/);
  assert.match(source, /createAcceptanceGitBroker/);
  assert.match(source, /createGitTool/);
  assert.match(source, /localBrokerSocket: gitBrokerSocket/);
  assert.match(source, /process\.platform === "win32" \? \[\["node", "--version"\], \["npm", "--version"\]\]/);
  assert.match(source, /await git\.invoke\(\{ action: "status", cwd: path\.relative\(root, repo\) \}\)/);
});

test("Windows acceptance verifies the combined native host payload before sandbox checks", () => {
  assert.match(source, /lpc-windows-host\.exe/);
  assert.match(source, /combined Windows native publish must include/);
  assert.match(source, /legacyRuntimeFiles/);
});

test("Windows prebuilt acceptance skips compilation without skipping native verification", () => {
  assert.match(source, /const prebuiltNative = process\.argv\.includes\("--prebuilt-native"\)/);
  assert.match(source, /process\.platform === "win32" && !skipNative && !prebuiltNative/);
  assert.match(source, /process\.platform === "win32" && !skipNative[\s\S]*combined Windows native publish must include/);
  assert.doesNotMatch(source, /prebuiltNative[\s\S]{0,120}verifySandbox:\s*false/);
});

test("Windows acceptance exercises shared executables through AppContainer without ACL rewriting", () => {
  assert.match(source, /verifyWindowsExternalExecutableCompatibility/);
  assert.match(source, /cmd\.exe/);
  assert.match(source, /\["git", "--version"\]/);
  assert.match(source, /\["dotnet", "--list-runtimes"\]/);
  assert.match(source, /\["node", "--version"\]/);
  assert.match(source, /\["gh", "--version"\]/);
  assert.match(source, /wrapWithSandbox\(runtime\.normalSandbox\.adapter/);
  assert.match(source, /dev\\\/null.*Permission denied/i);
  assert.match(source, /windowsHostPreparationState\.status/);
  assert.match(source, /Windows host preparation must be ready/);
});

test("Windows acceptance verifies the dedicated network sandbox and structured dependency path", () => {
  assert.match(source, /enableNetworkTools:\s*process\.platform === "win32"/);
  assert.match(source, /networkSandboxState\.status,\s*"ready"/);
  assert.match(source, /networkSandbox\?\.verification\?\.passed/);
  assert.match(source, /dependency_sync/);
  assert.match(source, /network_unavailable/);
  assert.match(source, /dependencyProbe\.sandbox\?\.capabilities\?\.networkIsolation/);
  assert.doesNotMatch(source, /dependencyProbe\.sandbox\?\.networkIsolation/);
  assert.match(source, /internet-client-capability/);
});

test("Windows acceptance checks capability reporting for native and GitHub readiness without requiring authentication", () => {
  assert.match(source, /caps\.releaseAcceptance\.currentNativeSandboxVerified/);
  assert.match(source, /caps\.networkSandbox\.status/);
  assert.match(source, /caps\.githubCli\.status/);
  assert.match(source, /unauthenticated/);
});

test("Goal finish acceptance gives bounded long-running verification enough client budget", () => {
  const goalFinish = source.indexOf('name: "goal_finish"');
  assert.ok(goalFinish >= 0);
  const callTail = source.slice(goalFinish, goalFinish + 1_500);
  assert.match(callTail, /timeout: 5 \* 60_000/);
  assert.match(callTail, /maxTotalTimeout: 5 \* 60_000/);
});

test("Goal finish acceptance includes structured verification details in assertion failures", () => {
  assert.match(source, /JSON\.stringify\(finished\.structuredContent, null, 2\)/);
});
