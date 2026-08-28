const path = require("node:path");

const DEFAULT_MCP_PORT = 8787;
const DEFAULT_TUNNEL_HEALTH_PORT = 8080;

function resolveDevelopmentPort(env, key, fallback) {
  const raw = typeof env?.[key] === "string" ? env[key].trim() : "";
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer from 1 to 65535.`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${key} must be an integer from 1 to 65535.`);
  }
  return port;
}

function resolveDevelopmentRuntimeConfig({ isPackaged, env = {}, defaultUserDataPath }) {
  const defaults = {
    userDataPath: defaultUserDataPath,
    mcpPort: DEFAULT_MCP_PORT,
    tunnelHealthPort: DEFAULT_TUNNEL_HEALTH_PORT,
  };
  if (isPackaged) return Object.freeze(defaults);

  const userDataOverride = typeof env.WEBGPT_DEV_USER_DATA_DIR === "string"
    ? env.WEBGPT_DEV_USER_DATA_DIR.trim()
    : "";
  if (userDataOverride && !path.isAbsolute(userDataOverride)) {
    throw new Error("WEBGPT_DEV_USER_DATA_DIR must be an absolute path.");
  }

  return Object.freeze({
    userDataPath: userDataOverride || defaultUserDataPath,
    mcpPort: resolveDevelopmentPort(env, "WEBGPT_DEV_MCP_PORT", DEFAULT_MCP_PORT),
    tunnelHealthPort: resolveDevelopmentPort(env, "WEBGPT_DEV_TUNNEL_HEALTH_PORT", DEFAULT_TUNNEL_HEALTH_PORT),
  });
}

module.exports = { resolveDevelopmentRuntimeConfig };
