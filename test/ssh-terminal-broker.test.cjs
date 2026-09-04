const test = require("node:test");
const assert = require("node:assert/strict");

function classifier(argv) {
  if (argv[0] === "ssh") return { decision: "approval_required", rule: "ssh-network", reason: "SSH requires host validation" };
  return { decision: "allow", rule: "project-check" };
}

test("SSH remains unavailable unless the host explicitly configures its validator and pinned executable", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const broker = createLocalTerminalBroker({ classifyCommand: classifier, spawnCommand: async () => ({ code: 0 }) });
  await assert.rejects(broker.run({ argv: ["ssh", "10.0.0.8", "uptime"], cwd: "/project" }), /ssh|SSH/i);
});

test("enabled SSH validates before approval and spawns only the pinned executable with forced options", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const { validateSshCommand } = require("../src/ssh-policy.cjs");
  const prompts = [];
  const calls = [];
  const broker = createLocalTerminalBroker({
    approvalMode: "cautious",
    classifyCommand: classifier,
    sshPolicy: (argv) => validateSshCommand(argv, { allowedHosts: ["example.com"] }),
    trustedExecutables: { ssh: "/usr/bin/ssh" },
    confirm: async (request) => { prompts.push(request); return true; },
    spawnCommand: async (argv, options) => { calls.push({ argv, options }); return { code: 0, stdout: "", stderr: "" }; },
  });
  await broker.run({ argv: ["ssh", "deploy@example.com", "uptime"], cwd: "/project" });
  assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].argv, ["ssh", "deploy@example.com", "uptime"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].argv[0], "/usr/bin/ssh");
  assert.equal(calls[0].argv.includes("BatchMode=yes"), true);
  assert.equal(calls[0].options.env, undefined, "HTTP proxy variables must not be injected into SSH");
});

test("Windows SSH accepts the explicitly pinned system OpenSSH executable", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const { validateSshCommand } = require("../src/ssh-policy.cjs");
  const calls = [];
  const pinned = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
  const broker = createLocalTerminalBroker({
    approvalMode: "full_control",
    classifyCommand: classifier,
    sshPolicy: (argv) => validateSshCommand(argv, { allowedHosts: [] }),
    trustedExecutables: { ssh: pinned },
    spawnCommand: async (argv) => { calls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
  });
  await broker.run({ argv: ["ssh", "10.0.0.8", "uptime"], cwd: "C:\\workspace" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], pinned);
  assert.equal(calls[0].includes("BatchMode=yes"), true);
});

test("full_control may skip confirmation but never skips SSH host or argv validation", async () => {
  const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");
  const { validateSshCommand } = require("../src/ssh-policy.cjs");
  let confirmations = 0;
  let calls = 0;
  const broker = createLocalTerminalBroker({
    approvalMode: "full_control",
    classifyCommand: classifier,
    sshPolicy: (argv) => validateSshCommand(argv, { allowedHosts: [] }),
    trustedExecutables: { ssh: "/usr/bin/ssh" },
    confirm: async () => { confirmations += 1; return true; },
    spawnCommand: async () => { calls += 1; return { code: 0 }; },
  });
  await broker.run({ argv: ["ssh", "10.0.0.8", "uptime"], cwd: "/project" });
  await assert.rejects(broker.run({ argv: ["ssh", "example.com", "uptime"], cwd: "/project" }), /allow|private|local|允许/i);
  await assert.rejects(broker.run({ argv: ["ssh", "-L", "8080:localhost:80", "10.0.0.8", "uptime"], cwd: "/project" }), /SSH|option|选项|不允许/i);
  assert.equal(confirmations, 0);
  assert.equal(calls, 1);
});
