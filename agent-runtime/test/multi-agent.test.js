import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { createMultiAgentCoordinator } from "../src/multi-agent.js";
import { createCoreTools } from "../src/tool.js";
import { createManagedWorktreeRunner } from "../src/worktree.js";

const require = createRequire(import.meta.url);
const { createBrokerBootstrap, createBrokerChallenge, verifyBrokerProof } = require("../../shared/local-broker-protocol.cjs");
const TEST_BROKER_AUTH = Object.freeze({ protocolVersion: 1, sessionId: "test-session", secret: "test-secret", agentVersion: "0.9.3" });

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
}

async function startWindowsGitBroker(root) {
  if (process.platform !== "win32") return null;
  const socketPath = `\\\\.\\pipe\\lpc-multi-agent-${process.pid}-${Date.now()}`;
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
        let request = null;
        try {
          request = JSON.parse(line);
          if (state === "hello") {
            const challenge = createBrokerChallenge(request, bootstrap);
            if (challenge.type === "hello_error") throw new Error(challenge.code);
            hello = request;
            nonce = challenge.nonce;
            state = "authenticate";
            socket.write(`${JSON.stringify(challenge)}\n`);
            continue;
          }
          if (state === "authenticate") {
            if (request?.type !== "authenticate" || request.protocolVersion !== hello?.protocolVersion || request.sessionId !== hello?.sessionId || request.agentVersion !== hello?.agentVersion || request.nonce !== nonce) throw new Error("BROKER_AUTH_FAILED");
            const verified = verifyBrokerProof(request, bootstrap, { expectedNonce: nonce });
            if (!verified.ok) throw new Error(verified.code);
            state = "ready";
            hello = null;
            nonce = "";
            socket.write(`${JSON.stringify({ type: "hello_ok" })}\n`);
            continue;
          }
          const argv = request?.params?.argv;
          const cwd = request?.params?.cwd;
          const relative = path.relative(root, path.resolve(cwd));
          if (request?.method !== "local_run_command" || !Array.isArray(argv) || argv[0] !== "git") {
            throw new Error("test broker only permits structured Git");
          }
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("test broker cwd escapes workspace");
          const result = spawnSync("git", argv.slice(1), { cwd, shell: false, encoding: "utf8", windowsHide: true });
          if (result.error) throw result.error;
          socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { code: result.status ?? -1, signal: result.signal ?? undefined, stdout: result.stdout ?? "", stderr: result.stderr ?? "", truncated: false } })}\n`);
        } catch (error) {
          socket.end(`${JSON.stringify({ type: "hello_error", code: error.message === "BROKER_PROTOCOL_MISMATCH" ? error.message : "BROKER_AUTH_FAILED" })}\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, auth, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("Windows managed worktrees require the App-owned Git broker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-win-worktree-broker-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  try {
    const manage = createManagedWorktreeRunner({
      workspace: root,
      platform: "win32",
      localBrokerSocket: path.join(root, "missing-broker.sock"),
      localBrokerAuth: TEST_BROKER_AUTH,
    });
    await assert.rejects(
      manage({ action: "list", cwd: "repo" }),
      /本机代理|local broker|connect/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multi-agent coordinator isolates agents in managed Git worktrees without auto-merge", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-multi-agent-"));
  const broker = await startWindowsGitBroker(root);
  t.after(async () => {
    await broker?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=LPC Test", "-c", "user.email=lpc@example.invalid", "commit", "-m", "initial"]);

  const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
  const coordinator = createMultiAgentCoordinator({ workspace: root, tools, localBrokerSocket: broker?.socketPath ?? "", localBrokerAuth: broker?.auth, maxAgents: 2 });
  const result = await coordinator.run({
    cwd: "repo",
    goal: "Inspect the isolated worktree",
    agents: [{ name: "alpha" }, { name: "beta" }],
  }, {
    requestApproval: () => true,
    createAgent: async ({ name, worktreePath }) => ({
      async modelStep({ turn }) {
        if (turn === 1) {
          return { type: "tool", tool: "search_files", input: { glob: "README.md" } };
        }
        return {
          type: "finish",
          summary: `${name} inspected ${worktreePath}`,
          evidence: ["README.md was visible in the isolated worktree"],
        };
      },
    }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.results.length, 2);
  assert.equal(new Set(result.results.map((entry) => entry.branch)).size, 2);
  assert.ok(result.results.every((entry) => entry.status === "completed"));
  assert.equal(result.mergePolicy, "manual-or-primary-agent-reviewed");
  for (const worktree of result.worktrees) {
    assert.equal(fs.existsSync(path.join(root, worktree.worktreePath)), true);
    assert.match(worktree.worktreePath, /\.webgpt-bridge[\\/]worktrees/);
  }

  const cleanup = await coordinator.cleanup(result, { requestApproval: () => true });
  assert.equal(cleanup.status, "completed");
  for (const worktree of result.worktrees) {
    assert.equal(fs.existsSync(path.join(root, worktree.worktreePath)), false);
  }
});
