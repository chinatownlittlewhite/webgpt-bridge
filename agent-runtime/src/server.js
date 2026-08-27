import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createAuditLogger } from "./audit.js";
import { resolveGitHubCli } from "./github-cli.js";
import { goalModeHostInstructions } from "./host-instructions.js";
import { ensureHandoffBundle, recordDesignIssue } from "./handoff.js";
import { prepareNativeSandbox, probeWindowsHostPreparation, sandboxPreparationDiagnostic } from "./native-sandbox.js";
import { createProcessManager } from "./process-manager.js";
import { loadProjectContext } from "./project-context.js";
import { createHostApprovalClient } from "./local-broker-client.js";
import { createCoreTools } from "./tool.js";
import { resolveWorkspace } from "./workspace.js";

const VERSION = "0.9.1";
const DEFAULT_PORT = 8787;

function envBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function positivePort(value) {
  const parsed = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new RangeError("LPC_PORT must be between 0 and 65535");
  return parsed;
}

function csvList(value) {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry.length > 0);
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isAbortSignalLike(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

export function trustedContextFromMcp(ctx, hostApproval) {
  const trusted = {};
  if (typeof hostApproval === "function") trusted.requestApproval = hostApproval;
  const signal = ctx?.mcpReq?.signal;
  if (isAbortSignalLike(signal)) trusted.signal = signal;
  return Object.freeze(trusted);
}

function boundedAgentText(text, maxBytes = 48_000) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value);
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n...[AGENT_TEXT_TRUNCATED sha256=${crypto.createHash("sha256").update(value).digest("hex")}]`;
}

function nextActionText(nextAction) {
  if (!nextAction) return "";
  if (nextAction.tool && nextAction.arguments) {
    return `\nNext action: ${nextAction.tool} ${JSON.stringify(nextAction.arguments)}`;
  }
  if (nextAction.hint) return `\nNext: ${nextAction.hint}`;
  return "";
}

function toolResultText(toolName, result) {
  if (!result || typeof result !== "object") return boundedAgentText(String(result));

  if (toolName === "read_file") {
    const range = result.endLine === null ? "no matching lines" : `lines ${result.startLine}-${result.endLine}/${result.totalLines}`;
    return boundedAgentText([
      `read_file: ${result.path} (${range}, ${result.returnedBytes}/${result.totalBytes} bytes)`,
      result.content ?? "",
      nextActionText(result.nextAction),
    ].filter(Boolean).join("\n"));
  }

  if (toolName === "list_dir") {
    const lines = (result.entries ?? []).map((entry) => `${entry.type}\t${entry.path}${entry.bytes === undefined ? "" : `\t${entry.bytes} bytes`}`);
    return boundedAgentText(`list_dir: ${result.path} (${lines.length} entries${result.truncated ? ", truncated" : ""})\n${lines.join("\n")}${nextActionText(result.nextAction)}`);
  }

  if (toolName === "search_text") {
    const lines = (result.matches ?? []).map((match) => `${match.path}:${match.line}:${match.column}: ${match.preview}`);
    return boundedAgentText(`search_text: ${result.matchCount ?? lines.length} matches in ${result.scannedFiles ?? 0} files${result.truncated ? " (truncated)" : ""}\n${lines.join("\n")}${nextActionText(result.nextAction)}`);
  }

  if (toolName === "search_files") {
    return boundedAgentText(`search_files: ${(result.matches ?? []).length} matches${result.truncated ? " (truncated)" : ""}\n${(result.matches ?? []).join("\n")}`);
  }

  if (toolName === "process_poll") {
    const output = (result.chunks ?? []).map((chunk) => `[${chunk.stream}] ${chunk.text}`).join("");
    const next = result.status === "running"
      ? { tool: "process_poll", arguments: { processId: result.processId, cursor: result.nextCursor ?? 0 } }
      : null;
    return boundedAgentText(`process_poll: status=${result.status} exit=${result.exitCode ?? "-"} signal=${result.signal ?? "-"}\n${output}${nextActionText(next)}`);
  }

  if (toolName === "process_start") {
    const next = result.status === "running"
      ? { tool: "process_poll", arguments: { processId: result.processId, cursor: 0 } }
      : null;
    return boundedAgentText(`process_start: status=${result.status} processId=${result.processId ?? "-"} pid=${result.pid ?? "-"}${nextActionText(next)}`);
  }

  if (toolName === "dependency_sync" && result.status === "running") {
    return boundedAgentText(
      `dependency_sync: status=running ecosystem=${result.ecosystem ?? "-"} processId=${result.processId ?? "-"} pid=${result.pid ?? "-"}${nextActionText(result.nextAction)}`,
    );
  }

  if (["run_command", "run_project_task", "git", "dependency_sync", "github"].includes(toolName)) {
    return boundedAgentText([
      `${toolName}: status=${result.status ?? "unknown"} exit=${result.exitCode ?? "-"} signal=${result.signal ?? "-"}${result.error ? ` error=${result.error}` : ""}`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : "",
    ].filter(Boolean).join("\n"));
  }

  if (toolName.startsWith("goal_")) {
    const parts = [
      `${toolName}: status=${result.status ?? "unknown"} mustContinue=${result.mustContinue === true}`,
      result.feedback ? `feedback: ${result.feedback}` : "",
      result.next ? `next: ${result.next}` : "",
    ];
    if (result.projectContext?.instructions) {
      parts.push(`Project instructions:\n${result.projectContext.instructions}`);
      if (result.projectContext.nestedInstructionFiles?.length) {
        parts.push(`Nested instruction files (read when entering those paths):\n${result.projectContext.nestedInstructionFiles.join("\n")}`);
      }
    }
    return boundedAgentText(parts.filter(Boolean).join("\n"));
  }

  return boundedAgentText(JSON.stringify(result, null, 2));
}

function isErrorResult(result) {
  return [
    "denied",
    "approval_denied",
    "approval_error",
    "platform_error",
    "spawn_error",
    "tool_error",
    "failed",
  ].includes(result?.status);
}

function callToolResult(toolName, result) {
  return {
    content: [{ type: "text", text: toolResultText(toolName, result) }],
    structuredContent: result,
    ...(isErrorResult(result) ? { isError: true } : {}),
  };
}

function approvalDisplayArgv(argv) {
  if (!Array.isArray(argv)) return [];
  const result = [];
  let redactNext = false;
  for (const raw of argv.slice(0, 12)) {
    const value = String(raw);
    if (redactNext) {
      result.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    if (/^--?(?:password|passwd|token|secret|api[-_]?key|authorization)$/i.test(value)) {
      result.push(value);
      redactNext = true;
      continue;
    }
    if (/^--?(?:password|passwd|token|secret|api[-_]?key|authorization)=/i.test(value)) {
      result.push(`${value.slice(0, value.indexOf("=") + 1)}[REDACTED]`);
      continue;
    }
    result.push(value
      .replace(/(Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"));
  }
  return result;
}

function safeApprovalSummary(toolName, request) {
  const displayed = approvalDisplayArgv(request.argv);
  const command = displayed.length > 0 ? displayed.join(" ") : toolName;
  return [
    `Approve WebGPT Bridge action '${toolName}'?`,
    `cwd: ${request.cwd ?? "."}`,
    `command: ${command}`,
    `policy: ${request.policy?.reason ?? request.policy?.rule ?? "approval required"}`,
  ].join("\n");
}

function bearerAuthorized(req, token) {
  if (!token) return true;
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function writeEmpty(res, status) {
  res.writeHead(status, {
    "content-length": "0",
    "cache-control": "no-store",
  });
  res.end();
}

function toolAnnotations(name) {
  const readOnly = new Set(["process_poll", "process_list", "read_file", "list_dir", "search_text", "search_files", "goal_status", "get_capabilities"]);
  const destructive = new Set(["delete_file", "move_file", "process_kill"]);
  return {
    readOnlyHint: readOnly.has(name),
    destructiveHint: destructive.has(name),
    idempotentHint: readOnly.has(name),
    openWorldHint: ["dependency_sync", "github"].includes(name),
  };
}

function buildMcpServer({ tools, auditLogger, instructions, hostApproval }) {
  const server = new McpServer(
    { name: "webgpt-bridge", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
        annotations: toolAnnotations(tool.name),
      },
      async (args, ctx) => {
        try {
          const trustedContext = trustedContextFromMcp(ctx, hostApproval);
          const result = await tool.invoke(args, trustedContext);
          return callToolResult(tool.name, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          auditLogger.record({ type: "mcp_tool_error", tool: tool.name, error: message });
          return callToolResult(tool.name, { status: "tool_error", error: message });
        }
      },
    );
  }
  return server;
}

export async function createProductionRuntime({
  workspace = process.env.LPC_WORKSPACE ?? process.cwd(),
  verifySandbox = envBool(process.env.LPC_VERIFY_SANDBOX, true),
  enableNetworkTools = envBool(process.env.LPC_ENABLE_NETWORK_TOOLS, false),
  localBrokerSocket = process.env.LPC_LOCAL_BROKER_SOCKET ?? "",
  windowsHelperPath = process.env.LPC_WINDOWS_SANDBOX_HELPER,
  windowsHostPrepPath = process.env.LPC_WINDOWS_HOST_PREP,
  githubCliPath = process.env.LPC_GITHUB_CLI_PATH ?? "",
  designIssueJournal = envBool(process.env.LPC_DESIGN_ISSUE_JOURNAL, false),
} = {}) {
  const root = resolveWorkspace(workspace);
  ensureHandoffBundle({ workspace: root, cwd: ".", version: VERSION });
  const projectContext = loadProjectContext({ workspace: root, cwd: ".", maxFiles: 12, maxTotalBytes: 48_000 });
  const serverInstructions = [
    goalModeHostInstructions,
    projectContext.instructions
      ? `Workspace project instructions (follow these when they apply):\n\n${projectContext.instructions}`
      : "",
  ].filter(Boolean).join("\n\n");
  const auditLogger = createAuditLogger({ workspace: root, enabled: !envBool(process.env.LPC_DISABLE_AUDIT, false) });
  const windowsHostPreparationState = probeWindowsHostPreparation({
    platform: process.platform,
    helperPath: windowsHostPrepPath,
  });
  const normalSandbox = await prepareNativeSandbox({
    workspace: root,
    platform: process.platform,
    allowNetwork: false,
    windowsHelperPath,
    windowsHostPrepPath,
    windowsHostPreparationState,
    verify: verifySandbox,
  });
  const networkSandbox = enableNetworkTools
    ? await prepareNativeSandbox({
        workspace: root,
        platform: process.platform,
        allowNetwork: true,
        windowsHelperPath,
        windowsHostPrepPath,
        windowsHostPreparationState,
        verify: verifySandbox,
      })
    : null;
  const networkSandboxAdapter = networkSandbox?.summary.autoRunSafe === true
    ? networkSandbox.adapter
    : undefined;
  const networkSandboxState = sandboxPreparationDiagnostic(networkSandbox, {
    enabled: enableNetworkTools,
    platform: process.platform,
    allowNetwork: true,
  });
  const githubCliState = resolveGitHubCli({
    platform: process.platform,
    env: process.env,
    explicitPath: githubCliPath,
  });

  const processManager = createProcessManager({
    workspace: root,
    sandboxAdapter: normalSandbox.adapter,
    platform: process.platform,
    auditLogger,
    maxProcesses: 32,
    designIssueRecorder: designIssueJournal
      ? (issue) => recordDesignIssue({ workspace: root, enabled: true, version: VERSION, ...issue })
      : undefined,
  });
  const tools = createCoreTools({
    workspace: root,
    sandboxAdapter: normalSandbox.adapter,
    networkSandboxAdapter,
    networkSandboxState,
    githubCliState,
    windowsHostPreparationState,
    localBrokerSocket,
    processManager,
    platform: process.platform,
    auditLogger,
    goalPersistSessions: true,
    goalStrictVerification: true,
    goalVerificationTasks: ["test", "lint", "typecheck"],
    maxProcesses: 32,
  });

  const hostApproval = localBrokerSocket ? createHostApprovalClient({ socketPath: localBrokerSocket }) : undefined;
  const mcpHandler = createMcpHandler(
    () => buildMcpServer({ tools, auditLogger, instructions: serverInstructions, hostApproval }),
    { legacy: "stateless" },
  );

  auditLogger.record({
    type: "runtime_created",
    version: VERSION,
    platform: process.platform,
    workspace: root,
    tools: tools.map((tool) => tool.name),
    sandbox: normalSandbox.summary,
    networkTools: networkSandboxState,
    githubCli: githubCliState,
    windowsHostPreparation: windowsHostPreparationState,
  });

  return Object.freeze({
    workspace: root,
    projectContext,
    tools,
    processManager,
    auditLogger,
    normalSandbox,
    networkSandbox,
    networkSandboxState,
    githubCliState,
    windowsHostPreparationState,
    mcpHandler,
  });
}

export async function startProductionServer(options = {}) {
  const runtime = await createProductionRuntime(options);
  const host = options.host ?? process.env.LPC_HOST ?? "127.0.0.1";
  const port = positivePort(options.port ?? process.env.LPC_PORT);
  const token = options.token ?? process.env.LPC_MCP_TOKEN ?? "";
  const loopback = isLoopbackHost(host);
  const allowedHosts = csvList(options.allowedHosts ?? process.env.LPC_ALLOWED_HOSTS);
  const allowedOrigins = csvList(options.allowedOrigins ?? process.env.LPC_ALLOWED_ORIGINS);
  if (!loopback && token.length < 24) {
    throw new Error("A non-loopback MCP bind requires LPC_MCP_TOKEN with at least 24 characters");
  }
  if (!loopback && allowedHosts.length === 0) {
    throw new Error("A non-loopback MCP bind requires LPC_ALLOWED_HOSTS (comma-separated hostnames)");
  }

  const nodeHandler = toNodeHandler(runtime.mcpHandler, {
    onerror(error) {
      runtime.auditLogger.record({ type: "mcp_handler_error", error: error instanceof Error ? error.message : String(error) });
    },
  });
  const validateHost = loopback
    ? localhostHostValidation()
    : hostHeaderValidation(allowedHosts);
  const validateOrigin = loopback
    ? localhostOriginValidation()
    : originValidation(allowedOrigins.length > 0 ? allowedOrigins : allowedHosts);

  const server = http.createServer((req, res) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    let requestPath;
    try {
      requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      writeJson(res, 400, { error: "invalid_request_path" });
      return;
    }
    if ((requestPath === "/mcp" || requestPath === "/healthz") && !bearerAuthorized(req, token)) {
      res.setHeader("www-authenticate", "Bearer");
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (requestPath === "/healthz" && req.method === "GET") {
      writeJson(res, 200, {
        ok: true,
        name: "webgpt-bridge",
        version: VERSION,
        platform: process.platform,
        workspace: runtime.workspace,
        toolCount: runtime.tools.length,
        sandbox: runtime.normalSandbox.summary,
      });
      return;
    }
    if (requestPath === "/.well-known/oauth-protected-resource" || requestPath === "/.well-known/oauth-protected-resource/mcp" || requestPath === "/.well-known/oauth-authorization-server") {
      writeEmpty(res, 404);
      return;
    }
    if (requestPath !== "/mcp") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }
    void nodeHandler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const displayHost = typeof address === "object" && address ? address.address : host;
  const displayPort = typeof address === "object" && address ? address.port : port;
  console.error(`[webgpt-bridge] v${VERSION} listening on http://${displayHost}:${displayPort}/mcp`);
  console.error(`[webgpt-bridge] platform=${process.platform} sandbox=${runtime.normalSandbox.summary.name} autoRunSafe=${runtime.normalSandbox.summary.autoRunSafe}`);
  const close = async () => {
    await runtime.processManager.close();
    await runtime.mcpHandler.close();
    await new Promise((resolve) => server.close(resolve));
  };
  if (options.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.once(signal, () => { void close().finally(() => process.exit(0)); });
    }
  }

  return Object.freeze({ runtime, server, close, host: displayHost, port: displayPort });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startProductionServer().catch((error) => {
    console.error(`[webgpt-bridge] startup failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
