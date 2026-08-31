const { spawnSync: defaultSpawnSync } = require("node:child_process");
const { resolveDesktopGitHubCli: defaultResolveDesktopGitHubCli } = require("../github-cli-path.cjs");

const STATUS_RANK = Object.freeze({ ready: 0, degraded: 1, unavailable: 2 });

function boundedService({ status = "degraded", code = "UNKNOWN", message = "Service state unavailable", action } = {}) {
  const result = {
    status: STATUS_RANK[status] === undefined ? "degraded" : status,
    code: String(code || "UNKNOWN").slice(0, 64),
    message: String(message || "Service state unavailable").slice(0, 240),
  };
  if (action && typeof action === "object") {
    const id = String(action.id || "").slice(0, 64);
    const label = String(action.label || "").slice(0, 120);
    if (id && label) result.action = Object.freeze({ id, label });
  }
  return Object.freeze(result);
}

function classifyGithubDiagnostic({ available = false, authenticated, upstreamOk } = {}) {
  if (!available) {
    return boundedService({
      status: "unavailable",
      code: "CLI_UNAVAILABLE",
      message: "GitHub CLI is unavailable on this computer.",
      action: { id: "install-github-cli", label: "Install GitHub CLI" },
    });
  }
  if (authenticated !== true) {
    return boundedService({
      status: "degraded",
      code: "NOT_AUTHENTICATED",
      message: "GitHub CLI is installed but not authenticated.",
      action: { id: "authenticate-github", label: "Authenticate GitHub CLI" },
    });
  }
  if (upstreamOk === false) {
    return boundedService({
      status: "degraded",
      code: "UPSTREAM_ERROR",
      message: "GitHub is authenticated but the upstream health check did not succeed.",
      action: { id: "retry-github", label: "Retry GitHub check" },
    });
  }
  return boundedService({ status: "ready", code: "READY", message: "GitHub CLI is ready." });
}

function classifyMcpDiagnostic({ connected = false, agentHealth = "unknown" } = {}) {
  if (!connected) {
    return boundedService({ status: "degraded", code: "STOPPED", message: "Local MCP is not connected." });
  }
  if (agentHealth === "ready") {
    return boundedService({ status: "ready", code: "READY", message: "Local MCP is ready." });
  }
  return boundedService({ status: "degraded", code: "HEALTH_DEGRADED", message: "Local MCP health is degraded." });
}

function sanitizePolicy(policy = {}) {
  const result = {};
  if (typeof policy.sandbox === "string") result.sandbox = policy.sandbox.slice(0, 64);
  if (typeof policy.approval === "string") result.approval = policy.approval.slice(0, 64);
  return Object.freeze(result);
}

function aggregateCapabilities({ policy = {}, services = {} } = {}) {
  const boundedServices = {};
  for (const [name, value] of Object.entries(services)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) continue;
    boundedServices[name] = boundedService(value);
  }
  const rank = Object.values(boundedServices).reduce(
    (maximum, service) => Math.max(maximum, STATUS_RANK[service.status] ?? STATUS_RANK.degraded),
    STATUS_RANK.ready,
  );
  const status = Object.keys(STATUS_RANK).find((key) => STATUS_RANK[key] === rank) || "degraded";
  return Object.freeze({ status, policy: sanitizePolicy(policy), services: Object.freeze(boundedServices) });
}

function probeGithubSync({
  platform = process.platform,
  env = process.env,
  spawnSync = defaultSpawnSync,
  resolveDesktopGitHubCli = defaultResolveDesktopGitHubCli,
  timeoutMs = 1500,
} = {}) {
  const cliPath = resolveDesktopGitHubCli({ platform, env });
  if (!cliPath) return { available: false, authenticated: false, upstreamOk: false };

  const options = {
    env: { ...env, GH_PAGER: "cat", PAGER: "cat" },
    stdio: "ignore",
    windowsHide: true,
    timeout: timeoutMs,
  };
  try {
    const auth = spawnSync(cliPath, ["auth", "status", "--hostname", "github.com"], options);
    if (auth?.error || auth?.status !== 0) return { available: true, authenticated: false, upstreamOk: false };
    const upstream = spawnSync(cliPath, ["api", "/rate_limit", "--silent"], options);
    return { available: true, authenticated: true, upstreamOk: !upstream?.error && upstream?.status === 0 };
  } catch {
    return { available: true, authenticated: true, upstreamOk: false };
  }
}

function createCapabilitiesService({
  getStatus = () => ({}),
  policy = Object.freeze({ sandbox: "default-deny", approval: "host-owned" }),
  probeGithub = () => probeGithubSync(),
} = {}) {
  if (typeof getStatus !== "function") throw new TypeError("getStatus must be a function");
  if (typeof probeGithub !== "function") throw new TypeError("probeGithub must be a function");

  async function capabilities() {
    let githubState;
    try {
      githubState = await probeGithub();
    } catch {
      githubState = { available: true, authenticated: true, upstreamOk: false };
    }
    const status = getStatus() || {};
    return aggregateCapabilities({
      policy,
      services: {
        github: classifyGithubDiagnostic(githubState),
        mcp: classifyMcpDiagnostic({ connected: status.connected === true, agentHealth: status.agentHealth }),
      },
    });
  }

  return Object.freeze({ capabilities });
}

module.exports = {
  aggregateCapabilities,
  boundedService,
  classifyGithubDiagnostic,
  classifyMcpDiagnostic,
  createCapabilitiesService,
  probeGithubSync,
};
