import { createHash } from "node:crypto";

function stablePolicy(policy) {
  return {
    decision: policy?.decision ?? null,
    rule: policy?.rule ?? null,
    baseRule: policy?.baseRule ?? null,
    reason: policy?.reason ?? null,
  };
}

function stableEnv(env = {}) {
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

function stablePaths(paths = []) {
  if (!Array.isArray(paths)) throw new TypeError("approval sandbox access paths must be arrays");
  const values = paths.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      throw new TypeError("approval sandbox access paths must be non-empty strings without NUL bytes");
    }
    return entry;
  });
  return [...new Set(values)].sort();
}

export function createApprovalRequest({
  argv,
  resolvedArgv = argv,
  platform = process.platform,
  cwd,
  env = {},
  policy,
  sandbox,
  sandboxAccess = {},
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError("approval argv must be a non-empty array");
  }
  if (!Array.isArray(resolvedArgv) || resolvedArgv.length === 0) {
    throw new TypeError("approval resolvedArgv must be a non-empty array");
  }
  const payload = {
    argv: [...argv],
    resolvedArgv: [...resolvedArgv],
    platform,
    cwd,
    env: stableEnv(env),
    policy: stablePolicy(policy),
    sandbox: {
      name: sandbox?.name ?? null,
      enforced: sandbox?.enforced === true,
      autoRunSafe: sandbox?.autoRunSafe === true,
      verificationId: sandbox?.verificationId ?? null,
    },
    sandboxAccess: {
      read: stablePaths(sandboxAccess.read),
      write: stablePaths(sandboxAccess.write),
    },
  };
  const id = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return Object.freeze({
    id,
    argv: Object.freeze([...payload.argv]),
    resolvedArgv: Object.freeze([...payload.resolvedArgv]),
    platform: payload.platform,
    cwd: payload.cwd,
    env: Object.freeze({ ...payload.env }),
    policy: Object.freeze(payload.policy),
    sandbox: Object.freeze(payload.sandbox),
    sandboxAccess: Object.freeze({
      read: Object.freeze([...payload.sandboxAccess.read]),
      write: Object.freeze([...payload.sandboxAccess.write]),
    }),
  });
}

export async function requestHostApproval(requestApproval, request) {
  if (typeof requestApproval !== "function") {
    return { status: "missing", approved: false };
  }
  try {
    const approved = (await requestApproval(request)) === true;
    return { status: approved ? "approved" : "denied", approved };
  } catch (error) {
    return {
      status: "error",
      approved: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
