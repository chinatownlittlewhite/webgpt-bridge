const test = require("node:test");
const assert = require("node:assert/strict");

const { aggregateCapabilities } = require("../src/host/diagnostics-service.cjs");

test("capabilities aggregate exposes only status policy and bounded services", () => {
  const result = aggregateCapabilities({
    policy: { sandbox: "default-deny", approval: "host-owned" },
    services: {
      github: { status: "degraded", code: "NOT_AUTHENTICATED", message: "GitHub authentication required", token: "secret", raw: "sensitive stderr" },
      mcp: { status: "ready", code: "READY", message: "MCP ready", raw: "ignored" },
    },
  });
  assert.deepEqual(Object.keys(result).sort(), ["policy", "services", "status"]);
  assert.deepEqual(result.policy, { sandbox: "default-deny", approval: "host-owned" });
  assert.equal(result.status, "degraded");
  assert.equal(result.services.github.code, "NOT_AUTHENTICATED");
  assert.equal(result.services.github.token, undefined);
  assert.equal(result.services.github.raw, undefined);
  assert.equal(result.services.mcp.raw, undefined);
});

test("aggregate status fails closed when any service is unavailable", () => {
  const result = aggregateCapabilities({
    policy: {},
    services: {
      github: { status: "unavailable", code: "CLI_UNAVAILABLE", message: "GitHub CLI unavailable" },
      mcp: { status: "ready", code: "READY", message: "MCP ready" },
    },
  });
  assert.equal(result.status, "unavailable");
});
