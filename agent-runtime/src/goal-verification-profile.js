import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyToolSideEffect } = require("../shared/tool-registry.cjs");
const productContract = require("../shared/product-contract.cjs");

export const SUPPORTED_GOAL_VERIFICATION_PROFILES = productContract.SUPPORTED_GOAL_VERIFICATION_PROFILES;
export const LEGACY_GOAL_VERIFICATION_PROFILE = productContract.LEGACY_GOAL_VERIFICATION_PROFILE;

export function normalizeGoalVerificationProfile(value) {
  if (value === undefined) return LEGACY_GOAL_VERIFICATION_PROFILE;
  if (SUPPORTED_GOAL_VERIFICATION_PROFILES.includes(value)) return value;
  throw new TypeError(`unsupported goal verification profile: ${String(value)}`);
}

export function classifyGoalAction(action = {}) {
  return classifyToolSideEffect(action);
}
