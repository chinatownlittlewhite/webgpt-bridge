const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { readFileIdentity } = require("./file-identity.cjs");

const PROFILE_SCHEMA = 1;
const DEFAULT_RUNTIME_KEY_REF = "env:CONTROL_PLANE_API_KEY";

function profileError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function normalizeProfileName(value) {
  const profile = String(value || "").trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(profile)) {
    throw profileError("TUNNEL_PROFILE_INVALID", "Tunnel profile name must be a simple local profile name");
  }
  return profile;
}

function normalizeHealthListenAddr(value) {
  const address = String(value || "127.0.0.1:8080").trim();
  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(address);
  const port = match ? Number.parseInt(match[1], 10) : 0;
  if (!match || port < 1 || port > 65535) {
    throw profileError("TUNNEL_HEALTH_ADDRESS_INVALID", "Tunnel health listener must use a fixed 127.0.0.1 TCP port");
  }
  return address;
}

function normalizeRuntimeKeyRef(value) {
  const ref = String(value || DEFAULT_RUNTIME_KEY_REF).trim();
  if (!/^(?:env:[A-Za-z_][A-Za-z0-9_]*|file:.+)$/.test(ref)) {
    throw profileError("TUNNEL_RUNTIME_KEY_REF_INVALID", "Tunnel runtime key must be represented by an env: or file: reference");
  }
  return ref;
}

function fingerprintFor(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

async function isRegularFile(filename) {
  try {
    return (await fsp.lstat(filename)).isFile();
  } catch {
    return false;
  }
}

async function readMetadata(filename) {
  try {
    const parsed = JSON.parse(await fsp.readFile(filename, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function atomicWriteJson(filename, value) {
  const temp = `${filename}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    await fsp.rename(temp, filename);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function defaultRunInit({ clientPath, args, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || profileError("TUNNEL_PROFILE_INIT_ABORTED", "Tunnel profile initialization aborted"));
      return;
    }
    const child = spawn(clientPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => {
      child.kill?.();
      finish(signal.reason || profileError("TUNNEL_PROFILE_INIT_ABORTED", "Tunnel profile initialization aborted"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (chunk) => {
      if (stderr.length < 2048) stderr += String(chunk).slice(0, 2048 - stderr.length);
    });
    child.once?.("error", (error) => finish(profileError("TUNNEL_PROFILE_INIT_FAILED", "Unable to execute tunnel-client init", error)));
    child.once?.("close", (code) => {
      if (code === 0) finish();
      else finish(profileError("TUNNEL_PROFILE_INIT_FAILED", stderr.trim() || `tunnel-client init exited with code ${code}`));
    });
  });
}

function createTunnelProfileManager(deps = {}) {
  const runInit = typeof deps.runInit === "function" ? deps.runInit : defaultRunInit;
  const fileIdentity = typeof deps.fileIdentity === "function" ? deps.fileIdentity : readFileIdentity;

  async function ensure(input = {}) {
    const clientPath = String(input.clientPath || "").trim();
    const profileDir = path.resolve(String(input.profileDir || ""));
    const profile = normalizeProfileName(input.profile);
    const tunnelId = String(input.tunnelId || "").trim();
    const mcpServerUrl = String(input.mcpServerUrl || "").trim();
    const healthListenAddr = normalizeHealthListenAddr(input.healthListenAddr);
    const runtimeKeyRef = normalizeRuntimeKeyRef(input.runtimeKeyRef);
    if (!clientPath) throw profileError("TUNNEL_CLIENT_INVALID", "Tunnel client path is required");
    if (!input.profileDir || !path.isAbsolute(profileDir)) throw profileError("TUNNEL_PROFILE_DIR_INVALID", "Tunnel profile directory must be absolute");
    if (!tunnelId) throw profileError("TUNNEL_PROFILE_INVALID", "Tunnel ID is required");
    if (!mcpServerUrl) throw profileError("TUNNEL_PROFILE_INVALID", "MCP server URL is required");

    const identity = await fileIdentity(clientPath, { signal: input.signal });
    const clientIdentity = {
      path: identity.path,
      size: Number(identity.size),
      mtimeMs: Number(identity.mtimeMs),
      dev: Number(identity.dev),
      ino: Number(identity.ino),
    };
    const desired = Object.freeze({
      schema: PROFILE_SCHEMA,
      clientIdentity,
      profile,
      tunnelId,
      mcpServerUrl,
      healthListenAddr,
      runtimeKeyRef,
    });
    const fingerprint = fingerprintFor(desired);
    const profilePath = path.join(profileDir, `${profile}.yaml`);
    const metadataPath = path.join(profileDir, `.${profile}.webgpt-bridge.json`);
    const healthBaseUrl = `http://${healthListenAddr}`;

    await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
    const metadata = await readMetadata(metadataPath);
    if (metadata?.schema === PROFILE_SCHEMA && metadata?.fingerprint === fingerprint && await isRegularFile(profilePath)) {
      return Object.freeze({ profile, profileDir, healthBaseUrl, cacheHit: true, fingerprint });
    }

    const replacing = await isRegularFile(profilePath) || Boolean(metadata);
    const args = [
      "init",
      ...(replacing ? ["--force"] : []),
      "--profile", profile,
      "--profile-dir", profileDir,
      "--tunnel-id", tunnelId,
      "--mcp-server-url", mcpServerUrl,
      "--health-listen-addr", healthListenAddr,
      "--control-plane-api-key-ref", runtimeKeyRef,
    ];
    await runInit({ clientPath, args, signal: input.signal });
    if (!await isRegularFile(profilePath)) {
      throw profileError("TUNNEL_PROFILE_INIT_FAILED", "tunnel-client init did not publish the expected Host-owned profile");
    }
    await atomicWriteJson(metadataPath, {
      schema: PROFILE_SCHEMA,
      fingerprint,
      clientIdentity,
      profile,
      tunnelId,
      mcpServerUrl,
      healthListenAddr,
      runtimeKeyRef,
    });
    return Object.freeze({ profile, profileDir, healthBaseUrl, cacheHit: false, fingerprint });
  }

  return Object.freeze({ ensure });
}

const defaultManager = createTunnelProfileManager();

function ensureTunnelProfile(input) {
  return defaultManager.ensure(input);
}

module.exports = { createTunnelProfileManager, ensureTunnelProfile };
