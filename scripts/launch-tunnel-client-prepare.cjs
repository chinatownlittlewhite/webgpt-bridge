const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveSystemProxyEnvironment } = require("../src/system-proxy.cjs");

const supportedTargets = new Set(["darwin-universal", "darwin-arm64", "darwin-x64", "windows-amd64"]);
const prepareScript = path.join(__dirname, "prepare-tunnel-client.cjs");

function hasHttpsProxy(env) {
  return Boolean(env?.HTTPS_PROXY || env?.https_proxy);
}

function resolvePrepareEnvironment({
  platform = process.platform,
  env = process.env,
  resolveSystemProxy = resolveSystemProxyEnvironment,
} = {}) {
  const inherited = { ...env };
  if (platform !== "darwin" || hasHttpsProxy(inherited)) return inherited;
  const systemProxy = resolveSystemProxy({ platform });
  return { ...systemProxy, ...inherited };
}

function buildPrepareNodeArgs(target) {
  if (!supportedTargets.has(target)) throw new Error(`Unsupported tunnel-client target: ${target || "(missing)"}`);
  return ["--use-env-proxy", prepareScript, target];
}

function launch(target) {
  const result = spawnSync(process.execPath, buildPrepareNodeArgs(target), {
    cwd: path.resolve(__dirname, ".."),
    env: resolvePrepareEnvironment(),
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`tunnel-client prepare terminated by ${result.signal}`);
    process.exit(1);
  }
  process.exit(Number.isInteger(result.status) ? result.status : 1);
}

if (require.main === module) {
  try {
    launch(process.argv[2]);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

module.exports = { buildPrepareNodeArgs, resolvePrepareEnvironment };
