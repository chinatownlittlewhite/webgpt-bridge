"use strict";

const TOOL_REGISTRY_VERSION = 1;

const EMPTY_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

function annotations({ readOnly = false, destructive = false, openWorld = false } = {}) {
  return Object.freeze({
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly,
    openWorldHint: openWorld,
  });
}

function security(mode, { actionField = null, readOnlyActions = [], readOnlyRule = null } = {}) {
  return Object.freeze({
    sideEffectMode: mode,
    actionField,
    readOnlyActions: Object.freeze([...readOnlyActions]),
    readOnlyRule,
  });
}

function toolMetadata({
  name,
  availability = "always",
  goalEligible = true,
  brokerMethod = null,
  timeoutClass = "default",
  security: securityMetadata = security("always"),
  capabilityCategory,
  mcpAnnotations = EMPTY_ANNOTATIONS,
}) {
  return Object.freeze({
    name,
    availability,
    goalEligible,
    brokerMethod,
    timeoutClass,
    security: securityMetadata,
    capabilityCategory,
    mcpAnnotations,
  });
}

const READ_ONLY = security("never", { readOnlyRule: "read-only-tool" });
const SIDE_EFFECTING = security("always");
const READ_ONLY_GIT = security("actions", {
  actionField: "action",
  readOnlyActions: ["status", "diff", "log", "show", "branch_list", "worktree_list"],
  readOnlyRule: "read-only-git-action",
});
const READ_ONLY_GITHUB = security("actions", {
  actionField: "action",
  readOnlyActions: ["pr_view", "ci_status", "issue_view", "release_view"],
  readOnlyRule: "read-only-github-action",
});

const PUBLIC_TOOL_METADATA = Object.freeze([
  toolMetadata({ name: "run_command", timeoutClass: "command", security: SIDE_EFFECTING, capabilityCategory: "execution" }),
  toolMetadata({ name: "run_project_task", timeoutClass: "project-task", security: SIDE_EFFECTING, capabilityCategory: "execution" }),
  toolMetadata({ name: "git", timeoutClass: "command", security: READ_ONLY_GIT, capabilityCategory: "version-control" }),
  toolMetadata({ name: "dependency_sync", timeoutClass: "dependency", security: SIDE_EFFECTING, capabilityCategory: "dependency" , mcpAnnotations: annotations({ openWorld: true }) }),
  toolMetadata({ name: "github", timeoutClass: "network", security: READ_ONLY_GITHUB, capabilityCategory: "remote-version-control", mcpAnnotations: annotations({ openWorld: true }) }),
  toolMetadata({ name: "process_start", timeoutClass: "process", security: SIDE_EFFECTING, capabilityCategory: "process" }),
  toolMetadata({ name: "process_poll", timeoutClass: "process", security: READ_ONLY, capabilityCategory: "process", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "process_input", timeoutClass: "process", security: SIDE_EFFECTING, capabilityCategory: "process" }),
  toolMetadata({ name: "process_kill", timeoutClass: "process", security: SIDE_EFFECTING, capabilityCategory: "process", mcpAnnotations: annotations({ destructive: true }) }),
  toolMetadata({ name: "process_list", timeoutClass: "process", security: READ_ONLY, capabilityCategory: "process", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "read_file", security: READ_ONLY, capabilityCategory: "workspace-read", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "list_dir", security: READ_ONLY, capabilityCategory: "workspace-read", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "search_text", security: READ_ONLY, capabilityCategory: "workspace-read", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "search_files", security: READ_ONLY, capabilityCategory: "workspace-read", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "apply_patch", security: SIDE_EFFECTING, capabilityCategory: "workspace-write" }),
  toolMetadata({ name: "delete_file", security: SIDE_EFFECTING, capabilityCategory: "workspace-write", mcpAnnotations: annotations({ destructive: true }) }),
  toolMetadata({ name: "move_file", security: SIDE_EFFECTING, capabilityCategory: "workspace-write", mcpAnnotations: annotations({ destructive: true }) }),

  toolMetadata({ name: "local_list", availability: "broker", brokerMethod: "local_list", timeoutClass: "broker", security: READ_ONLY, capabilityCategory: "host-read" }),
  toolMetadata({ name: "local_read", availability: "broker", brokerMethod: "local_read", timeoutClass: "broker", security: READ_ONLY, capabilityCategory: "host-read" }),
  toolMetadata({ name: "local_list_known_folder", availability: "broker", brokerMethod: "local_list_known_folder", timeoutClass: "broker", security: READ_ONLY, capabilityCategory: "known-folder-read" }),
  toolMetadata({ name: "local_read_known_folder", availability: "broker", brokerMethod: "local_read_known_folder", timeoutClass: "broker", security: READ_ONLY, capabilityCategory: "known-folder-read" }),
  toolMetadata({ name: "local_probe_health", availability: "broker", brokerMethod: "local_probe_health", timeoutClass: "broker", security: READ_ONLY, capabilityCategory: "diagnostics" }),
  toolMetadata({ name: "local_request_sensitive_access", availability: "broker", brokerMethod: "local_request_sensitive_access", timeoutClass: "interactive-broker", security: SIDE_EFFECTING, capabilityCategory: "host-authorization" }),
  toolMetadata({ name: "local_request_host_access", availability: "broker", brokerMethod: "local_request_host_access", timeoutClass: "interactive-broker", security: SIDE_EFFECTING, capabilityCategory: "host-authorization" }),
  toolMetadata({ name: "local_stage_changes", availability: "broker", brokerMethod: "local_stage_changes", timeoutClass: "broker", security: SIDE_EFFECTING, capabilityCategory: "host-write" }),
  toolMetadata({ name: "local_confirm_batch", availability: "broker", brokerMethod: "local_confirm_batch", timeoutClass: "interactive-broker", security: SIDE_EFFECTING, capabilityCategory: "host-write" }),
  toolMetadata({ name: "local_run_command", availability: "broker", brokerMethod: "local_run_command", timeoutClass: "interactive-broker", security: SIDE_EFFECTING, capabilityCategory: "host-execution" }),

  toolMetadata({ name: "goal_mode", goalEligible: false, timeoutClass: "goal-control", security: SIDE_EFFECTING, capabilityCategory: "goal" }),
  toolMetadata({ name: "goal_step", goalEligible: false, timeoutClass: "goal-control", security: SIDE_EFFECTING, capabilityCategory: "goal" }),
  toolMetadata({ name: "goal_finish", goalEligible: false, timeoutClass: "goal-control", security: SIDE_EFFECTING, capabilityCategory: "goal" }),
  toolMetadata({ name: "goal_status", goalEligible: false, timeoutClass: "goal-control", security: READ_ONLY, capabilityCategory: "goal", mcpAnnotations: annotations({ readOnly: true }) }),
  toolMetadata({ name: "goal_cancel", goalEligible: false, timeoutClass: "goal-control", security: SIDE_EFFECTING, capabilityCategory: "goal" }),
  toolMetadata({ name: "goal_pause", goalEligible: false, timeoutClass: "goal-control", security: SIDE_EFFECTING, capabilityCategory: "goal" }),
  toolMetadata({ name: "goal_resume", goalEligible: false, timeoutClass: "goal-control", security: SIDE_EFFECTING, capabilityCategory: "goal" }),
  toolMetadata({ name: "goal_list", goalEligible: false, timeoutClass: "goal-control", security: READ_ONLY, capabilityCategory: "goal" }),
  toolMetadata({ name: "get_capabilities", goalEligible: false, timeoutClass: "diagnostic", security: READ_ONLY, capabilityCategory: "diagnostics", mcpAnnotations: annotations({ readOnly: true }) }),
]);

function brokerMethod({ method, implementationKey, publicToolName = null, internal = false }) {
  return Object.freeze({ method, implementationKey, publicToolName, internal });
}

const BROKER_METHOD_METADATA = Object.freeze([
  brokerMethod({ method: "local_list", implementationKey: "file.list", publicToolName: "local_list" }),
  brokerMethod({ method: "local_read", implementationKey: "file.read", publicToolName: "local_read" }),
  brokerMethod({ method: "local_list_known_folder", implementationKey: "known-folder.list", publicToolName: "local_list_known_folder" }),
  brokerMethod({ method: "local_read_known_folder", implementationKey: "known-folder.read", publicToolName: "local_read_known_folder" }),
  brokerMethod({ method: "local_probe_health", implementationKey: "health.probe", publicToolName: "local_probe_health" }),
  brokerMethod({ method: "local_request_sensitive_access", implementationKey: "access.sensitive.request", publicToolName: "local_request_sensitive_access" }),
  brokerMethod({ method: "local_request_host_access", implementationKey: "access.host.request", publicToolName: "local_request_host_access" }),
  brokerMethod({ method: "local_stage_changes", implementationKey: "file-batch.stage", publicToolName: "local_stage_changes" }),
  brokerMethod({ method: "local_confirm_batch", implementationKey: "file-batch.confirm", publicToolName: "local_confirm_batch" }),
  brokerMethod({ method: "local_run_command", implementationKey: "command.run", publicToolName: "local_run_command" }),
  brokerMethod({ method: "host_approve_command", implementationKey: "command.approve", internal: true }),
]);

const toolByName = new Map();
for (const metadata of PUBLIC_TOOL_METADATA) {
  if (toolByName.has(metadata.name)) throw new Error(`duplicate canonical tool name: ${metadata.name}`);
  if (!metadata.name || !["always", "broker"].includes(metadata.availability)) throw new Error(`invalid canonical tool metadata: ${metadata.name}`);
  if (!metadata.timeoutClass || !metadata.capabilityCategory) throw new Error(`incomplete canonical tool metadata: ${metadata.name}`);
  toolByName.set(metadata.name, metadata);
}

const brokerMethodByName = new Map();
const brokerMethodByImplementation = new Map();
for (const metadata of BROKER_METHOD_METADATA) {
  if (brokerMethodByName.has(metadata.method)) throw new Error(`duplicate canonical broker method: ${metadata.method}`);
  if (brokerMethodByImplementation.has(metadata.implementationKey)) throw new Error(`duplicate canonical broker implementation: ${metadata.implementationKey}`);
  if (!metadata.method || !metadata.implementationKey) throw new Error("canonical broker method metadata is incomplete");
  brokerMethodByName.set(metadata.method, metadata);
  brokerMethodByImplementation.set(metadata.implementationKey, metadata);
}

for (const metadata of PUBLIC_TOOL_METADATA) {
  if (metadata.availability !== "broker") continue;
  const broker = brokerMethodByName.get(metadata.brokerMethod);
  if (!broker || broker.internal || broker.publicToolName !== metadata.name) {
    throw new Error(`canonical broker-backed tool is not bound correctly: ${metadata.name}`);
  }
}

function normalizedOptions(options) {
  return options && typeof options === "object" ? options : {};
}

function listToolMetadata(options = {}) {
  const { brokerEnabled = false } = normalizedOptions(options);
  return PUBLIC_TOOL_METADATA.filter((metadata) => metadata.availability === "always" || brokerEnabled);
}

function listToolNames(options = {}) {
  return listToolMetadata(options).map((metadata) => metadata.name);
}

function listGoalToolNames(options = {}) {
  return listToolMetadata(options).filter((metadata) => metadata.goalEligible).map((metadata) => metadata.name);
}

function listBrokerToolNames(options = {}) {
  const { brokerEnabled = false } = normalizedOptions(options);
  if (!brokerEnabled) return [];
  return PUBLIC_TOOL_METADATA.filter((metadata) => metadata.availability === "broker").map((metadata) => metadata.name);
}

function getToolMetadata(name) {
  return toolByName.get(name) ?? null;
}

function getBrokerMethodMetadata(method) {
  return brokerMethodByName.get(method) ?? null;
}

function findBrokerMethodByImplementation(implementationKey) {
  return brokerMethodByImplementation.get(implementationKey) ?? null;
}

function getMcpAnnotations(name) {
  return getToolMetadata(name)?.mcpAnnotations ?? EMPTY_ANNOTATIONS;
}

function classifyToolSideEffect({ tool, input } = {}) {
  const metadata = getToolMetadata(tool);
  if (!metadata) return Object.freeze({ sideEffecting: true, rule: "side-effecting-or-unknown-tool" });
  if (metadata.security.sideEffectMode === "never") {
    return Object.freeze({ sideEffecting: false, rule: metadata.security.readOnlyRule ?? "read-only-tool" });
  }
  if (metadata.security.sideEffectMode === "actions") {
    const value = input?.[metadata.security.actionField];
    if (metadata.security.readOnlyActions.includes(value)) {
      return Object.freeze({ sideEffecting: false, rule: metadata.security.readOnlyRule ?? "read-only-structured-action" });
    }
  }
  return Object.freeze({ sideEffecting: true, rule: "side-effecting-or-unknown-tool" });
}

module.exports = Object.freeze({
  TOOL_REGISTRY_VERSION,
  PUBLIC_TOOL_METADATA,
  BROKER_METHOD_METADATA,
  listToolMetadata,
  listToolNames,
  listGoalToolNames,
  listBrokerToolNames,
  getToolMetadata,
  getBrokerMethodMetadata,
  findBrokerMethodByImplementation,
  getMcpAnnotations,
  classifyToolSideEffect,
});
