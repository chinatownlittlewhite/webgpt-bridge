const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createReadStream } = require("node:fs");
const { preferredNodeCandidates } = require("./host-path.cjs");
const { fileIdentityKey, readFileIdentity } = require("./file-identity.cjs");

function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version || "").trim());
  return match ? Number.parseInt(match[1], 10) : 0;
}

function runtimeError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function probeNodeVersion(candidate, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : 4000;
  const signal = options.signal;
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : spawn;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || runtimeError("NODE_VERSION_PROBE_ABORTED", "Node version probe aborted"));
      return;
    }

    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawnImpl(candidate, ["--version"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      child.kill?.();
      finish(signal.reason || runtimeError("NODE_VERSION_PROBE_ABORTED", "Node version probe aborted"));
    };
    const timer = setTimeout(() => {
      child.kill?.();
      finish(runtimeError("NODE_VERSION_PROBE_TIMEOUT", `Node version probe exceeded ${timeoutMs}ms`));
    }, timeoutMs);

    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on?.("data", (chunk) => { if (stdout.length < 256) stdout += String(chunk).slice(0, 256 - stdout.length); });
    child.stderr?.on?.("data", (chunk) => { if (stderr.length < 256) stderr += String(chunk).slice(0, 256 - stderr.length); });
    child.once?.("error", (error) => finish(runtimeError("NODE_VERSION_PROBE_FAILED", `Unable to execute Node candidate: ${candidate}`, error)));
    child.once?.("close", (code) => {
      if (code !== 0) {
        finish(runtimeError("NODE_VERSION_PROBE_FAILED", stderr.trim() || `Node candidate exited with code ${code}`));
        return;
      }
      finish(null, stdout.trim());
    });
  });
}

function hashFileSha256(candidate, options = {}) {
  const signal = options.signal;
  const createStream = typeof options.createReadStream === "function" ? options.createReadStream : createReadStream;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || runtimeError("NODE_MANIFEST_VERIFY_ABORTED", "Bundled Node verification aborted"));
      return;
    }

    const hash = createHash("sha256");
    const stream = createStream(candidate);
    let settled = false;
    const cleanup = () => signal?.removeEventListener?.("abort", onAbort);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      const error = signal.reason || runtimeError("NODE_MANIFEST_VERIFY_ABORTED", "Bundled Node verification aborted");
      stream.destroy?.(error);
      finish(error);
    };

    signal?.addEventListener?.("abort", onAbort, { once: true });
    stream.on?.("data", (chunk) => hash.update(chunk));
    stream.once?.("error", (error) => finish(error));
    stream.once?.("end", () => finish(null, hash.digest("hex")));
  });
}

function candidateSource(candidate, { configuredPath, lpcNodePath, bundledPath }) {
  if (configuredPath && candidate === configuredPath) return "settings";
  if (lpcNodePath && candidate === lpcNodePath) return "env";
  if (bundledPath && candidate === bundledPath) return "bundled";
  return candidate === "node" ? "path" : "discovery";
}

function sameIdentity(left, right) {
  return fileIdentityKey(left) !== "" && fileIdentityKey(left) === fileIdentityKey(right);
}

function createNodeRuntimeResolver(deps = {}) {
  const preferredCandidates = typeof deps.preferredCandidates === "function"
    ? deps.preferredCandidates
    : preferredNodeCandidates;
  const fileIdentity = typeof deps.fileIdentity === "function" ? deps.fileIdentity : readFileIdentity;
  const probeVersion = typeof deps.probeVersion === "function" ? deps.probeVersion : probeNodeVersion;
  const hashFile = typeof deps.hashFile === "function" ? deps.hashFile : hashFileSha256;
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(1, deps.timeoutMs) : 4000;
  const cache = new Map();

  async function resolve(input = {}) {
    const settings = input.settings || {};
    const env = input.env || process.env;
    const configuredPath = String(settings.nodePath || "").trim();
    const lpcNodePath = String(env.LPC_NODE_PATH || "").trim();
    const bundledManifest = input.bundledManifest && typeof input.bundledManifest === "object" ? input.bundledManifest : null;
    const bundledPath = String(bundledManifest?.path || "").trim();
    const candidates = [...new Set(preferredCandidates({
      settingsNodePath: configuredPath,
      lpcNodePath,
      bundledNodePath: bundledPath,
      platform: input.platform || process.platform,
      env,
      nvmCandidates: input.nvmCandidates || [],
    }).filter(Boolean))];

    for (const candidate of candidates) {
      const source = candidateSource(candidate, { configuredPath, lpcNodePath, bundledPath });
      const explicit = source === "settings";
      let identity;
      try {
        identity = await fileIdentity(candidate, { signal: input.signal });
      } catch (error) {
        if (explicit) throw runtimeError("NODE_CONFIGURED_RUNTIME_INVALID", `Configured Node runtime is invalid: ${candidate}`, error);
        continue;
      }
      const frozenIdentity = Object.isFrozen(identity) ? identity : Object.freeze({ ...identity });
      const identityKey = fileIdentityKey(frozenIdentity);
      const cached = identityKey ? cache.get(identityKey) : null;
      if (cached) return cached;

      let version = "";
      const manifestMatchesCandidate = Boolean(bundledPath && candidate === bundledPath && bundledManifest?.version);
      if (manifestMatchesCandidate && sameIdentity(frozenIdentity, bundledManifest.identity)) {
        version = String(bundledManifest.version).trim();
      } else if (manifestMatchesCandidate && String(bundledManifest.nodeSha256 || "").trim()) {
        try {
          const expectedDigest = String(bundledManifest.nodeSha256).trim().toLowerCase();
          const actualDigest = String(await hashFile(candidate, { signal: input.signal })).trim().toLowerCase();
          if (!actualDigest || actualDigest !== expectedDigest) {
            throw runtimeError("NODE_BUNDLED_RUNTIME_DIGEST_MISMATCH", `Bundled Node runtime digest mismatch: ${candidate}`);
          }
          version = String(bundledManifest.version).trim();
        } catch (error) {
          if (explicit) throw runtimeError("NODE_CONFIGURED_RUNTIME_INVALID", `Configured Node runtime could not be verified: ${candidate}`, error);
          continue;
        }
      } else {
        try {
          version = String(await probeVersion(candidate, { signal: input.signal, timeoutMs })).trim();
        } catch (error) {
          if (explicit) throw runtimeError("NODE_CONFIGURED_RUNTIME_INVALID", `Configured Node runtime could not be verified: ${candidate}`, error);
          continue;
        }
      }

      if (nodeMajor(version) < 20) {
        if (explicit) throw runtimeError("NODE_CONFIGURED_RUNTIME_INVALID", `Configured Node runtime must be Node.js 20 or newer: ${candidate}`);
        continue;
      }

      const result = Object.freeze({ path: candidate, version, identity: frozenIdentity, source });
      if (identityKey) cache.set(identityKey, result);
      return result;
    }

    throw runtimeError("NODE_DISCOVERY_FAILED", "No supported Node.js runtime could be resolved");
  }

  return Object.freeze({ resolve });
}

const defaultResolver = createNodeRuntimeResolver();

function resolveNodeRuntime(input) {
  return defaultResolver.resolve(input);
}

module.exports = { createNodeRuntimeResolver, hashFileSha256, probeNodeVersion, resolveNodeRuntime };
