import test from "node:test";
import assert from "node:assert/strict";
import * as broker from "../src/local-broker-client.js";
import { validateJsonSchema } from "../src/schema-validate.js";

function schemas() {
  for (const name of ["localListKnownFolderInputSchema", "localReadKnownFolderInputSchema", "localProbeHealthInputSchema"]) {
    assert.equal(typeof broker[name], "object", `${name} must be exported`);
  }
  return broker;
}

test("known-folder schemas allow only fixed folders and relative paths", () => {
  const { localListKnownFolderInputSchema, localReadKnownFolderInputSchema } = schemas();
  validateJsonSchema({ folder: "desktop", relativePath: "projects/demo", depth: 2 }, localListKnownFolderInputSchema);
  validateJsonSchema({ folder: "documents", relativePath: "notes/todo.txt", startLine: 1, maxLines: 20 }, localReadKnownFolderInputSchema);

  assert.throws(() => validateJsonSchema({ folder: "home", relativePath: "notes" }, localListKnownFolderInputSchema), /enum|allowed|folder/i);
  assert.throws(() => validateJsonSchema({ folder: "desktop", relativePath: "/etc/hosts" }, localReadKnownFolderInputSchema), /match|relative|pattern/i);
  assert.throws(() => validateJsonSchema({ folder: "downloads", relativePath: "../secret" }, localReadKnownFolderInputSchema), /match|relative|pattern/i);
  assert.equal(localListKnownFolderInputSchema.additionalProperties, false);
  assert.equal(localReadKnownFolderInputSchema.additionalProperties, false);
});

test("health schema allows only agent, tunnel, and github fixed targets", () => {
  const { localProbeHealthInputSchema } = schemas();
  for (const target of ["agent", "tunnel", "github"]) {
    validateJsonSchema({ target }, localProbeHealthInputSchema);
  }
  assert.throws(() => validateJsonSchema({ target: "https://example.com/health" }, localProbeHealthInputSchema), /enum|allowed|target/i);
  assert.equal(localProbeHealthInputSchema.additionalProperties, false);
});

test("Agent exposes known-folder and health tools only through the App-owned broker", () => {
  const auth = { protocolVersion: 1, sessionId: "test-session", secret: "test-secret", agentVersion: "0.9.3" };
  const tools = new Map(broker.createLocalBrokerTools({ socketPath: "/tmp/webgpt-bridge-local-access-test.sock", auth }).map((tool) => [tool.name, tool]));
  for (const name of ["local_list_known_folder", "local_read_known_folder", "local_probe_health"]) {
    assert.equal(tools.has(name), true, `${name} should be exposed`);
  }
  assert.match(tools.get("local_probe_health").description, /agent|tunnel|github/i);
});
