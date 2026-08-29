import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const shared = require("../shared/product-metadata.cjs");

export const DESKTOP_VERSION = shared.DESKTOP_VERSION;
export const AGENT_VERSION = shared.AGENT_VERSION;
export const MCP_PROTOCOL_REVISION = shared.MCP_PROTOCOL_REVISION;
export const BROKER_PROTOCOL_VERSION = shared.BROKER_PROTOCOL_VERSION;
export const GOAL_STORE_VERSION = shared.GOAL_STORE_VERSION;
export const SUPPORTED_GOAL_VERIFICATION_PROFILES = shared.SUPPORTED_GOAL_VERIFICATION_PROFILES;
export const LEGACY_GOAL_VERIFICATION_PROFILE = shared.LEGACY_GOAL_VERIFICATION_PROFILE;
export const createProductMetadata = shared.createProductMetadata;
