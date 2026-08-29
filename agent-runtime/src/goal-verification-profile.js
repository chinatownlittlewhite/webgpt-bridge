import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyToolSideEffect } = require("../shared/tool-registry.cjs");

export const SUPPORTED_GOAL_VERIFICATION_PROFILES = Object.freeze([
  "code-change",
  "read-only-audit",
  "system-operation",
]);

export const LEGACY_GOAL_VERIFICATION_PROFILE = "legacy-code-project";

export function normalizeGoalVerificationProfile(value) {
  if (value === undefined) return LEGACY_GOAL_VERIFICATION_PROFILE;
  if (SUPPORTED_GOAL_VERIFICATION_PROFILES.includes(value)) return value;
  throw new TypeError(`unsupported goal verification profile: ${String(value)}`);
}

export function classifyGoalAction(action = {}) {
  return classifyToolSideEffect(action);
}
