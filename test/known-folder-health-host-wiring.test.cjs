const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { getBrokerMethodMetadata } = require("../shared/tool-registry.cjs");

test("desktop broker wires known-folder and fixed health methods and clears helper state on stop", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(main, /createKnownFolderAccess/);
  assert.match(main, /createLoopbackHealthProbe/);
  assert.equal(getBrokerMethodMetadata("local_list_known_folder").implementationKey, "known-folder.list");
  assert.equal(getBrokerMethodMetadata("local_read_known_folder").implementationKey, "known-folder.read");
  assert.equal(getBrokerMethodMetadata("local_probe_health").implementationKey, "health.probe");
  assert.equal(getBrokerMethodMetadata("local_request_host_access").implementationKey, "access.host.request");
  assert.match(main, /createHostCapabilityStore/);
  assert.match(main, /transactionRegistryPath:\s*path\.join\(app\.getPath\("userData"\),\s*"local-file-transactions\.json"\)/);
  assert.match(main, /issueCapability/);
  assert.match(main, /localCapabilityStore\?\.clear\(\)/);
  assert.match(main, /createBrokerBootstrap/);
  assert.match(main, /createBrokerChallenge/);
  assert.match(main, /verifyBrokerProof/);
  assert.match(main, /LPC_LOCAL_BROKER_PROTOCOL/);
  assert.match(main, /LPC_LOCAL_BROKER_SESSION/);
  assert.match(main, /LPC_LOCAL_BROKER_SECRET/);
  assert.match(main, /localKnownFolderAccess\s*=\s*undefined/);
  assert.match(main, /localHealthProbe\s*=\s*undefined/);
});
