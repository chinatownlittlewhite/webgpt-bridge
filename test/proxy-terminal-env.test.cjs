const test = require("node:test");
const assert = require("node:assert/strict");
const { createLocalTerminalBroker } = require("../src/local-terminal-broker.cjs");

function classifier(argv) {
  if (argv[0] === "npm" && argv[1] === "test") return { decision: "allow", rule: "project-check" };
  if (argv[0] === "git") return { decision: "approval_required", rule: "git-mutation" };
  if (argv[0] === "curl") return { decision: "approval_required", rule: "sensitive-command" };
  return { decision: "approval_required", rule: "default-ask" };
}

test("proxy environment is injected only into recognized external network commands", async () => {
  const calls = [];
  const proxyEnv = Object.freeze({
    HTTP_PROXY: "http://127.0.0.1:12001",
    HTTPS_PROXY: "http://127.0.0.1:12001",
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
  const broker = createLocalTerminalBroker({
    approvalMode: "full_control",
    classifyCommand: classifier,
    networkEnv: proxyEnv,
    spawnCommand: async (argv, options) => {
      calls.push({ argv, options });
      return { code: 0, stdout: "", stderr: "" };
    },
  });

  await broker.run({ argv: ["npm", "test"], cwd: "/project" });
  await broker.run({ argv: ["git", "fetch", "origin"], cwd: "/project" });
  await broker.run({ argv: ["curl", "https://example.com"], cwd: "/project" });

  assert.equal(calls[0].options.env, undefined);
  assert.deepEqual(calls[1].options.env, proxyEnv);
  assert.deepEqual(calls[2].options.env, proxyEnv);
});

test("approval requests never expose proxy environment values", async () => {
  const prompts = [];
  const proxyEnv = { HTTP_PROXY: "http://127.0.0.1:12001", HTTPS_PROXY: "http://127.0.0.1:12001", NO_PROXY: "127.0.0.1,localhost,::1" };
  const broker = createLocalTerminalBroker({
    approvalMode: "cautious",
    classifyCommand: classifier,
    networkEnv: proxyEnv,
    confirm: async (request) => { prompts.push(request); return true; },
    spawnCommand: async () => ({ code: 0, stdout: "", stderr: "" }),
  });

  await broker.run({ argv: ["curl", "https://example.com"], cwd: "/project" });
  assert.equal(prompts.length, 1);
  assert.equal(JSON.stringify(prompts[0]).includes("12001"), false);
  assert.equal(Object.hasOwn(prompts[0], "env"), false);
});
