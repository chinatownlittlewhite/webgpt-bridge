import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { INTERNAL_STATE_DIR, resolveWorkspace, resolveWorkspacePath } from "./workspace.js";

const SECRET_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|private[-_]?key)/i;
const DEFAULT_MAX_EVENT_BYTES = 64_000;

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeString(value) {
  const bounded = value.length > 16_384 ? `${value.slice(0, 16_384)}...[TRUNCATED]` : value;
  return bounded
    .replace(/(Bearer\s+)[^\s"'`]+/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|token|secret|api[-_]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(Authorization\s*[:=]\s*)(?!Bearer\b)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function sanitizeCommandArgv(argv) {
  const result = [];
  let redactNext = false;
  for (const raw of argv.slice(0, 256)) {
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
    if (Buffer.byteLength(value) > 2_048) {
      result.push(`[ARG:${Buffer.byteLength(value)}:${hashText(value)}]`);
      continue;
    }
    result.push(sanitizeString(value));
  }
  return result;
}

function sanitize(value, depth = 0) {
  if (depth > 8) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return sanitizeString(value);
  if (["number", "boolean"].includes(typeof value)) return value;
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value).slice(0, 256)) {
      if (SECRET_KEY.test(key)) {
        result[key] = "[REDACTED]";
      } else if ((key === "argv" || key === "resolvedArgv") && Array.isArray(entry)) {
        result[key] = sanitizeCommandArgv(entry);
      } else {
        result[key] = sanitize(entry, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

function lastAuditState(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return { sequence: 0, hash: null };
    const length = Math.min(stat.size, 128 * 1024);
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      const lines = buffer.toString("utf8").trim().split("\n").reverse();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (Number.isInteger(parsed.sequence) && typeof parsed.hash === "string") {
            return { sequence: parsed.sequence, hash: parsed.hash };
          }
        } catch {
          // Ignore a partial/corrupt trailing line and keep scanning backward.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // A missing audit file starts a new chain.
  }
  return { sequence: 0, hash: null };
}

export function createAuditLogger({
  workspace,
  file = `${INTERNAL_STATE_DIR}/audit.jsonl`,
  enabled = true,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
} = {}) {
  if (enabled !== true) {
    return Object.freeze({ enabled: false, file: null, record() { return null; } });
  }
  if (!Number.isInteger(maxEventBytes) || maxEventBytes < 4_096 || maxEventBytes > 1_000_000) {
    throw new RangeError("audit maxEventBytes must be between 4096 and 1000000");
  }
  const root = resolveWorkspace(workspace);
  const { path: target } = resolveWorkspacePath(root, file, { allowMissing: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const realParent = fs.realpathSync(path.dirname(target));
  const relative = path.relative(root, realParent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("audit path resolves outside the configured workspace");
  }
  let state = lastAuditState(target);

  function record(event) {
    const sanitized = sanitize(event);
    let eventValue = sanitized;
    let serializedEvent = JSON.stringify(sanitized);
    if (Buffer.byteLength(serializedEvent) > maxEventBytes) {
      eventValue = {
        type: sanitized?.type ?? "oversized_event",
        truncated: true,
        bytes: Buffer.byteLength(serializedEvent),
        sha256: hashText(serializedEvent),
      };
      serializedEvent = JSON.stringify(eventValue);
    }
    const base = {
      timestamp: new Date().toISOString(),
      sequence: state.sequence + 1,
      previousHash: state.hash,
      event: eventValue,
    };
    const hash = hashText(JSON.stringify(base));
    const entry = { ...base, hash };
    fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch {}
    state = { sequence: entry.sequence, hash };
    return Object.freeze({ sequence: entry.sequence, hash });
  }

  return Object.freeze({ enabled: true, file: target, record });
}

export const auditSecurityNotes = Object.freeze({
  hashChain: "sha256",
  secretKeyRedaction: true,
  commandArgRedaction: true,
  oversizedArgHashing: true,
  workspaceBound: true,
  defaultMaxEventBytes: DEFAULT_MAX_EVENT_BYTES,
});
