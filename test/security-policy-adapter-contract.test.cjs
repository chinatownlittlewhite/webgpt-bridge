const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const desktopPolicy = require("../src/local-policy.cjs");
const { authorizeSecurityOperation } = require("../shared/security-policy-core.cjs");

async function agentApi() {
  const policy = await import(pathToFileURL(path.join(__dirname, "..", "agent-runtime", "src", "policy.js")).href);
  const runner = await import(pathToFileURL(path.join(__dirname, "..", "agent-runtime", "src", "runner.js")).href);
  return { ...policy, ...runner };
}

function hostRequest(policy, argv, sandbox = { enforced: true, autoRunSafe: true }) {
  return {
    argv,
    cwd: "/workspace",
    policy,
    sandbox,
    sandboxAccess: { read: [], write: [] },
  };
}

test("Desktop and Agent adapters agree on canonical rule ids for shared command classes", async () => {
  const { classifyCommand } = await agentApi();
  const cases = [
    { argv: ["bash", "-c", "echo x"], preset: "full_control", rule: "always-deny" },
    { argv: ["git", "status"], preset: "development", rule: "git-read-only" },
    { argv: ["git", "commit", "-m", "x"], preset: "cautious", rule: "git-mutation" },
    { argv: ["npm", "install"], preset: "development", rule: "package-manager" },
    { argv: ["node", "script.mjs"], preset: "development", rule: "runtime-execution" },
    { argv: ["ssh", "10.0.0.8", "uptime"], preset: "cautious", rule: "ssh-network" },
  ];

  for (const entry of cases) {
    const agent = classifyCommand(entry.argv);
    const desktop = desktopPolicy.classifyHostCommandApproval(hostRequest(agent, entry.argv), entry.preset);
    assert.equal(agent.rule, entry.rule, `${entry.argv[0]} Agent rule`);
    assert.equal(desktop.rule, entry.rule, `${entry.argv[0]} Desktop rule`);
  }
});

test("Desktop and Agent use the same canonical rule for an unverified sandbox", async () => {
  const { classifyCommand, effectiveCommandPolicy } = await agentApi();
  const base = classifyCommand(["npm", "test"]);
  assert.equal(base.decision, "allow");

  const agent = effectiveCommandPolicy(base, { name: "macos-seatbelt", enforced: true, autoRunSafe: false });
  const desktop = desktopPolicy.classifyHostCommandApproval(
    hostRequest(base, ["npm", "test"], { name: "macos-seatbelt", enforced: true, autoRunSafe: false }),
    "full_control",
  );
  assert.equal(agent.rule, "unverified-sandbox");
  assert.equal(desktop.rule, "unverified-sandbox");
  assert.equal(agent.decision, "approval_required");
  assert.equal(desktop.decision, "confirm");
});

test("no adapter can promote a canonical immutable deny", async () => {
  const { classifyCommand, effectiveCommandPolicy } = await agentApi();
  const canonical = authorizeSecurityOperation({ type: "agent-command", commandClass: "immutable-deny" });
  assert.equal(canonical.decision, "deny");

  const agent = classifyCommand(["bash", "-c", "echo x"]);
  const effective = effectiveCommandPolicy(agent, { name: "verified", enforced: true, autoRunSafe: true });
  const desktop = desktopPolicy.classifyHostCommandApproval(hostRequest(agent, ["bash", "-c", "echo x"]), "full_control");
  assert.equal(agent.decision, "deny");
  assert.equal(effective.decision, "deny");
  assert.equal(desktop.decision, "deny");
  assert.equal(agent.rule, canonical.rule);
  assert.equal(desktop.rule, canonical.rule);
});
