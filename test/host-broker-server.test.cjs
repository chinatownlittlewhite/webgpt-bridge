const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modulePath = path.join(__dirname, "..", "src", "host", "broker-server.cjs");

test("Host broker owns authenticated transport and canonical fixed dispatch", () => {
  const source = fs.readFileSync(modulePath, "utf8");
  assert.match(source, /getBrokerMethodMetadata\(method\)/);
  assert.match(source, /metadata\.implementationKey/);
  assert.match(source, /createBrokerChallenge/);
  assert.match(source, /verifyBrokerProof/);
  assert.match(source, /awaiting_hello/);
  assert.match(source, /awaiting_proof/);
  assert.match(source, /BROKER_AUTH_FAILED/);
  assert.match(source, /BROKER_PROTOCOL_MISMATCH/);
  assert.match(source, /1024 \* 1024/);
  for (const key of [
    "file.list", "file.read", "known-folder.list", "known-folder.read", "health.probe",
    "access.sensitive.request", "access.host.request", "file-batch.stage", "file-batch.confirm",
    "command.run", "command.approve",
  ]) assert.match(source, new RegExp(key.replaceAll(".", "\\.")));
  assert.doesNotMatch(source, /handlers\s*\[\s*method\s*\]/);
});

test("Host broker socket path stays process-scoped and platform-native", () => {
  const { createHostBrokerServer } = require(modulePath);
  const app = { getPath: (name) => name === "temp" ? "/tmp/wgb-test" : "/state" };
  const common = {
    app,
    hostSecurity: { clearApprovals() {}, setApprovalMode() {}, confirmLocalOperation: async () => true, confirmHostCommandApproval: async () => ({ approved: true }) },
    appendLog() {},
    endpoints: { mcpHost: "127.0.0.1", mcpPort: 43123, tunnelHealthHost: "127.0.0.1", tunnelHealthPort: 43124 },
  };
  const unix = createHostBrokerServer({ ...common, platform: "darwin", pid: 1234 });
  assert.equal(unix.getSocketPath(), path.join("/tmp/wgb-test", "webgpt-bridge-1234.sock"));
  const windows = createHostBrokerServer({ ...common, platform: "win32", pid: 5678 });
  assert.equal(windows.getSocketPath(), "\\\\.\\pipe\\webgpt-bridge-5678");
});
