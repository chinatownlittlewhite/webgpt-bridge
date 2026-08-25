const test = require("node:test");
const assert = require("node:assert/strict");

function classifier(argv) {
  if (argv[0] === "npm" && argv[1] === "test") return { decision: "allow", rule: "project-check" };
  if (argv[0] === "curl") return { decision: "allow", rule: "network" };
  if (argv[0] === "git") return { decision: "approval_required", rule: "git-mutation" };
  if (argv[0] === "gh") return { decision: "approval_required", rule: "default-ask" };
  if (argv[0] === "node") return { decision: "approval_required", rule: "runtime-execution" };
  return { decision: "approval_required", rule: "default-ask" };
}

test("only accepts argv commands and refuses shells, privilege escalation, and executable paths", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const broker = createLocalTerminalBroker({ classifyCommand: classifier, spawnCommand: async () => ({ code: 0 }) });
  await assert.rejects(broker.run({ argv: "npm test", cwd: "/project" }), /argv/);
  await assert.rejects(broker.run({ argv: ["sudo", "npm", "test"], cwd: "/project" }), /sudo/);
  await assert.rejects(broker.run({ argv: ["/bin/sh", "-c", "echo hi"], cwd: "/project" }), /PATH/);
});

test("auto-runs only host-safe read operations while keeping arbitrary host execution and writes confirmed", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const prompts = [];
  const calls = [];
  const broker = createLocalTerminalBroker({
    approvalMode: "auto",
    classifyCommand: classifier,
    confirm: async (request) => { prompts.push(request); return true; },
    spawnCommand: async (argv, options) => { calls.push({ argv, options }); return { code: 0, stdout: "ok", stderr: "" }; },
  });

  await broker.run({ argv: ["npm", "test"], cwd: "/project" });
  await broker.run({ argv: ["pwd"], cwd: "/project" });
  await broker.run({ argv: ["gh", "run", "list"], cwd: "/project" });
  await broker.run({ argv: ["gh", "pr", "view", "1"], cwd: "/project" });
  await broker.run({ argv: ["git", "ls-remote", "origin"], cwd: "/project" });
  await broker.run({ argv: ["curl", "https://example.com"], cwd: "/project" });
  await broker.run({ argv: ["git", "commit", "-m", "x"], cwd: "/project" });
  await broker.run({ argv: ["node", "script.mjs"], cwd: "/project" });
  await broker.run({ argv: ["gh", "issue", "create", "--title", "x"], cwd: "/project" });

  assert.equal(prompts.length, 3);
  assert.deepEqual(prompts.map((item) => item.argv), [
    ["curl", "https://example.com"],
    ["git", "commit", "-m", "x"],
    ["gh", "issue", "create", "--title", "x"],
  ]);
  assert.equal(calls.length, 9);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, "/project");
});

test("trusted executable bindings rewrite only the spawn argv while policy sees the logical command", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const calls = [];
  const trustedGh = process.platform === "win32" ? "C:\\Program Files\\GitHub CLI\\gh.exe" : "/opt/homebrew/bin/gh";
  const broker = createLocalTerminalBroker({
    approvalMode: "auto",
    classifyCommand: classifier,
    trustedExecutables: { gh: trustedGh },
    spawnCommand: async (argv, options) => { calls.push({ argv, options }); return { code: 0, stdout: "ok", stderr: "" }; },
  });
  await broker.run({ argv: ["gh", "run", "list"], cwd: "/project" });
  assert.deepEqual(calls[0].argv, [trustedGh, "run", "list"]);
  assert.equal(calls[0].options.cwd, "/project");
});

test("full control bypasses native confirmation and command blocking", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  let confirmations = 0;
  const calls = [];
  const broker = createLocalTerminalBroker({
    approvalMode: "full_control",
    classifyCommand: () => ({ decision: "deny", rule: "always-deny", reason: "blocked" }),
    confirm: async () => { confirmations += 1; return false; },
    spawnCommand: async (argv) => { calls.push(argv); return { code: 0 }; },
  });
  await broker.run({ argv: ["sudo", "whoami"], cwd: "/project" });
  await broker.run({ argv: ["/bin/sh", "-c", "echo hi"], cwd: "/project" });
  assert.equal(confirmations, 0);
  assert.deepEqual(calls, [["sudo", "whoami"], ["/bin/sh", "-c", "echo hi"]]);
});

test("full control bypasses the real Agent classifier for blocked and absolute executables", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const { classifyCommand } = await import("../agent-runtime/src/policy.js");
  const calls = [];
  const broker = createLocalTerminalBroker({
    approvalMode: "full_control",
    classifyCommand,
    confirm: async () => { throw new Error("full control must not confirm"); },
    spawnCommand: async (argv) => { calls.push(argv); return { code: 0 }; },
  });
  await broker.run({ argv: ["sudo", "whoami"], cwd: "/project" });
  await broker.run({ argv: ["/bin/sh", "-c", "echo hi"], cwd: "/project" });
  assert.deepEqual(calls, [["sudo", "whoami"], ["/bin/sh", "-c", "echo hi"]]);
});

test("does not execute a request when native confirmation is declined", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  let executed = false;
  const broker = createLocalTerminalBroker({
    classifyCommand: classifier,
    confirm: async () => false,
    spawnCommand: async () => { executed = true; return { code: 0 }; },
  });
  await assert.rejects(broker.run({ argv: ["git", "reset", "--soft", "HEAD~1"], cwd: "/project" }), /取消/);
  assert.equal(executed, false);
});
