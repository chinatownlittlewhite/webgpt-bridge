const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createHostCapabilityStore } = require("../src/host-capability-store.cjs");
const { createLocalFileBroker } = require("../src/local-file-broker.cjs");
const { classifyLocalAction, classifyLocalPath } = require("../src/local-policy.cjs");
const { getBrokerMethodMetadata, getToolMetadata } = require("../shared/tool-registry.cjs");

function phaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-v05-phase1-"));
  const workspace = path.join(root, "workspace");
  const known = path.join(root, "known");
  const ordinary = path.join(root, "ordinary");
  const sensitive = path.join(root, "sensitive");
  const system = path.join(root, "system");
  for (const directory of [workspace, known, ordinary, sensitive, system]) fs.mkdirSync(directory, { recursive: true });
  for (const [directory, name] of [[workspace, "workspace.txt"], [known, "known.txt"], [ordinary, "ordinary.txt"], [sensitive, "secret.txt"], [system, "system.txt"]]) {
    fs.writeFileSync(path.join(directory, name), `${name}\n`, "utf8");
  }
  const policy = (target, options = {}) => classifyLocalPath(target, {
    ...options,
    workspaceRoot: workspace,
    knownFolderRoots: { desktop: known },
    sensitiveRoots: [sensitive],
    systemRoots: [system],
    appDataRoots: [],
    homeDir: path.join(root, "home"),
  });
  const actionPolicy = (action) => classifyLocalAction({ ...action, approvalMode: "full_control" });
  return { root, workspace, known, ordinary, sensitive, system, policy, actionPolicy };
}

test("v0.5 phase one keeps host access capability-scoped and broker authenticated", () => {
  const root = path.join(__dirname, "..");
  const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
  const agent = fs.readFileSync(path.join(root, "agent-runtime", "src", "local-broker-client.js"), "utf8");
  const protocol = fs.readFileSync(path.join(root, "shared", "local-broker-protocol.cjs"), "utf8");
  assert.match(main, /establishSingleInstanceOwnership/);
  assert.match(main, /createHostCapabilityStore/);
  assert.match(main, /createBrokerChallenge/);
  assert.match(main, /verifyBrokerProof/);
  assert.match(main, /LPC_LOCAL_BROKER_PROTOCOL/);
  assert.match(main, /LPC_LOCAL_BROKER_SESSION/);
  assert.match(main, /LPC_LOCAL_BROKER_SECRET/);
  assert.match(agent, /createBrokerProof/);
  assert.match(agent, /BROKER_AUTH_FAILED/);
  assert.match(agent, /BROKER_PROTOCOL_MISMATCH/);
  const hostAccessTool = getToolMetadata("local_request_host_access");
  assert.equal(hostAccessTool.availability, "broker");
  assert.equal(hostAccessTool.brokerMethod, "local_request_host_access");
  assert.equal(getBrokerMethodMetadata(hostAccessTool.brokerMethod).implementationKey, "access.host.request");
  assert.match(protocol, /createHmac\("sha256"/);
  assert.match(protocol, /timingSafeEqual/);
});

test("full_control cannot grant system paths or sensitive write and execute operations", () => {
  const fixture = phaseFixture();
  try {
    const systemRead = fixture.policy(path.join(fixture.system, "system.txt"), { operation: "read" });
    assert.equal(systemRead.scope, "system");
    assert.equal(systemRead.decision, "deny");

    for (const kind of ["create", "update", "delete", "move", "execute"]) {
      const decision = classifyLocalAction({ kind, sensitive: true, approvalMode: "full_control" });
      assert.equal(decision.decision, "deny", `${kind} must remain denied for sensitive paths`);
    }
    for (const kind of ["read", "list"]) {
      const decision = classifyLocalAction({ kind, sensitive: true, approvalMode: "full_control" });
      assert.equal(decision.decision, "confirm", `${kind} must still require explicit sensitive consent`);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("sensitive read capability is explicit single-use and system paths stay ungrantable", async () => {
  const fixture = phaseFixture();
  let approvals = 0;
  let id = 0;
  const capabilityStore = createHostCapabilityStore({
    generation: "phase-one",
    policyVersion: "v0.5-phase1",
    randomId: () => `phase-cap-${++id}`,
  });
  const broker = createLocalFileBroker({
    workspaceRoot: fixture.workspace,
    capabilityStore,
    policy: fixture.policy,
    actionPolicy: fixture.actionPolicy,
    confirm: async ({ kind }) => {
      if (kind === "sensitive-access") approvals += 1;
      return true;
    },
  });
  try {
    const sensitiveFile = path.join(fixture.sensitive, "secret.txt");
    assert.throws(() => broker.read({ path: sensitiveFile }), (error) => error?.code === "HOST_CAPABILITY_REQUIRED");
    const grant = await broker.requestSensitiveAccess({ path: sensitiveFile, operation: "read" });
    assert.equal(approvals, 1);
    assert.equal(broker.read({ path: sensitiveFile, accessId: grant.accessId }).text, "secret.txt\n");
    assert.throws(() => broker.read({ path: sensitiveFile, accessId: grant.accessId }), (error) => error?.code === "HOST_CAPABILITY_REQUIRED");

    const forgedSystemGrant = capabilityStore.issue({
      root: fixture.system,
      operations: ["read"],
      ttlMs: 60_000,
      maxUses: 1,
      className: "test-system-read",
    });
    assert.throws(
      () => broker.read({ path: path.join(fixture.system, "system.txt"), accessId: forgedSystemGrant.accessId }),
      /系统路径|不允许|denied/i,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("model-facing shell deny boundary remains independent of full_control", async () => {
  const policyModule = await import(pathToFileURL(path.join(__dirname, "..", "agent-runtime", "src", "policy.js")).href);
  for (const argv of [["sh", "-c", "true"], ["bash", "-lc", "true"], ["zsh", "-lc", "true"], ["cmd.exe", "/c", "echo ok"], ["powershell.exe", "-Command", "Write-Output ok"], ["pwsh", "-Command", "Write-Output ok"]]) {
    const classification = policyModule.classifyCommand(argv);
    assert.equal(classification.decision, "deny", `${argv[0]} must remain denied to model-facing execution`);
    assert.equal(classification.rule, "always-deny");
  }
});

test("README matches phase-one Host permission compatibility semantics", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.doesNotMatch(readme, /同一敏感根目录读取/);
  assert.match(readme, /敏感路径.*(?:单次|一次).*授权/);
  assert.match(readme, /Desktop\/Downloads\/Documents.*首次访问仍需显式授权/);
  assert.match(readme, /工作区外.*(?:本机|Host).*路径.*授权/);
});
