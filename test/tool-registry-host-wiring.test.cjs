const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  getBrokerMethodMetadata,
  listBrokerToolNames,
} = require("../shared/tool-registry.cjs");

test("canonical broker registry keeps internal approval separate from public broker tools", () => {
  assert.equal(getBrokerMethodMetadata("host_approve_command").implementationKey, "command.approve");
  assert.equal(getBrokerMethodMetadata("host_approve_command").internal, true);
  assert.equal(getBrokerMethodMetadata("local_run_command").implementationKey, "command.run");
  assert.equal(getBrokerMethodMetadata("unknown_method"), null);
  assert.equal(listBrokerToolNames({ brokerEnabled: true }).includes("host_approve_command"), false);
});

test("desktop broker resolves canonical method metadata before fixed implementation dispatch", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(main, /shared\/tool-registry\.cjs/);
  assert.match(main, /getBrokerMethodMetadata\(method\)/);
  assert.match(main, /implementationKey/);
  assert.doesNotMatch(main, /Object\.hasOwn\(handlers,\s*method\)/);
  for (const implementationKey of [
    "file.list",
    "file.read",
    "known-folder.list",
    "known-folder.read",
    "health.probe",
    "access.sensitive.request",
    "access.host.request",
    "file-batch.stage",
    "file-batch.confirm",
    "command.run",
    "command.approve",
  ]) {
    assert.ok(main.includes(`"${implementationKey}"`) || main.includes(`'${implementationKey}'`), implementationKey);
  }
});
