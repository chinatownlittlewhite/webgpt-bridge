import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createMultiAgentCoordinator } from "../src/multi-agent.js";
import { createCoreTools } from "../src/tool.js";
import { createManagedWorktreeRunner } from "../src/worktree.js";

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, shell: false, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${args.join(" ")}: ${result.stderr || result.stdout}`);
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
    });
    await assert.rejects(
      manage({ action: "list", cwd: "repo" }),
      /本机代理|local broker|connect/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multi-agent coordinator isolates agents in managed Git worktrees without auto-merge", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lpc-multi-agent-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, ["init"]);
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["-c", "user.name=LPC Test", "-c", "user.email=lpc@example.invalid", "commit", "-m", "initial"]);

  const tools = createCoreTools({ workspace: root, goalVerificationTasks: [] });
  const coordinator = createMultiAgentCoordinator({ workspace: root, tools, maxAgents: 2 });
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
  fs.rmSync(root, { recursive: true, force: true });
});
