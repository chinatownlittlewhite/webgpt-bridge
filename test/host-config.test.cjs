const test = require("node:test");
const assert = require("node:assert/strict");

function api() {
  return require("../src/host-config.cjs");
}

test("bundled mode preserves existing workspace and runtime", () => {
  const { validateDevelopmentRuntime } = api();
  assert.deepEqual(validateDevelopmentRuntime({ agentMode: "bundled", workspacePath: "/work", runtimePath: "/runtime" }), {
    mode: "bundled", workspacePath: "/work", runtimePath: "/runtime",
  });
});

test("legacy development-mode settings migrate back to the bundled runtime", () => {
  const { normalizeSettings, validateDevelopmentRuntime } = api();
  const settings = normalizeSettings({
    agentMode: "development",
    developmentPath: "/old/source-checkout",
    workspacePath: "/work",
    runtimePath: "/runtime",
  });
  assert.equal(settings.agentMode, "bundled");
  assert.equal(settings.developmentPath, "");
  assert.deepEqual(validateDevelopmentRuntime(settings), {
    mode: "bundled", workspacePath: "/work", runtimePath: "/runtime",
  });
});

test("normalization keeps older bundled settings compatible", () => {
  const { normalizeSettings } = api();
  assert.deepEqual(normalizeSettings({ workspacePath: "/work" }, { runtimePath: "/runtime", agentMode: "bundled", developmentPath: "" }), {
    workspacePath: "/work", runtimePath: "/runtime", agentMode: "bundled", developmentPath: "", httpsProxy: "", sshEnabled: false, sshAllowedHosts: [], approvalMode: "development", designIssueJournal: false,
  });
});

test("normalization persists only known local approval modes", () => {
  const { normalizeSettings } = api();
  assert.equal(normalizeSettings({ approvalMode: "auto" }).approvalMode, "auto");
  assert.equal(normalizeSettings({ approvalMode: "full_control" }).approvalMode, "full_control");
  assert.equal(normalizeSettings({ approvalMode: "development" }).approvalMode, "development");
  assert.equal(normalizeSettings({ approvalMode: "anything-else" }).approvalMode, "development");
});
