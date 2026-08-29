import crypto from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { validateJsonSchema } from "./schema-validate.js";

const require = createRequire(import.meta.url);
const { BROKER_PROTOCOL_VERSION, createBrokerProof } = require("../../shared/local-broker-protocol.cjs");
const {
  findBrokerMethodByImplementation,
  getBrokerMethodMetadata,
  listToolMetadata,
} = require("../../shared/tool-registry.cjs");

const pathSchema = { type: "string", minLength: 1, maxLength: 4_096 };
const shaSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const accessIdSchema = { type: "string", minLength: 1, maxLength: 128 };
const knownFolderSchema = { type: "string", enum: ["desktop", "downloads", "documents"] };
const relativePathSchema = { type: "string", maxLength: 4_096, pattern: "^(?!/)(?![A-Za-z]:[\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[^\u0000]*$" };
const safeExecutableSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^(?!(?:sudo|su|doas|scp|sftp|sh|bash|zsh|fish|cmd(?:\\.exe)?|powershell|pwsh)$)[^/\\\\\\u0000]+$",
};
const argvSchema = {
  type: "array",
  minItems: 1,
  maxItems: 128,
  items: { type: "string", minLength: 1, maxLength: 16_384, pattern: "^[^\\u0000]+$" },
  prefixItems: [safeExecutableSchema],
};

export const localListInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: pathSchema, depth: { type: "integer", minimum: 1, maximum: 4, default: 1 }, includeHidden: { type: "boolean", default: false }, accessId: accessIdSchema },
});

export const localReadInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["path"],
  properties: { path: pathSchema, startLine: { type: "integer", minimum: 1, maximum: 10_000_000, default: 1 }, maxLines: { type: "integer", minimum: 1, maximum: 500, default: 200 }, accessId: accessIdSchema },
});

export const localListKnownFolderInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["folder"],
  properties: { folder: knownFolderSchema, relativePath: relativePathSchema, depth: { type: "integer", minimum: 1, maximum: 4, default: 1 }, includeHidden: { type: "boolean", default: false } },
});

export const localReadKnownFolderInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["folder"],
  properties: { folder: knownFolderSchema, relativePath: relativePathSchema, startLine: { type: "integer", minimum: 1, maximum: 10_000_000, default: 1 }, maxLines: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
});

export const localProbeHealthInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["target"],
  properties: { target: { type: "string", enum: ["agent", "tunnel", "github"] } },
});

export const localRequestSensitiveAccessInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["path", "operation"],
  properties: { path: pathSchema, operation: { type: "string", enum: ["list", "read"] } },
});

export const localRequestHostAccessInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["path", "operation"],
  properties: { path: pathSchema, operation: { type: "string", enum: ["list", "read"] } },
});

export const localStageChangesInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["changes"],
  properties: {
    changes: {
      type: "array", minItems: 1, maxItems: 20,
      items: {
        oneOf: [
          { type: "object", additionalProperties: false, required: ["type", "path", "content"], properties: { type: { const: "create" }, path: pathSchema, content: { type: "string", maxLength: 1_048_576 } } },
          { type: "object", additionalProperties: false, required: ["type", "path", "content", "expectedSha256"], properties: { type: { const: "update" }, path: pathSchema, content: { type: "string", maxLength: 1_048_576 }, expectedSha256: shaSchema } },
          { type: "object", additionalProperties: false, required: ["type", "path", "expectedSha256"], properties: { type: { const: "delete" }, path: pathSchema, expectedSha256: shaSchema } },
          { type: "object", additionalProperties: false, required: ["type", "from", "path", "expectedSha256"], properties: { type: { const: "move" }, from: pathSchema, path: pathSchema, expectedSha256: shaSchema } },
        ],
      },
    },
  },
});

export const localConfirmBatchInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["batchId"], properties: { batchId: { type: "string", minLength: 1, maxLength: 128 } },
});

export const localRunCommandInputSchema = Object.freeze({
  type: "object", additionalProperties: false, required: ["argv", "cwd"],
  properties: { argv: argvSchema, cwd: { ...pathSchema, pattern: "^(?:/|[A-Za-z]:[\\\\/])" } },
});

function codedBrokerError(code, message) {
  return Object.assign(new Error(message), { code });
}

function normalizeBrokerAuth(auth) {
  if (!auth || typeof auth !== "object") throw codedBrokerError("BROKER_AUTH_FAILED", "Local broker authentication metadata is required");
  if (auth.protocolVersion !== BROKER_PROTOCOL_VERSION) throw codedBrokerError("BROKER_PROTOCOL_MISMATCH", "Local broker protocol version mismatch");
  for (const field of ["sessionId", "secret", "agentVersion"]) {
    if (typeof auth[field] !== "string" || auth[field].length < 1 || auth[field].length > 512) {
      throw codedBrokerError("BROKER_AUTH_FAILED", "Local broker authentication metadata is invalid");
    }
  }
  return Object.freeze({
    protocolVersion: auth.protocolVersion,
    sessionId: auth.sessionId,
    secret: auth.secret,
    agentVersion: auth.agentVersion,
  });
}

function requestOverSocket(socketPath, method, params, timeoutMs = 20_000, auth) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw new TypeError("App-owned local broker socket is not configured");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("本机代理超时必须是正整数毫秒值。");
  const normalizedAuth = normalizeBrokerAuth(auth);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(socketPath);
    let buffered = "";
    let state = "awaiting_challenge";
    let settled = false;
    const timeout = setTimeout(() => {
      finish(new Error(`本机代理在 ${Math.ceil(timeoutMs / 1_000)} 秒内没有响应。`));
    }, timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }
    socket.once("error", (error) => finish(new Error(`无法连接本机代理：${error.message}`)));
    socket.once("connect", () => socket.write(`${JSON.stringify({
      type: "hello",
      protocolVersion: normalizedAuth.protocolVersion,
      sessionId: normalizedAuth.sessionId,
      agentVersion: normalizedAuth.agentVersion,
    })}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim() || settled) continue;
        try {
          const response = JSON.parse(line);
          if (response?.type === "hello_error") {
            const code = response.code === "BROKER_PROTOCOL_MISMATCH" ? "BROKER_PROTOCOL_MISMATCH" : "BROKER_AUTH_FAILED";
            finish(codedBrokerError(code, code === "BROKER_PROTOCOL_MISMATCH" ? "Local broker protocol version mismatch" : "Local broker authentication failed"));
            return;
          }
          if (state === "awaiting_challenge") {
            if (response?.type !== "challenge" || typeof response.nonce !== "string" || !response.nonce) {
              finish(codedBrokerError("BROKER_AUTH_FAILED", "Local broker challenge is invalid"));
              return;
            }
            const proof = createBrokerProof({ ...normalizedAuth, nonce: response.nonce });
            socket.write(`${JSON.stringify({
              type: "authenticate",
              protocolVersion: normalizedAuth.protocolVersion,
              sessionId: normalizedAuth.sessionId,
              agentVersion: normalizedAuth.agentVersion,
              nonce: response.nonce,
              proof,
            })}\n`);
            state = "awaiting_hello_ok";
            continue;
          }
          if (state === "awaiting_hello_ok") {
            if (response?.type !== "hello_ok") {
              finish(codedBrokerError("BROKER_AUTH_FAILED", "Local broker authentication failed"));
              return;
            }
            socket.write(`${JSON.stringify({ id, method, params })}\n`);
            state = "ready";
            continue;
          }
          if (state === "ready") {
            if (response.id !== id) continue;
            if (!response.ok) finish(new Error(response.error || "本机代理拒绝了请求。"));
            else finish(null, response.result);
            return;
          }
        } catch (error) {
          finish(new Error(`本机代理响应无效：${error.message}`));
          return;
        }
      }
    });
  });
}

export function createLocalBrokerClient({ socketPath, timeoutMs = 20_000, auth } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("本机代理超时必须是正整数毫秒值。");
  const normalizedAuth = typeof socketPath === "string" && socketPath.length > 0 ? normalizeBrokerAuth(auth) : auth;
  return Object.freeze({
    timeoutMs,
    request: (method, params) => requestOverSocket(socketPath, method, params, timeoutMs, normalizedAuth),
  });
}

export function brokerMethodForImplementation(implementationKey) {
  const metadata = findBrokerMethodByImplementation(implementationKey);
  if (!metadata) throw new Error(`broker registry implementation is missing: ${String(implementationKey)}`);
  return metadata.method;
}

export function createHostApprovalClient({ socketPath, timeoutMs = 5 * 60_000, auth } = {}) {
  const client = createLocalBrokerClient({ socketPath, timeoutMs, auth });
  const requestHostApproval = async function requestHostApproval(request) {
    const result = await client.request(brokerMethodForImplementation("command.approve"), { request });
    return result?.approved === true;
  };
  Object.defineProperty(requestHostApproval, "timeoutMs", { value: timeoutMs, enumerable: true });
  return Object.freeze(requestHostApproval);
}

const BROKER_TOOL_ADAPTERS = Object.freeze({
  "file.list": Object.freeze({ description: "List an allowed non-sensitive local directory through the App-owned broker; symlinks are not followed.", inputSchema: localListInputSchema }),
  "file.read": Object.freeze({ description: "Read a bounded UTF-8 local file through the App-owned broker and receive its SHA-256.", inputSchema: localReadInputSchema }),
  "known-folder.list": Object.freeze({ description: "List desktop, downloads, or documents through a fixed known-folder root and relative path.", inputSchema: localListKnownFolderInputSchema }),
  "known-folder.read": Object.freeze({ description: "Read desktop, downloads, or documents through a fixed known-folder root and relative path.", inputSchema: localReadKnownFolderInputSchema }),
  "health.probe": Object.freeze({ description: "Probe only the fixed agent, tunnel, or github health targets through the App-owned broker.", inputSchema: localProbeHealthInputSchema }),
  "access.sensitive.request": Object.freeze({ description: "Ask the desktop App for one-time native approval to list or read one sensitive path.", inputSchema: localRequestSensitiveAccessInputSchema }),
  "access.host.request": Object.freeze({ description: "Ask the desktop App for explicit access to one ordinary Host path outside the workspace. Known folders and sensitive paths keep their dedicated authorization flows.", inputSchema: localRequestHostAccessInputSchema }),
  "file-batch.stage": Object.freeze({ description: "Stage 1–20 SHA-bound non-sensitive file changes; this does not write files.", inputSchema: localStageChangesInputSchema }),
  "file-batch.confirm": Object.freeze({ description: "Commit a previously staged local change batch. The App revalidates all SHA values and requests confirmation when required.", inputSchema: localConfirmBatchInputSchema }),
  "command.run": Object.freeze({ description: "Run an argv-only command only when App-owned host integration is required. Prefer the sandboxed run_command tool for ordinary project execution. Shells and privilege escalation are unavailable.", inputSchema: localRunCommandInputSchema }),
});

function tool(metadata, adapter, client) {
  return Object.freeze({
    name: metadata.name,
    description: adapter.description,
    inputSchema: adapter.inputSchema,
    timeoutMs: client.timeoutMs,
    invoke(input) {
      validateJsonSchema(input, adapter.inputSchema);
      return client.request(metadata.brokerMethod, input);
    },
  });
}

export function createLocalBrokerTools({ socketPath, auth } = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) return [];
  const client = createLocalBrokerClient({ socketPath, auth });
  const interactiveClient = createLocalBrokerClient({ socketPath, timeoutMs: 5 * 60_000, auth });
  return listToolMetadata({ brokerEnabled: true })
    .filter((metadata) => metadata.availability === "broker")
    .map((metadata) => {
      const brokerMetadata = getBrokerMethodMetadata(metadata.brokerMethod);
      const adapter = brokerMetadata ? BROKER_TOOL_ADAPTERS[brokerMetadata.implementationKey] : null;
      if (!brokerMetadata || !adapter) throw new Error(`broker registry adapter is missing: ${metadata.name}`);
      const selectedClient = metadata.timeoutClass === "interactive-broker" ? interactiveClient : client;
      return tool(metadata, adapter, selectedClient);
    });
}
