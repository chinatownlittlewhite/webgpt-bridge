const { spawnSync: defaultSpawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createBrokerChallenge, verifyBrokerProof } = require("../../shared/local-broker-protocol.cjs");
const { getBrokerMethodMetadata } = require("../../shared/tool-registry.cjs");
const { classifyLocalAction, classifyLocalPath } = require("../local-policy.cjs");
const { createLocalFileBroker } = require("../local-file-broker.cjs");
const { createHostCapabilityStore } = require("../host-capability-store.cjs");
const { createKnownFolderAccess } = require("../known-folder-access.cjs");
const { createLoopbackHealthProbe, defaultTcpProbe } = require("../loopback-health-probe.cjs");
const { createLocalTerminalBroker } = require("../local-terminal-broker.cjs");
const { validateSshCommand } = require("../ssh-policy.cjs");

function createHostBrokerServer({
  app,
  hostSecurity,
  appendLog = () => {},
  endpoints = {},
  platform = process.platform,
  pid = process.pid,
  spawnSync = defaultSpawnSync,
} = {}) {
  if (!app || typeof app.getPath !== "function") throw new TypeError("app.getPath is required");
  if (!hostSecurity || typeof hostSecurity.confirmLocalOperation !== "function" || typeof hostSecurity.confirmHostCommandApproval !== "function") {
    throw new TypeError("hostSecurity is required");
  }
  if (typeof appendLog !== "function") throw new TypeError("appendLog is required");

  const mcpHost = endpoints.mcpHost || "127.0.0.1";
  const mcpPort = endpoints.mcpPort;
  const tunnelHealthHost = endpoints.tunnelHealthHost || "127.0.0.1";
  const tunnelHealthPort = endpoints.tunnelHealthPort;

  let server;
  let socketPath = "";
  let fileBroker;
  let capabilityStore;
  let knownFolderAccess;
  let healthProbe;
  let terminalBroker;

  function localBrokerSocketPath() {
    if (platform === "win32") return `\\\\.\\pipe\\webgpt-bridge-${pid}`;
    return path.join(app.getPath("temp"), `webgpt-bridge-${pid}.sock`);
  }

  function getSocketPath() {
    return socketPath || localBrokerSocketPath();
  }

  async function stop() {
    hostSecurity.clearApprovals?.();
    const currentServer = server;
    const currentSocketPath = socketPath;
    server = undefined;
    socketPath = "";
    capabilityStore?.clear();
    capabilityStore = undefined;
    fileBroker = undefined;
    knownFolderAccess = undefined;
    healthProbe = undefined;
    terminalBroker = undefined;
    if (currentServer) await new Promise((resolve) => currentServer.close(() => resolve()));
    if (currentSocketPath && platform !== "win32") await fsp.rm(currentSocketPath, { force: true }).catch(() => {});
  }

  function dispatch(method, params, executionContext = {}) {
    const implementations = {
      "file.list": () => fileBroker.list(params),
      "file.read": () => fileBroker.read(params),
      "known-folder.list": () => knownFolderAccess.list(params),
      "known-folder.read": () => knownFolderAccess.read(params),
      "health.probe": () => healthProbe.probe(params),
      "access.sensitive.request": () => fileBroker.requestSensitiveAccess(params),
      "access.host.request": () => fileBroker.requestHostAccess(params),
      "file-batch.stage": () => fileBroker.stage(params),
      "file-batch.confirm": () => fileBroker.confirmBatch(params),
      "command.run": () => terminalBroker.run(params, executionContext),
      "command.approve": () => hostSecurity.confirmHostCommandApproval(params),
    };
    const metadata = getBrokerMethodMetadata(method);
    if (!metadata) throw new Error("未知的本机代理方法。");
    const handler = implementations[metadata.implementationKey];
    if (typeof handler !== "function") throw new Error("本机代理方法未配置。");
    return handler();
  }

  function attachConnection(socket, brokerBootstrap) {
    let buffered = "";
    let handshakeState = "awaiting_hello";
    let hello = null;
    let challengeNonce = "";
    const activeRequests = new Set();

    function rejectHandshake(code) {
      const safeCode = code === "BROKER_PROTOCOL_MISMATCH" ? code : "BROKER_AUTH_FAILED";
      appendLog("local-broker", `broker-handshake: ${safeCode}`);
      if (!socket.destroyed) socket.end(`${JSON.stringify({ type: "hello_error", code: safeCode })}\n`);
      handshakeState = "failed";
      hello = null;
      challengeNonce = "";
    }

    socket.setEncoding("utf8");
    socket.on("close", () => {
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
      hello = null;
      challengeNonce = "";
    });
    socket.on("data", (chunk) => {
      buffered += chunk;
      if (buffered.length > 1024 * 1024) return socket.destroy();
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim() || handshakeState === "failed") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          if (handshakeState !== "ready") rejectHandshake("BROKER_AUTH_FAILED");
          else if (!socket.destroyed) socket.write(`${JSON.stringify({ id: null, ok: false, error: "本机代理请求格式无效。" })}\n`);
          continue;
        }

        if (handshakeState === "awaiting_hello") {
          if (!message || message.type !== "hello") {
            rejectHandshake("BROKER_AUTH_FAILED");
            continue;
          }
          const challenge = createBrokerChallenge(message, brokerBootstrap);
          if (challenge.type === "hello_error") {
            rejectHandshake(challenge.code);
            continue;
          }
          hello = Object.freeze({
            protocolVersion: message.protocolVersion,
            sessionId: message.sessionId,
            agentVersion: message.agentVersion,
          });
          challengeNonce = challenge.nonce;
          handshakeState = "awaiting_proof";
          socket.write(`${JSON.stringify(challenge)}\n`);
          continue;
        }

        if (handshakeState === "awaiting_proof") {
          if (!message || message.type !== "authenticate" || !hello || message.protocolVersion !== hello.protocolVersion || message.sessionId !== hello.sessionId || message.agentVersion !== hello.agentVersion || message.nonce !== challengeNonce) {
            rejectHandshake("BROKER_AUTH_FAILED");
            continue;
          }
          const verification = verifyBrokerProof(message, brokerBootstrap, { expectedNonce: challengeNonce });
          if (!verification.ok) {
            rejectHandshake(verification.code);
            continue;
          }
          handshakeState = "ready";
          hello = null;
          challengeNonce = "";
          appendLog("local-broker", "broker-handshake: accepted");
          socket.write(`${JSON.stringify({ type: "hello_ok" })}\n`);
          continue;
        }

        if (handshakeState !== "ready") continue;
        void (async () => {
          try {
            if (!message || typeof message !== "object" || typeof message.method !== "string" || !message.params || typeof message.params !== "object") throw new Error("本机代理请求格式无效。");
            const controller = new AbortController();
            activeRequests.add(controller);
            try {
              const result = await dispatch(message.method, message.params, { signal: controller.signal });
              if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message.id, ok: true, result })}\n`);
            } finally {
              activeRequests.delete(controller);
            }
          } catch (error) {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message?.id, ok: false, error: error.message || "本机代理请求失败。" })}\n`);
          }
        })();
      }
    });
  }

  async function start(settings, runtime, { githubCliPath = "", proxyEnv = {}, brokerBootstrap } = {}) {
    await stop();
    hostSecurity.setApprovalMode(settings.approvalMode);
    const knownFolderRoots = {
      desktop: app.getPath("desktop"),
      downloads: app.getPath("downloads"),
      documents: app.getPath("documents"),
    };
    const policyOptions = {
      appDataRoots: [app.getPath("userData")],
      workspaceRoot: settings.workspacePath,
      knownFolderRoots,
    };
    const pathPolicy = (target, options) => classifyLocalPath(target, { ...policyOptions, ...options, approvalMode: settings.approvalMode });
    const actionPolicy = (action) => classifyLocalAction({ ...action, approvalMode: settings.approvalMode });
    const policyModule = await import(pathToFileURL(path.join(runtime.runtimePath, "dist", "policy.js")).href);
    capabilityStore = createHostCapabilityStore({ generation: crypto.randomUUID(), policyVersion: "v0.5-phase1" });
    fileBroker = createLocalFileBroker({
      workspaceRoot: settings.workspacePath,
      transactionRegistryPath: path.join(app.getPath("userData"), "local-file-transactions.json"),
      capabilityStore,
      policy: pathPolicy,
      actionPolicy,
      confirm: hostSecurity.confirmLocalOperation,
      audit: (entry) => appendLog("local-broker", `${entry.action}：${entry.result}`),
    });
    knownFolderAccess = createKnownFolderAccess({
      roots: knownFolderRoots,
      fileBroker,
      issueCapability: async (request) => {
        const classified = pathPolicy(request.path, { operation: request.operation });
        if (classified.scope === "system" || classified.scope === "sensitive") {
          throw new Error(classified.reason || "该 known-folder 目标不能通过普通目录授权访问。");
        }
        if (!await hostSecurity.confirmLocalOperation({ kind: "known-folder-access", ...request })) {
          throw new Error("known-folder 访问未获得用户授权。");
        }
        const grant = capabilityStore.issue({
          root: classified.path || request.path,
          operations: [request.operation],
          ttlMs: 5 * 60_000,
          maxUses: 100,
          className: `known-folder-${request.operation}`,
        });
        return { accessId: grant.accessId };
      },
    });
    healthProbe = createLoopbackHealthProbe({
      targets: {
        agent: { kind: "http", host: mcpHost, port: mcpPort, path: "/healthz" },
        tunnel: { kind: "http", host: tunnelHealthHost, port: tunnelHealthPort, path: "/readyz" },
      },
      githubProbe: async () => {
        const connectivity = await defaultTcpProbe({ host: "github.com", port: 443 });
        if (!githubCliPath) {
          return { ok: false, connectivity: connectivity.ok === true, binaryReady: false, authenticated: false };
        }
        const auth = spawnSync(githubCliPath, ["auth", "status"], {
          shell: false,
          windowsHide: true,
          timeout: 10_000,
          stdio: "ignore",
        });
        const authenticated = !auth.error && auth.status === 0;
        return {
          ok: connectivity.ok === true && authenticated,
          connectivity: connectivity.ok === true,
          binaryReady: true,
          authenticated,
        };
      },
    });
    const sshExecutable = settings.sshEnabled && platform !== "win32" ? "/usr/bin/ssh" : "";
    const trustedExecutables = {
      ...(githubCliPath ? { gh: githubCliPath } : {}),
      ...(sshExecutable ? { ssh: sshExecutable } : {}),
    };
    terminalBroker = createLocalTerminalBroker({
      approvalMode: settings.approvalMode,
      classifyCommand: policyModule.classifyCommand,
      confirm: hostSecurity.confirmLocalOperation,
      pathPolicy,
      trustedExecutables,
      networkEnv: proxyEnv,
      sshPolicy: sshExecutable ? (argv) => validateSshCommand(argv, { allowedHosts: settings.sshAllowedHosts }) : undefined,
    });
    socketPath = localBrokerSocketPath();
    if (platform !== "win32") await fsp.rm(socketPath, { force: true }).catch(() => {});
    if (!brokerBootstrap || typeof brokerBootstrap.secret !== "string" || !brokerBootstrap.secret) throw new Error("Local broker authentication bootstrap is required");
    server = net.createServer((socket) => attachConnection(socket, brokerBootstrap));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (platform !== "win32") await fsp.chmod(socketPath, 0o600);
    appendLog("local-broker", "已启动受控本机文件与终端代理。");
    return server;
  }

  return Object.freeze({ start, stop, getSocketPath });
}

module.exports = { createHostBrokerServer };
