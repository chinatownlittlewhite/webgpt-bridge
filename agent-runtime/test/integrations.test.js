import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { discoverDependencySync } from "../src/dependency.js";
import { buildGitHubArgv } from "../src/github.js";
import { createDependencySyncTool, createGitHubTool, createGitTool } from "../src/tool.js";

const require = createRequire(import.meta.url);
const { createBrokerBootstrap, createBrokerChallenge, verifyBrokerProof } = require("../../shared/local-broker-protocol.cjs");

function authenticatedBrokerServer(onRequest) {
  const bootstrap = createBrokerBootstrap();
  const auth = Object.freeze({ protocolVersion: bootstrap.protocolVersion, sessionId: bootstrap.sessionId, secret: bootstrap.secret, agentVersion: "0.9.3" });
  const server = net.createServer((socket) => {
    let buffered = "";
    let state = "hello";
    let hello = null;
    let nonce = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (state === "hello") {
          const challenge = createBrokerChallenge(message, bootstrap);
          if (challenge.type === "hello_error") {
            socket.end(`${JSON.stringify(challenge)}\n`);
            return;
          }
          hello = message;
          nonce = challenge.nonce;
          state = "authenticate";
          socket.write(`${JSON.stringify(challenge)}\n`);
          continue;
        }
        if (state === "authenticate") {
          const verified = message?.type === "authenticate" && message.protocolVersion === hello?.protocolVersion && message.sessionId === hello?.sessionId && message.agentVersion === hello?.agentVersion && message.nonce === nonce
            ? verifyBrokerProof(message, bootstrap, { expectedNonce: nonce })
            : { ok: false, code: "BROKER_AUTH_FAILED" };
          if (!verified.ok) {
            socket.end(`${JSON.stringify({ type: "hello_error", code: verified.code })}\n`);
            return;
          }
          state = "ready";
          hello = null;
          nonce = "";
          socket.write(`${JSON.stringify({ type: "hello_ok" })}\n`);
          continue;
        }
        onRequest(socket, message);
      }
    });
  });
  return { server, auth };
}

function testBrokerSocketPath(prefix) {
  if (process.platform === "darwin") return `/tmp/${prefix}-${process.pid}-${Date.now()}.sock`;
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}.sock`);
}

test("dependency sync chooses lock-aware structured commands with scripts disabled by default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-dependency-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  const npm = discoverDependencySync({ workspace: root });
  assert.equal(npm.ecosystem, "node-npm");
  assert.deepEqual(npm.argv, ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"]);

  fs.rmSync(path.join(root, "package-lock.json"));
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  const pnpm = discoverDependencySync({ workspace: root });
  assert.equal(pnpm.ecosystem, "node-pnpm");
  assert.ok(pnpm.argv.includes("--frozen-lockfile"));
  assert.ok(pnpm.argv.includes("--ignore-scripts"));

  const scripts = discoverDependencySync({ workspace: root, allowScripts: true });
  assert.equal(scripts.argv.includes("--ignore-scripts"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("networked tools fail closed before spawning when no dedicated network sandbox is available", async () => {
  const dependency = createDependencySyncTool({ workspace: process.cwd() });
  const github = createGitHubTool({ workspace: process.cwd() });

  const expectedDiagnostic = {
    status: "disabled",
    usable: false,
    enabled: false,
    platform: process.platform,
    allowNetwork: true,
    reason: "dedicated network sandbox is disabled",
    recoverable: true,
  };
  assert.deepEqual(await dependency.invoke({ cwd: "." }), {
    status: "network_unavailable",
    error: "dedicated network sandbox is unavailable: disabled",
    diagnostic: expectedDiagnostic,
  });
  assert.deepEqual(await github.invoke({ action: "ci_status", cwd: "." }), {
    status: "network_unavailable",
    error: "dedicated network sandbox is unavailable: disabled",
    diagnostic: expectedDiagnostic,
  });
});

test("GitHub tool reports actionable CLI missing and broken states before network execution", async () => {
  const missingState = {
    status: "missing",
    resolvedPath: null,
    version: null,
    reason: "GitHub CLI was not found",
    remediation: "Install GitHub CLI, then restart WebGPT Bridge.",
  };
  const missing = createGitHubTool({ workspace: process.cwd(), githubCliState: missingState });
  assert.deepEqual(await missing.invoke({ action: "ci_status", cwd: "." }), {
    status: "github_cli_missing",
    error: "GitHub CLI is unavailable: GitHub CLI was not found",
    githubCli: missingState,
  });

  const brokenState = {
    status: "broken",
    resolvedPath: "C:\\Program Files\\GitHub CLI\\gh.exe",
    version: null,
    reason: "GitHub CLI version probe failed: exit 1",
    remediation: "Repair GitHub CLI, then restart WebGPT Bridge.",
  };
  const broken = createGitHubTool({ workspace: process.cwd(), githubCliState: brokenState });
  assert.deepEqual(await broken.invoke({ action: "ci_status", cwd: "." }), {
    status: "github_cli_broken",
    error: "GitHub CLI is unavailable: GitHub CLI version probe failed: exit 1",
    githubCli: brokenState,
  });
});

test("GitHub integration builds bounded argv without a shell", () => {
  assert.deepEqual(
    buildGitHubArgv({ action: "ci_status", limit: 5 }),
    ["gh", "run", "list", "--limit", "5", "--json", "databaseId,status,conclusion,name,workflowName,url,headBranch,headSha"],
  );
  const create = buildGitHubArgv({
    action: "pr_create",
    title: "Test PR",
    body: "Body",
    base: "main",
    head: "feature",
  });
  assert.deepEqual(create, ["gh", "pr", "create", "--title", "Test PR", "--body", "Body", "--base", "main", "--head", "feature"]);
  assert.throws(() => buildGitHubArgv({ action: "pr_create", title: "x", body: "", base: "--repo" }), /does not start/);
  assert.throws(() => buildGitHubArgv({ action: "issue_view", number: 0 }), /between 1/);
  assert.deepEqual(
    buildGitHubArgv({ action: "release_view", tag: "v0.4.0" }),
    ["gh", "release", "view", "v0.4.0", "--json", "tagName,name,isDraft,isPrerelease,url,publishedAt"],
  );
  assert.deepEqual(
    buildGitHubArgv({ action: "release_create", tag: "v0.4.0", title: "WebGPT Bridge v0.4.0", body: "notes", draft: true, assets: ["release/app.dmg", "release/app.exe"] }),
    ["gh", "release", "create", "v0.4.0", "release/app.dmg", "release/app.exe", "--title", "WebGPT Bridge v0.4.0", "--notes", "notes", "--draft"],
  );
  assert.throws(() => buildGitHubArgv({ action: "release_create", tag: "--repo", title: "x", body: "" }), /does not start/);
  assert.throws(() => buildGitHubArgv({ action: "release_create", tag: "v1", title: "x", body: "", assets: ["../secret"] }), /relative/);
});

test("GitHub tool delegates authenticated CLI calls to the App-owned broker", async (t) => {
  if (process.platform === "win32") {
    t.skip("this regression probe uses a Unix-domain App broker socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-github-workspace-"));
  const socketPath = testBrokerSocketPath("lpc-github-broker");
  let request = null;
  const { server, auth } = authenticatedBrokerServer((socket, message) => {
    request = message;
    socket.end(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: { code: 0, stdout: "authenticated-account\n", stderr: "", truncated: false },
    })}\n`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
    if (error?.code === "EPERM") {
      t.skip("nested Seatbelt blocks IPC sockets; this App-broker probe runs in the desktop environment.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
  });

  const github = createGitHubTool({ workspace: root, localBrokerSocket: socketPath, localBrokerAuth: auth });
  const result = await github.invoke({ action: "ci_status" });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "authenticated-account\n");
  assert.equal(request.method, "local_run_command");
  assert.equal(request.params.cwd, fs.realpathSync(root));
  assert.deepEqual(request.params.argv, ["gh", "run", "list", "--limit", "20", "--json", "databaseId,status,conclusion,name,workflowName,url,headBranch,headSha"]);
});

test("Windows structured Git delegates every action to the App-owned broker", async (t) => {
  if (process.platform === "win32") {
    t.skip("this regression probe uses a Unix-domain App broker socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-win-git-broker-workspace-"));
  const socketPath = testBrokerSocketPath("lpc-win-git-broker");
  let request = null;
  const { server, auth } = authenticatedBrokerServer((socket, message) => {
    request = message;
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { code: 0, stdout: " M file.txt\\n", stderr: "", truncated: false } })}\n`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
    if (error?.code === "EPERM") {
      t.skip("nested Seatbelt blocks IPC sockets; this App-broker probe runs in the desktop environment.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
  });

  const git = createGitTool({ workspace: root, localBrokerSocket: socketPath, localBrokerAuth: auth, platform: "win32" });
  const result = await git.invoke({ action: "status" });
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(request.method, "local_run_command");
  assert.equal(request.params.cwd, fs.realpathSync(root));
  assert.deepEqual(request.params.argv, ["git", "status", "--short"]);
  assert.equal(result.policy.rule, "app-owned-windows-git-broker");
});

test("Git push is fixed to origin HEAD and delegates to the App-owned broker", async (t) => {
  if (process.platform === "win32") {
    t.skip("this regression probe uses a Unix-domain App broker socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-git-push-workspace-"));
  const socketPath = testBrokerSocketPath("lpc-git-push-broker");
  let request = null;
  const { server, auth } = authenticatedBrokerServer((socket, message) => {
    request = message;
    socket.end(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: { code: 0, stdout: "pushed\n", stderr: "", truncated: false },
    })}\n`);
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
    if (error?.code === "EPERM") {
      t.skip("nested Seatbelt blocks IPC sockets; this App-broker probe runs in the desktop environment.");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
  });

  const git = createGitTool({ workspace: root, localBrokerSocket: socketPath, localBrokerAuth: auth });
  const result = await git.invoke({ action: "push" });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "pushed\n");
  assert.equal(request.method, "local_run_command");
  assert.equal(request.params.cwd, fs.realpathSync(root));
  assert.deepEqual(request.params.argv, ["git", "push", "origin", "HEAD"]);
});
