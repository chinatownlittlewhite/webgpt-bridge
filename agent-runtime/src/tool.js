import * as core from "./tool-core.js";
import { createProductMetadata } from "./product-metadata.js";

export * from "./tool-core.js";

function safePublicText(value) {
  if (typeof value !== "string" || value.length > 1_024) return null;
  if (value.includes("/") || value.includes("\\") || value.includes("://")) return null;
  return value;
}

function publicGitHubCliState(value) {
  if (!value || typeof value !== "object") return value;
  return Object.freeze({
    status: typeof value.status === "string" ? value.status : "unknown",
    resolvedPath: null,
    version: typeof value.version === "string" ? value.version : null,
    reason: safePublicText(value.reason),
    remediation: safePublicText(value.remediation),
  });
}

function publicWindowsHostPreparationState(value) {
  if (!value || typeof value !== "object") return value;
  const result = {
    status: typeof value.status === "string" ? value.status : "unknown",
    usable: value.usable === true,
    capabilityName: safePublicText(value.capabilityName),
  };
  if (Object.hasOwn(value, "expectedPath")) result.expectedPath = null;
  if (typeof value.capabilitySid === "string") result.capabilitySid = safePublicText(value.capabilitySid);
  if (typeof value.target === "string") result.target = safePublicText(value.target);
  if (Number.isInteger(value.errorCode)) result.errorCode = value.errorCode;
  if (Object.hasOwn(value, "reason")) result.reason = safePublicText(value.reason);
  if (Object.hasOwn(value, "remediation")) result.remediation = safePublicText(value.remediation);
  return Object.freeze(result);
}

function decorateCapabilities(value, { brokerEnabled }) {
  const metadata = createProductMetadata({ brokerEnabled });
  return Object.freeze({
    ...value,
    ...metadata,
    version: metadata.agentVersion,
    githubCli: publicGitHubCliState(value.githubCli),
    windowsHostPreparation: publicWindowsHostPreparationState(value.windowsHostPreparation),
    mcp: Object.freeze({
      ...value.mcp,
      protocolRevision: metadata.mcpProtocolRevision,
    }),
    goalMode: Object.freeze({
      ...value.goalMode,
      supportedVerificationProfiles: Object.freeze([...metadata.supportedGoalVerificationProfiles]),
    }),
  });
}

function wrapCapabilitiesTool(tool, brokerEnabled) {
  return Object.freeze({
    ...tool,
    invoke(...args) {
      return decorateCapabilities(tool.invoke(...args), { brokerEnabled });
    },
  });
}

export function createCapabilitiesTool(options = {}) {
  const brokerEnabled = typeof options.localBrokerSocket === "string" && options.localBrokerSocket.length > 0;
  return wrapCapabilitiesTool(core.createCapabilitiesTool(options), brokerEnabled);
}

export function createCoreTools(options = {}) {
  const brokerEnabled = typeof options.localBrokerSocket === "string" && options.localBrokerSocket.length > 0;
  return core.createCoreTools(options).map((tool) => (
    tool.name === "get_capabilities" ? wrapCapabilitiesTool(tool, brokerEnabled) : tool
  ));
}
