"use strict";

const contract = require("./product-contract.cjs");
const registry = require("./tool-registry.cjs");

function freezeList(values) {
  return Object.freeze([...values]);
}

function createProductMetadata({ brokerEnabled = false } = {}) {
  const enabled = brokerEnabled === true;
  return Object.freeze({
    desktopVersion: contract.DESKTOP_VERSION,
    agentVersion: contract.AGENT_VERSION,
    mcpProtocolRevision: contract.MCP_PROTOCOL_REVISION,
    brokerProtocolVersion: contract.BROKER_PROTOCOL_VERSION,
    goalStoreVersion: contract.GOAL_STORE_VERSION,
    supportedGoalVerificationProfiles: freezeList(contract.SUPPORTED_GOAL_VERIFICATION_PROFILES),
    tools: freezeList(registry.listToolNames({ brokerEnabled: enabled })),
    goalTools: freezeList(registry.listGoalToolNames({ brokerEnabled: enabled })),
    brokerTools: freezeList(registry.listBrokerToolNames({ brokerEnabled: enabled })),
  });
}

module.exports = Object.freeze({
  ...contract,
  createProductMetadata,
});
