const fs = require("node:fs");
const path = require("node:path");
const { validateDevelopmentRuntime } = require("./host-config.cjs");
const { resolveDesktopGitHubCli } = require("./github-cli-path.cjs");
const { resolveNodeRuntime } = require("./node-runtime-resolver.cjs");
const { resolveTunnelClientPath } = require("./tunnel-client-path.cjs");
const { ensureTunnelProfile } = require("./tunnel-profile-manager.cjs");

const PROFILE_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

function existingDirectory(candidate) {
  return Boolean(candidate && path.isAbsolute(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory());
}

function existingFile(candidate) {
  return Boolean(candidate && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

function freezeRecord(value) {
  return Object.freeze({ ...(value || {}) });
}

function createStartupPreflight(deps = {}) {
  const validateRuntime = typeof deps.validateRuntime === "function" ? deps.validateRuntime : validateDevelopmentRuntime;
  const isDirectory = typeof deps.isDirectory === "function" ? deps.isDirectory : existingDirectory;
  const isFile = typeof deps.isFile === "function" ? deps.isFile : existingFile;
  const resolveTunnelClient = typeof deps.resolveTunnelClient === "function" ? deps.resolveTunnelClient : resolveTunnelClientPath;
  const resolveNode = typeof deps.resolveNodeRuntime === "function" ? deps.resolveNodeRuntime : resolveNodeRuntime;
  const ensureProfile = typeof deps.ensureTunnelProfile === "function" ? deps.ensureTunnelProfile : ensureTunnelProfile;
  const readRuntimeKey = typeof deps.readRuntimeKey === "function"
    ? deps.readRuntimeKey
    : async (input) => String(input?.runtimeKey || "");
  const resolveGitHubCli = typeof deps.resolveDesktopGitHubCli === "function" ? deps.resolveDesktopGitHubCli : resolveDesktopGitHubCli;

  function valueOf(value, input) {
    return typeof value === "function" ? value(input) : value;
  }

  async function prepare(input = {}) {
    const settings = input.settings;
    if (!settings || typeof settings !== "object") throw new Error("启动设置无效。");

    const runtime = validateRuntime(settings);
    if (!isDirectory(runtime.workspacePath)) throw new Error("工作区必须是存在的绝对目录。");
    if (!isDirectory(runtime.runtimePath)) throw new Error("Agent 运行时目录必须是存在的绝对目录。");
    if (!isFile(path.join(runtime.runtimePath, "dist", "server.js"))) {
      throw new Error("Agent 运行时目录中未找到 dist/server.js；请先在该项目运行 npm install 和 npm run build。");
    }

    const bundledTunnelPath = String(valueOf(deps.bundledTunnelClientPath, input) || input.bundledTunnelClientPath || "").trim();
    const tunnelClient = resolveTunnelClient({
      customPath: settings.tunnelClientPath,
      bundledPath: bundledTunnelPath,
      isFile,
    });
    if (!tunnelClient) {
      throw new Error("未找到应用内置的 OpenAI tunnel-client。请重新安装应用，或在高级设置中选择自定义 tunnel-client。");
    }
    if (!String(settings.tunnelId || "").startsWith("tunnel_")) throw new Error("Tunnel ID 应以 tunnel_ 开头。");
    if (!PROFILE_PATTERN.test(String(settings.profile || ""))) throw new Error("配置名称只能包含字母、数字、点、下划线和连字符。");

    const bundledManifest = valueOf(deps.bundledNodeManifest, input) || input.bundledManifest || null;
    const nodeRuntime = await resolveNode({
      settings,
      env: input.env || process.env,
      bundledManifest,
      signal: input.signal,
      platform: input.platform,
      nvmCandidates: input.nvmCandidates,
    });

    const runtimeKey = String(await readRuntimeKey({ settings, signal: input.signal, runtimeKey: input.runtimeKey }) || "");
    if (!runtimeKey) throw new Error("请先保存此电脑专用的 OpenAI Tunnel 运行时密钥。");

    const tunnelProfile = await ensureProfile({
      clientPath: tunnelClient,
      profileDir: String(valueOf(deps.tunnelProfileDir, input) || input.tunnelProfileDir || "").trim(),
      profile: settings.profile,
      tunnelId: settings.tunnelId,
      mcpServerUrl: String(valueOf(deps.mcpServerUrl, input) || input.mcpServerUrl || "").trim(),
      healthListenAddr: String(valueOf(deps.tunnelHealthListenAddr, input) || input.tunnelHealthListenAddr || "127.0.0.1:8080").trim(),
      runtimeKeyRef: "env:CONTROL_PLANE_API_KEY",
      signal: input.signal,
    });

    const appToolsBin = String(valueOf(deps.appToolsBin, input) || input.appToolsBin || "");
    const githubCliPath = resolveGitHubCli({ appToolsBin });

    return Object.freeze({
      settings: freezeRecord(settings),
      node: nodeRuntime.path,
      nodeRuntime,
      runtime: freezeRecord(runtime),
      tunnelClient,
      tunnelProfile,
      runtimeKey,
      appToolsBin,
      githubCliPath,
    });
  }

  return Object.freeze({ prepare });
}

const defaultPreflight = createStartupPreflight();

function prepareStartup(input) {
  return defaultPreflight.prepare(input);
}

module.exports = { createStartupPreflight, prepareStartup };
