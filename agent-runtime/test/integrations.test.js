import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { discoverDependencySync } from "../src/dependency.js";
import { buildGitHubArgv } from "../src/github.js";
import { createDependencySyncTool, createGitHubTool, createGitTool } from "../src/tool.js";

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

  assert.deepEqual(await dependency.invoke({ cwd: "." }), {
    status: "network_unavailable",
    error: "dedicated network sandbox is unavailable",
  });
  assert.deepEqual(await github.invoke({ action: "ci_status", cwd: "." }), {
    status: "network_unavailable",
    error: "dedicated network sandbox is unavailable",
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
});

test("GitHub tool delegates authenticated CLI calls to the App-owned broker", async (t) => {
  if (process.platform === "win32") {
    t.skip("this regression probe uses a Unix-domain App broker socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-github-workspace-"));
  const socketPath = testBrokerSocketPath("lpc-github-broker");
  let request = null;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (line) => {
      request = JSON.parse(line);
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: { code: 0, stdout: "authenticated-account\n", stderr: "", truncated: false },
      })}\n`);
    });
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

  const github = createGitHubTool({ workspace: root, localBrokerSocket: socketPath });
  const result = await github.invoke({ action: "ci_status" });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "authenticated-account\n");
  assert.equal(request.method, "local_run_command");
  assert.equal(request.params.cwd, fs.realpathSync(root));
  assert.deepEqual(request.params.argv, ["gh", "run", "list", "--limit", "20", "--json", "databaseId,status,conclusion,name,workflowName,url,headBranch,headSha"]);
});

test("Git push is fixed to origin HEAD and delegates to the App-owned broker", async (t) => {
  if (process.platform === "win32") {
    t.skip("this regression probe uses a Unix-domain App broker socket");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-git-push-workspace-"));
  const socketPath = testBrokerSocketPath("lpc-git-push-broker");
  let request = null;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.once("data", (line) => {
      request = JSON.parse(line);
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: true,
        result: { code: 0, stdout: "pushed\n", stderr: "", truncated: false },
      })}\n`);
    });
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

  const git = createGitTool({ workspace: root, localBrokerSocket: socketPath });
  const result = await git.invoke({ action: "push" });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "pushed\n");
  assert.equal(request.method, "local_run_command");
  assert.equal(request.params.cwd, fs.realpathSync(root));
  assert.deepEqual(request.params.argv, ["git", "push", "origin", "HEAD"]);
});
