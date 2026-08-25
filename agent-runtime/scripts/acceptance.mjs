import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { resolvePlatformArgv } from "../src/platform.js";

const VERSION = "0.9.0";
const EXPECTED_TOOLS = [
  "run_command", "run_project_task", "git", "dependency_sync", "github",
  "process_start", "process_poll", "process_input", "process_kill", "process_list",
  "read_file", "list_dir", "search_text", "search_files",
  "apply_patch", "delete_file", "move_file",
  "goal_mode", "goal_step", "goal_finish", "goal_status", "goal_cancel",
  "get_capabilities",
].sort();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipNative = process.argv.includes("--skip-native");

function stage(name) {
  console.error(`\n[acceptance] ${name}`);
}

function runHost(argv, { cwd = root, env = {} } = {}) {
  const resolved = resolvePlatformArgv(argv, { env: process.env, platform: process.platform });
  if (!resolved.resolved) throw new Error(`host command not found: ${argv[0]}`);
  const result = spawnSync(resolved.argv[0], resolved.argv.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
    windowsHide: true,
    timeout: 5 * 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${argv.join(" ")} failed with exit ${result.status}`);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function verifyBuildParity() {
  const srcDir = path.join(root, "src");
  const distDir = path.join(root, "dist");
  const sourceNames = fs.readdirSync(srcDir).filter((name) => name.endsWith(".js")).sort();
  const distNames = fs.readdirSync(distDir).filter((name) => name.endsWith(".js")).sort();
  assert.deepEqual(distNames, sourceNames, "dist must contain exactly the current src JavaScript module set");
  for (const name of sourceNames) {
    const source = fs.readFileSync(path.join(srcDir, name));
    const built = fs.readFileSync(path.join(distDir, name));
    assert.equal(sha256(built), sha256(source), `dist/${name} must be byte-identical to src/${name}`);
  }
}

function verifyAuditTail(file) {
  assert.equal(fs.existsSync(file), true, "audit log must exist");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).slice(-200);
  assert.ok(lines.length > 0, "audit log must contain events");
  let previous = null;
  for (const line of lines) {
    const entry = JSON.parse(line);
    const base = {
      timestamp: entry.timestamp,
      sequence: entry.sequence,
      previousHash: entry.previousHash,
      event: entry.event,
    };
    assert.equal(entry.hash, sha256(JSON.stringify(base)), "audit entry hash must verify");
    if (previous) {
      assert.equal(entry.sequence, previous.sequence + 1, "audit sequence must be contiguous");
      assert.equal(entry.previousHash, previous.hash, "audit chain must be contiguous");
    }
    previous = entry;
  }
}

async function connect(url) {
  const client = new Client(
    { name: "local-project-coding-acceptance", version: VERSION },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
  return { client, transport };
}

async function closeClient(client, transport) {
  try { await transport.terminateSession(); } catch {}
  await client.close();
}

function isInsideAcceptanceRoot(candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function createAcceptanceGitBroker() {
  if (process.platform !== "win32") return null;
  const socketPath = `\\\\.\\pipe\\webgpt-bridge-acceptance-${process.pid}-${crypto.randomUUID()}`;
  const server = net.createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let request = null;
        try {
          request = JSON.parse(line);
          const argv = request?.params?.argv;
          const cwd = request?.params?.cwd;
          if (request?.method !== "local_run_command") throw new Error("acceptance broker only supports local_run_command");
          if (!Array.isArray(argv) || argv[0] !== "git") throw new Error("acceptance broker only permits structured Git argv");
          if (typeof cwd !== "string" || !path.isAbsolute(cwd) || !isInsideAcceptanceRoot(cwd)) {
            throw new Error("acceptance broker cwd escapes workspace");
          }
          const resolved = resolvePlatformArgv(argv, { env: process.env, platform: process.platform });
          if (!resolved.resolved) throw new Error("acceptance broker could not resolve Git");
          const result = spawnSync(resolved.argv[0], resolved.argv.slice(1), {
            cwd,
            env: process.env,
            encoding: "utf8",
            shell: false,
            windowsHide: true,
            timeout: 120_000,
          });
          if (result.error) throw result.error;
          socket.end(`${JSON.stringify({
            id: request.id,
            ok: true,
            result: {
              code: result.status ?? -1,
              signal: result.signal ?? undefined,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
              truncated: false,
            },
          })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ id: request?.id ?? null, ok: false, error: error.message })}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function verifyWindowsExternalExecutableCompatibility(runtime) {
  if (process.platform !== "win32") return;
  const { wrapWithSandbox } = await import("../dist/sandbox.js");
  const { createSandboxProbeEnvironment } = await import("../dist/sandbox-verify.js");
  const smokeWorkspace = fs.mkdtempSync(path.join(root, "acceptance-windows-sandbox-"));
  const commands = [
    ["cmd.exe", "/d", "/c", "echo", "webgpt-bridge-appcontainer-smoke"],
    ["git", "--version"],
    ["dotnet", "--list-runtimes"],
    ["node", "--version"],
    ["gh", "--version"],
  ];
  try {
    const env = createSandboxProbeEnvironment(smokeWorkspace, { platform: "win32", sourceEnv: process.env });
    for (const argv of commands) {
      let resolvedArgv;
      let trustedReadPaths;
      if (argv[0] === "gh" && runtime.githubCliState?.status === "ready") {
        resolvedArgv = [runtime.githubCliState.resolvedPath, ...argv.slice(1)];
        trustedReadPaths = [path.dirname(runtime.githubCliState.resolvedPath)];
      } else {
        const resolved = resolvePlatformArgv(argv, { env: process.env, platform: "win32" });
        assert.equal(resolved.resolved, true, `${argv[0]} must be installed for Windows native release acceptance`);
        resolvedArgv = resolved.argv;
        trustedReadPaths = resolved.trustedReadPaths;
      }
      const wrapped = wrapWithSandbox(runtime.normalSandbox.adapter, {
        argv: resolvedArgv,
        cwd: smokeWorkspace,
        workspace: smokeWorkspace,
        extraReadPaths: trustedReadPaths,
      });
      const result = spawnSync(wrapped[0], wrapped.slice(1), {
        cwd: smokeWorkspace,
        env,
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        timeout: 120_000,
      });
      if (result.error) throw result.error;
      assert.equal(
        result.status,
        0,
        `${argv[0]} must launch through the verified AppContainer without rewriting its persistent ACL: ${JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr, resolvedArgv })}`,
      );
    }
  } finally {
    fs.rmSync(smokeWorkspace, { recursive: true, force: true });
  }
}

async function verifyNativeDeveloperWorkflow(runtime) {
  const { createCommandRunner } = await import("../dist/runner.js");
  const run = createCommandRunner({
    workspace: root,
    sandboxAdapter: runtime.normalSandbox.adapter,
    platform: process.platform,
    auditLogger: runtime.auditLogger,
    timeoutMs: process.platform === "win32" ? 120_000 : 30_000,
  });
  const sandboxCommands = process.platform === "win32" ? [["node", "--version"], ["npm", "--version"]] : [["node", "--version"], ["npm", "--version"], ["git", "--version"]];
  for (const argv of sandboxCommands) {
    const result = await run({ argv, cwd: ".", requestApproval: () => true });
    assert.equal(result.status, "completed", `${argv[0]} must execute in the verified native sandbox: ${result.error ?? result.stderr ?? ""}`);
    assert.equal(result.exitCode, 0, `${argv[0]} native sandbox smoke must exit 0: ${JSON.stringify({ status: result.status, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, resolvedArgv: result.resolvedArgv ?? null })}`);
  }

  const gitBroker = await createAcceptanceGitBroker();
  const gitBrokerSocket = gitBroker?.socketPath ?? "";
  try {
    const started = await runtime.processManager.start(
    { argv: ["node", "-e", "setInterval(() => {}, 1000)"], cwd: "." },
    { requestApproval: () => true },
  );
    assert.equal(started.status, "running", "managed process must start inside the verified native sandbox");
    const killed = await runtime.processManager.kill({ processId: started.processId, force: true });
    assert.equal(killed.status, "kill_requested", "managed process tree must accept native termination");

    const repo = fs.mkdtempSync(path.join(root, "acceptance-repo-"));
    let worktreePath = null;
    try {
    runHost(["git", "init"], { cwd: repo });
    runHost(["git", "config", "user.email", "acceptance@example.invalid"], { cwd: repo });
    runHost(["git", "config", "user.name", "Local Project Coding Acceptance"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.txt"), "acceptance\n", "utf8");
    runHost(["git", "add", "README.txt"], { cwd: repo });
      runHost(["git", "commit", "-m", "acceptance seed"], { cwd: repo });

      if (process.platform === "win32") {
        const { createGitTool } = await import("../dist/tool.js");
        const git = createGitTool({
          workspace: root,
          sandboxAdapter: runtime.normalSandbox.adapter,
          localBrokerSocket: gitBrokerSocket,
          platform: process.platform,
          auditLogger: runtime.auditLogger,
        });
        const gitStatus = await git.invoke({ action: "status", cwd: path.relative(root, repo) });
        assert.equal(gitStatus.status, "completed", `structured Git broker smoke failed: ${gitStatus.error ?? gitStatus.stderr ?? ""}`);
        assert.equal(gitStatus.exitCode, 0);
      }

      const { createManagedWorktreeRunner } = await import("../dist/worktree.js");
    const manageWorktree = createManagedWorktreeRunner({
      workspace: root,
      sandboxAdapter: runtime.normalSandbox.adapter,
      localBrokerSocket: gitBrokerSocket,
      platform: process.platform,
      auditLogger: runtime.auditLogger,
      timeoutMs: 30_000,
    });
    const created = await manageWorktree(
      {
        action: "create",
        cwd: path.relative(root, repo),
        name: "native-smoke",
        branch: `lpc-acceptance-${Date.now()}`,
        revision: "HEAD",
      },
      { requestApproval: () => true },
    );
    assert.equal(created.status, "completed", `managed worktree create failed: ${created.error ?? created.stderr ?? ""}`);
    assert.equal(created.exitCode, 0);
    worktreePath = path.join(root, created.worktreePath);
    assert.equal(fs.existsSync(worktreePath), true, "managed worktree path must exist");

    const removed = await manageWorktree(
      { action: "remove", cwd: path.relative(root, repo), name: "native-smoke", force: true },
      { requestApproval: () => true },
    );
    assert.equal(removed.status, "completed", `managed worktree remove failed: ${removed.error ?? removed.stderr ?? ""}`);
    assert.equal(removed.exitCode, 0);
      worktreePath = null;
    } finally {
      if (worktreePath) fs.rmSync(worktreePath, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  } finally {
    await gitBroker?.close();
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
assert.equal(packageJson.version, VERSION);

if (process.platform === "win32" && !skipNative) {
  stage("build Windows native sandbox helper");
  runHost(["npm", "run", "build:native"]);
  const nativeOutput = path.join(root, "native", "windows-sandbox", "bin", "release");
  for (const requiredFile of ["lpc-windows-sandbox.exe", "hostfxr.dll", "hostpolicy.dll"]) {
    assert.equal(
      fs.existsSync(path.join(nativeOutput, requiredFile)),
      true,
      `self-contained Windows sandbox publish must include ${requiredFile}`,
    );
  }
}

stage("unit/integration tests");
runHost(["npm", "test"], { env: { LPC_DISABLE_AUDIT: "true" } });

stage("lint");
runHost(["npm", "run", "lint"]);

stage("public tool/schema contract");
runHost(["npm", "run", "contract"]);

stage("build dist");
runHost(["npm", "run", "build"]);
verifyBuildParity();

stage("doctor");
runHost(["npm", "run", "doctor"]);

const { startProductionServer } = await import("../dist/server.js");
let server = null;
let clientBundle = null;
let sessionId = null;
const acceptanceInstructions = path.join(root, "AGENTS.md");
const createdAcceptanceInstructions = !fs.existsSync(acceptanceInstructions);
if (createdAcceptanceInstructions) {
  fs.writeFileSync(acceptanceInstructions, "# Acceptance fixture\n\nThis file verifies project instruction discovery.\n", "utf8");
}
try {
  stage("start built MCP server and negotiate 2026-07-28");
  server = await startProductionServer({
    workspace: root,
    host: "127.0.0.1",
    port: 0,
    verifySandbox: !skipNative,
    enableNetworkTools: process.platform === "win32",
    installSignalHandlers: false,
  });
  if (!skipNative) {
    assert.equal(server.runtime.normalSandbox.discovery.available, true, "native sandbox backend must be available");
    assert.equal(
      server.runtime.normalSandbox.verification?.passed,
      true,
      `native sandbox probe must pass: ${JSON.stringify(server.runtime.normalSandbox.verification)}`,
    );
    assert.equal(server.runtime.normalSandbox.summary.autoRunSafe, true, "verified sandbox must be promoted");
    if (process.platform === "win32") {
      assert.equal(
        server.runtime.networkSandboxState.status,
        "ready",
        `dedicated network sandbox must be ready: ${JSON.stringify(server.runtime.networkSandboxState)}`,
      );
      assert.equal(server.runtime.networkSandbox?.discovery.available, true, "dedicated network sandbox backend must be available");
      assert.equal(
        server.runtime.networkSandbox?.verification?.passed,
        true,
        `dedicated network sandbox probe must pass: ${JSON.stringify(server.runtime.networkSandbox?.verification)}`,
      );
      assert.equal(server.runtime.networkSandbox?.summary.autoRunSafe, true, "dedicated network sandbox must be promoted after verification");
      const dependencyTool = server.runtime.tools.find((tool) => tool.name === "dependency_sync");
      assert.ok(dependencyTool, "dependency_sync tool must exist");
      const dependencyProbe = await dependencyTool.invoke({ cwd: ".", allowScripts: false });
      assert.notEqual(
        dependencyProbe.status,
        "network_unavailable",
        `dependency_sync must enter the dedicated network policy path: ${JSON.stringify(dependencyProbe)}`,
      );
      assert.equal(dependencyProbe.status, "approval_required", "dependency_sync smoke must stop at approval without mutating dependencies");
      assert.equal(
        dependencyProbe.sandbox?.capabilities?.networkIsolation,
        "internet-client-capability",
        `dependency_sync must be bound to the dedicated network sandbox: ${JSON.stringify(dependencyProbe.sandbox)}`,
      );
    }
    if (process.platform === "win32") {
      stage("Windows shared executable AppContainer compatibility");
      await verifyWindowsExternalExecutableCompatibility(server.runtime);
    }
    stage("native Node/npm/Git/process/worktree compatibility");
    await verifyNativeDeveloperWorkflow(server.runtime);
  }

  const endpoint = `http://127.0.0.1:${server.port}/mcp`;
  clientBundle = await connect(endpoint);

  stage("scan exact tool surface");
  const listed = await clientBundle.client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);

  stage("bounded inspection primitives and concise MCP content");
  const readResult = await clientBundle.client.callTool({
    name: "read_file",
    arguments: { path: "README.md", startLine: 1, maxLines: 12, maxBytes: 8_000 },
  });
  assert.equal(readResult.structuredContent.path, "README.md");
  assert.equal(typeof readResult.structuredContent.sha256, "string");
  assert.match(readResult.content[0].text, /^read_file:/);
  assert.doesNotMatch(readResult.content[0].text, /^\s*\{/);
  const searchResult = await clientBundle.client.callTool({
    name: "search_text",
    arguments: { query: "Final Acceptance Candidate", path: ".", glob: "README.md", maxResults: 10 },
  });
  assert.ok(searchResult.structuredContent.matchCount >= 1);
  const listResult = await clientBundle.client.callTool({
    name: "list_dir",
    arguments: { path: "src", recursive: false, maxEntries: 200 },
  });
  assert.ok(listResult.structuredContent.entries.some((entry) => entry.path === "src/server.js"));

  stage("capability contract");
  const capsResult = await clientBundle.client.callTool({ name: "get_capabilities", arguments: {} });
  const caps = capsResult.structuredContent;
  assert.equal(caps.version, VERSION);
  assert.equal(caps.releaseStage, "final-acceptance-candidate");
  assert.deepEqual([...caps.tools].sort(), EXPECTED_TOOLS);
  assert.equal(caps.mcp.protocolRevision, "2026-07-28");
  assert.equal(caps.guarantees.modelCannotSelfApprove, true);
  if (!skipNative) {
    assert.equal(caps.sandbox.autoRunSafe, true);
    assert.equal(caps.releaseAcceptance.currentNativeSandboxVerified, true);
  }
  if (process.platform === "win32" && !skipNative) {
    assert.equal(caps.networkSandbox.status, "ready");
    assert.equal(caps.networkSandbox.usableForStructuredNetworkTools, true);
    assert.ok(["ready", "missing", "broken"].includes(caps.githubCli.status), `GitHub CLI capability must be actionable: ${JSON.stringify(caps.githubCli)}`);
    if (caps.githubCli.status === "ready") {
      assert.equal(typeof caps.githubCli.resolvedPath, "string");
      assert.ok(caps.githubCli.resolvedPath.length > 0);
      assert.equal(typeof caps.githubCli.version, "string");
      assert.ok(caps.githubCli.version.length > 0);
    }
  }

  stage("HTTP health endpoint");
  const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
  assert.equal(health.status, 200);
  const healthJson = await health.json();
  assert.equal(healthJson.version, VERSION);
  assert.equal(healthJson.toolCount, EXPECTED_TOOLS.length);

  stage("OAuth discovery is absent when no OAuth server is configured");
  for (const route of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ]) {
    const response = await fetch(`http://127.0.0.1:${server.port}${route}`);
    assert.equal(response.status, 404, `${route} must not advertise incomplete OAuth metadata`);
    assert.equal(await response.text(), "", `${route} must not return a JSON error as metadata`);
  }

  stage("Goal session persistence across server restart");
  const started = await clientBundle.client.callTool({
    name: "goal_mode",
    arguments: {
      goal: "Final acceptance persistence and verification smoke test",
      cwd: ".",
      acceptanceCriteria: ["The persisted Goal session is restored after MCP server restart"],
      maxSteps: 20,
      maxToolCalls: 40,
    },
  });
  sessionId = started.structuredContent.sessionId;
  assert.equal(started.structuredContent.status, "active");
  assert.equal(started.structuredContent.mustContinue, true);
  assert.ok(started.structuredContent.projectContext.files.some((entry) => entry.path === "AGENTS.md"));
  assert.match(started.content[0].text, /Project instructions:/);
  assert.match(sessionId, /^[A-Za-z0-9_-]{1,128}$/);

  await closeClient(clientBundle.client, clientBundle.transport);
  clientBundle = null;
  await server.close();
  server = null;

  server = await startProductionServer({
    workspace: root,
    host: "127.0.0.1",
    port: 0,
    verifySandbox: !skipNative,
    enableNetworkTools: process.platform === "win32",
    installSignalHandlers: false,
  });
  clientBundle = await connect(`http://127.0.0.1:${server.port}/mcp`);
  const restored = await clientBundle.client.callTool({
    name: "goal_status",
    arguments: { sessionId },
  });
  assert.equal(restored.structuredContent.status, "active");
  assert.equal(restored.structuredContent.sessionId, sessionId);

  if (skipNative) {
    await clientBundle.client.callTool({ name: "goal_cancel", arguments: { sessionId } });
  } else {
    stage("Goal finish real verification gate");
    const finished = await clientBundle.client.callTool(
      {
        name: "goal_finish",
        arguments: {
          sessionId,
          summary: "The final acceptance Goal session survived restart and project checks completed.",
          evidence: ["MCP server restarted and goal_status restored the same session id"],
          criteriaEvidence: [{
            criterion: "The persisted Goal session is restored after MCP server restart",
            satisfied: true,
            evidence: "goal_status returned active for the same sessionId after a full server restart",
          }],
        },
      },
      { timeout: 5 * 60_000, maxTotalTimeout: 5 * 60_000 },
    );
    assert.equal(
      finished.structuredContent.status,
      "completed",
      `goal_finish must complete: ${JSON.stringify(finished.structuredContent, null, 2)}`,
    );
    assert.equal(
      finished.structuredContent.verified,
      true,
      `goal_finish must report verified=true: ${JSON.stringify(finished.structuredContent, null, 2)}`,
    );
  }

  stage("audit hash-chain tail");
  verifyAuditTail(path.join(root, ".webgpt-bridge", "audit.jsonl"));
} finally {
  if (clientBundle) await closeClient(clientBundle.client, clientBundle.transport).catch(() => {});
  if (server) await server.close().catch(() => {});
  if (sessionId) {
    fs.rmSync(path.join(root, ".webgpt-bridge", "goals", `${sessionId}.json`), { force: true });
  }
  if (createdAcceptanceInstructions) fs.rmSync(acceptanceInstructions, { force: true });
}

console.log(JSON.stringify({
  ok: true,
  version: VERSION,
  platform: process.platform,
  nativeVerified: !skipNative,
  toolCount: EXPECTED_TOOLS.length,
  protocol: "2026-07-28",
}, null, 2));
