const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(ROOT, relative));

const expectedProfiles = ["code-change", "read-only-audit", "system-operation"];

function assertNoSensitiveDiagnosticMaterial(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [
    "TOP-SECRET",
    "BEARER-TOKEN",
    "proxy-password",
    "/secret/broker.sock",
    "/secret/gh",
    "/Users/private/workspace",
    "C:\\secret\\host-prep.exe",
  ]) {
    assert.equal(text.includes(forbidden), false, `diagnostic output leaked ${forbidden}`);
  }
}

test("shared product metadata is the canonical allowlisted source for versions protocols profiles and tools", () => {
  assert.equal(exists("shared/product-contract.cjs"), true, "shared product contract must exist");
  assert.equal(exists("shared/product-metadata.cjs"), true, "shared product metadata projector must exist");

  const contract = require(path.join(ROOT, "shared", "product-contract.cjs"));
  const { createProductMetadata } = require(path.join(ROOT, "shared", "product-metadata.cjs"));
  const brokerProtocol = require(path.join(ROOT, "shared", "local-broker-protocol.cjs"));
  const registry = require(path.join(ROOT, "shared", "tool-registry.cjs"));
  const desktopPackage = require(path.join(ROOT, "package.json"));
  const agentPackage = require(path.join(ROOT, "agent-runtime", "package.json"));

  const metadata = createProductMetadata({ brokerEnabled: true });
  assert.deepEqual(Object.keys(metadata).sort(), [
    "agentVersion",
    "brokerProtocolVersion",
    "brokerTools",
    "desktopVersion",
    "goalStoreVersion",
    "goalTools",
    "mcpProtocolRevision",
    "supportedGoalVerificationProfiles",
    "tools",
  ].sort());
  assert.equal(metadata.desktopVersion, desktopPackage.version);
  assert.equal(metadata.agentVersion, agentPackage.version);
  assert.equal(metadata.desktopVersion, contract.DESKTOP_VERSION);
  assert.equal(metadata.agentVersion, contract.AGENT_VERSION);
  assert.equal(metadata.brokerProtocolVersion, brokerProtocol.BROKER_PROTOCOL_VERSION);
  assert.equal(metadata.goalStoreVersion, contract.GOAL_STORE_VERSION);
  assert.equal(metadata.mcpProtocolRevision, contract.MCP_PROTOCOL_REVISION);
  assert.deepEqual(metadata.supportedGoalVerificationProfiles, expectedProfiles);
  assert.deepEqual(metadata.tools, registry.listToolNames({ brokerEnabled: true }));
  assert.deepEqual(metadata.goalTools, registry.listGoalToolNames({ brokerEnabled: true }));
  assert.deepEqual(metadata.brokerTools, registry.listBrokerToolNames({ brokerEnabled: true }));
  assertNoSensitiveDiagnosticMaterial(metadata);
});

test("the packaged Agent receives the same product contract and metadata projector", () => {
  const syncSource = read("agent-runtime/scripts/sync-canonical-registry.mjs");
  assert.match(syncSource, /product-contract\.cjs/);
  assert.match(syncSource, /product-metadata\.cjs/);
  assert.equal(exists("agent-runtime/src/product-metadata.js"), true, "Agent product metadata adapter must exist");
});

test("Agent get_capabilities adds shared product facts without leaking Host paths or secrets", async () => {
  const toolModule = await import(pathToFileURL(path.join(ROOT, "agent-runtime", "src", "tool.js")).href);
  const sandboxModule = await import(pathToFileURL(path.join(ROOT, "agent-runtime", "src", "sandbox.js")).href);
  const capabilities = toolModule.createCapabilitiesTool({
    sandboxAdapter: sandboxModule.createNoSandboxAdapter(),
    networkSandboxState: { status: "disabled", usable: false, enabled: false, platform: process.platform, allowNetwork: true, reason: "disabled", recoverable: false },
    githubCliState: { status: "ready", resolvedPath: "/secret/gh", version: "2.0.0", reason: null, remediation: null },
    windowsHostPreparationState: {
      status: "ready",
      usable: true,
      capabilityName: "test",
      expectedPath: "C:\\secret\\host-prep.exe",
      reason: "prepared",
      remediation: null,
    },
    workspace: "/Users/private/workspace",
    localBrokerSocket: "/secret/broker.sock",
    goalPersistSessions: true,
    platform: "win32",
    auditLogger: { enabled: false },
  }).invoke();

  const { createProductMetadata } = require(path.join(ROOT, "shared", "product-metadata.cjs"));
  const shared = createProductMetadata({ brokerEnabled: true });
  for (const key of [
    "desktopVersion",
    "agentVersion",
    "mcpProtocolRevision",
    "brokerProtocolVersion",
    "goalStoreVersion",
    "supportedGoalVerificationProfiles",
    "tools",
    "goalTools",
    "brokerTools",
  ]) {
    assert.deepEqual(capabilities[key], shared[key], `get_capabilities drifted for ${key}`);
  }
  assert.equal(capabilities.version, shared.agentVersion, "legacy version field must remain compatible");
  assert.equal(capabilities.mcp.protocolRevision, shared.mcpProtocolRevision);
  assert.deepEqual(capabilities.goalMode.supportedVerificationProfiles, shared.supportedGoalVerificationProfiles);
  assert.equal(capabilities.githubCli.resolvedPath, null);
  assert.equal(capabilities.windowsHostPreparation.expectedPath, null);
  assertNoSensitiveDiagnosticMaterial(capabilities);
});

test("Desktop diagnostics exposes the same fixed product facts through trusted no-payload IPC", () => {
  assert.equal(exists("src/host/diagnostics-service.cjs"), true, "Desktop diagnostics service must exist");
  const { createDiagnosticsService } = require(path.join(ROOT, "src", "host", "diagnostics-service.cjs"));
  const { createProductMetadata } = require(path.join(ROOT, "shared", "product-metadata.cjs"));
  const diagnostics = createDiagnosticsService({ brokerEnabled: true }).snapshot();
  assert.deepEqual(diagnostics, createProductMetadata({ brokerEnabled: true }));
  assertNoSensitiveDiagnosticMaterial(diagnostics);

  const ipc = read("src/host/ipc-controller.cjs");
  const preload = read("src/preload.cjs");
  const main = read("src/main.cjs");
  assert.match(ipc, /handle\(["']host:diagnostics["'],\s*\(\)\s*=>\s*diagnosticsService\.snapshot\(\)\)/);
  assert.match(preload, /diagnostics:\s*\(\)\s*=>\s*ipcRenderer\.invoke\(["']host:diagnostics["']\)/);
  assert.match(main, /createDiagnosticsService/);
  assert.match(main, /diagnosticsService/);
});

test("Desktop diagnostics renderer surfaces trusted versions protocols Goal metadata and tool counts", () => {
  const html = read("src/renderer/index.html");
  const renderer = read("src/renderer/renderer.js");
  for (const id of ["diagnosticVersions", "diagnosticProtocols", "diagnosticGoalStore", "diagnosticToolCounts"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(renderer, /renderDiagnostics/);
  assert.match(renderer, /api\.diagnostics\(\)/);
  assert.match(renderer, /desktopVersion/);
  assert.match(renderer, /agentVersion/);
  assert.match(renderer, /brokerProtocolVersion/);
  assert.match(renderer, /goalStoreVersion/);
});
