const test = require("node:test");
const assert = require("node:assert/strict");

const { classifyGithubDiagnostic, classifyMcpDiagnostic } = require("../src/host/diagnostics-service.cjs");

test("GitHub diagnostics distinguish missing CLI authentication and upstream failure", () => {
  assert.equal(classifyGithubDiagnostic({ available: false }).code, "CLI_UNAVAILABLE");
  assert.equal(classifyGithubDiagnostic({ available: true, authenticated: false }).code, "NOT_AUTHENTICATED");
  assert.equal(classifyGithubDiagnostic({ available: true, authenticated: true, upstreamOk: false }).code, "UPSTREAM_ERROR");
  assert.equal(classifyGithubDiagnostic({ available: true, authenticated: true, upstreamOk: true }).code, "READY");
});

test("diagnostic messages are bounded and do not reflect raw command output", () => {
  const result = classifyGithubDiagnostic({
    available: true,
    authenticated: false,
    stderr: "token=ghp_super_secret /Users/example/private/path",
  });
  assert.equal(result.code, "NOT_AUTHENTICATED");
  assert.equal(JSON.stringify(result).includes("ghp_super_secret"), false);
  assert.equal(JSON.stringify(result).includes("/Users/example/private/path"), false);
});

test("MCP health maps to stable service states", () => {
  assert.equal(classifyMcpDiagnostic({ connected: true, agentHealth: "ready" }).code, "READY");
  assert.equal(classifyMcpDiagnostic({ connected: false, agentHealth: "unknown" }).code, "STOPPED");
  assert.equal(classifyMcpDiagnostic({ connected: true, agentHealth: "degraded" }).code, "HEALTH_DEGRADED");
});
