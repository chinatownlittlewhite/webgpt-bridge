const { execFile } = require("node:child_process");
const { defaultTcpProbe } = require("./loopback-health-probe.cjs");

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function validateTimeout(timeoutMs) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new TypeError("GitHub health timeout must be an integer between 1 and 30000 ms");
  }
}

function probeAuthentication(execFileImpl, githubCliPath, timeoutMs) {
  return new Promise((resolve) => {
    execFileImpl(githubCliPath, ["auth", "status"], {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
    }, (error) => {
      const executableMissing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
      resolve(Object.freeze({
        binaryReady: !executableMissing,
        authenticated: !error,
      }));
    });
  });
}

function createGitHubHealthProbe({
  tcpProbe = defaultTcpProbe,
  execFileImpl = execFile,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof tcpProbe !== "function") throw new TypeError("tcpProbe must be a function");
  if (typeof execFileImpl !== "function") throw new TypeError("execFileImpl must be a function");
  validateTimeout(timeoutMs);

  return async function probe({ githubCliPath = "" } = {}) {
    const connectivityPromise = tcpProbe({ host: "github.com", port: 443 });
    const authPromise = githubCliPath
      ? probeAuthentication(execFileImpl, githubCliPath, timeoutMs)
      : Promise.resolve(Object.freeze({ binaryReady: false, authenticated: false }));
    const [connectivityResult, auth] = await Promise.all([connectivityPromise, authPromise]);
    const connectivity = connectivityResult?.ok === true;
    return Object.freeze({
      ok: connectivity && auth.authenticated,
      connectivity,
      binaryReady: auth.binaryReady,
      authenticated: auth.authenticated,
    });
  };
}

module.exports = {
  createGitHubHealthProbe,
};
