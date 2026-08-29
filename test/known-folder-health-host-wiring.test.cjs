const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop broker wires known-folder and fixed health methods and clears helper state on stop", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(main, /createKnownFolderAccess/);
  assert.match(main, /createLoopbackHealthProbe/);
  assert.match(main, /local_list_known_folder/);
  assert.match(main, /local_read_known_folder/);
  assert.match(main, /local_probe_health/);
  assert.match(main, /local_request_host_access/);
  assert.match(main, /createHostCapabilityStore/);
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
