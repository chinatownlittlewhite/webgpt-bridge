import crypto from "node:crypto";
import net from "node:net";
import { validateJsonSchema } from "./schema-validate.js";

const pathSchema = { type: "string", minLength: 1, maxLength: 4_096 };
const shaSchema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
const accessIdSchema = { type: "string", minLength: 1, maxLength: 128 };
const safeExecutableSchema = {
  type: "string",
  minLength: 1,
  maxLength: 128,
  pattern: "^(?!(?:sudo|su|doas|ssh|scp|sftp|sh|bash|zsh|fish|cmd(?:\\.exe)?|powershell|pwsh)$)[^/\\\\\\u0000]+$",
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

export const localRequestSensitiveAccessInputSchema = Object.freeze({
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

function requestOverSocket(socketPath, method, params, timeoutMs = 20_000) {
  if (typeof socketPath !== "string" || socketPath.length === 0) throw new TypeError("App-owned local broker socket is not configured");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("本机代理超时必须是正整数毫秒值。");
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const socket = net.createConnection(socketPath);
    let buffered = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`本机代理在 ${Math.ceil(timeoutMs / 1_000)} 秒内没有响应。`));
    }, timeoutMs);
    function finish(error, value) {
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    }
    socket.once("error", (error) => finish(new Error(`无法连接本机代理：${error.message}`)));
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line);
          if (response.id !== id) continue;
          if (!response.ok) finish(new Error(response.error || "本机代理拒绝了请求。"));
          else finish(null, response.result);
          return;
        } catch (error) {
          finish(new Error(`本机代理响应无效：${error.message}`));
          return;
        }
      }
    });
  });
}

export function createLocalBrokerClient({ socketPath, timeoutMs = 20_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new RangeError("本机代理超时必须是正整数毫秒值。");
  return Object.freeze({
    timeoutMs,
    request: (method, params) => requestOverSocket(socketPath, method, params, timeoutMs),
  });
}

export function createHostApprovalClient({ socketPath, timeoutMs = 5 * 60_000 } = {}) {
  const client = createLocalBrokerClient({ socketPath, timeoutMs });
  const requestHostApproval = async function requestHostApproval(request) {
    const result = await client.request("host_approve_command", { request });
    return result?.approved === true;
  };
  Object.defineProperty(requestHostApproval, "timeoutMs", { value: timeoutMs, enumerable: true });
  return Object.freeze(requestHostApproval);
}

function tool(name, description, inputSchema, client) {
  return Object.freeze({
    name,
    description,
    inputSchema,
    timeoutMs: client.timeoutMs,
    invoke(input) {
      validateJsonSchema(input, inputSchema);
      return client.request(name, input);
    },
  });
}

export function createLocalBrokerTools({ socketPath } = {}) {
  if (typeof socketPath !== "string" || socketPath.length === 0) return [];
  const client = createLocalBrokerClient({ socketPath });
  const interactiveClient = createLocalBrokerClient({ socketPath, timeoutMs: 5 * 60_000 });
  return [
    tool("local_list", "List an allowed non-sensitive local directory through the App-owned broker; symlinks are not followed.", localListInputSchema, client),
    tool("local_read", "Read a bounded UTF-8 local file through the App-owned broker and receive its SHA-256.", localReadInputSchema, client),
    tool("local_request_sensitive_access", "Ask the desktop App for one-time native approval to list or read one sensitive path.", localRequestSensitiveAccessInputSchema, interactiveClient),
    tool("local_stage_changes", "Stage 1–20 SHA-bound non-sensitive file changes; this does not write files.", localStageChangesInputSchema, client),
    tool("local_confirm_batch", "Commit a previously staged local change batch. The App revalidates all SHA values and requests confirmation when required.", localConfirmBatchInputSchema, interactiveClient),
    tool("local_run_command", "Run an argv-only command only when App-owned host integration is required. Prefer the sandboxed run_command tool for ordinary project execution. Shells and privilege escalation are unavailable.", localRunCommandInputSchema, interactiveClient),
  ];
}
