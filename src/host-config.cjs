function normalizeSettings(input = {}, defaults = {}) {
  return {
    ...defaults,
    ...input,
    agentMode: "bundled",
    developmentPath: "",
    approvalMode: ["cautious", "development", "auto"].includes(input.approvalMode) ? input.approvalMode : "development",
  };
}

function validateDevelopmentRuntime(settings) {
  return { mode: "bundled", workspacePath: settings.workspacePath, runtimePath: settings.runtimePath };
}

module.exports = { normalizeSettings, validateDevelopmentRuntime };
