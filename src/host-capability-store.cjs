const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_USES = 1;
const MAX_TTL_MS = 5 * 60_000;
const MAX_USES = 100;

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function canonicalAbsolute(value, name) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function createHostCapabilityStore({ generation, policyVersion, now = Date.now, randomId = crypto.randomUUID } = {}) {
  requireNonEmptyString(generation, "generation");
  requireNonEmptyString(policyVersion, "policyVersion");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof randomId !== "function") throw new TypeError("randomId must be a function");

  const grants = new Map();

  function issue({ root, operations, ttlMs = DEFAULT_TTL_MS, maxUses = DEFAULT_MAX_USES, className = "host-access" } = {}) {
    const canonicalRoot = canonicalAbsolute(root, "capability root");
    if (!Array.isArray(operations) || operations.length < 1 || operations.some((operation) => operation !== "read" && operation !== "list")) {
      throw new TypeError("unsupported capability operation");
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) throw new RangeError("capability ttl is out of range");
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_USES) throw new RangeError("capability use count is out of range");
    requireNonEmptyString(className, "className");

    const accessId = requireNonEmptyString(randomId(), "accessId");
    if (grants.has(accessId)) throw new Error("capability id collision");
    const issuedAt = now();
    if (!Number.isFinite(issuedAt)) throw new TypeError("now must return a finite number");

    const normalizedOperations = Object.freeze([...new Set(operations)]);
    const record = Object.freeze({
      accessId,
      root: canonicalRoot,
      operations: normalizedOperations,
      expiresAt: issuedAt + ttlMs,
      remainingUses: maxUses,
      className,
      generation,
      policyVersion,
    });
    grants.set(accessId, record);

    return Object.freeze({
      accessId,
      root: canonicalRoot,
      operations: normalizedOperations,
      expiresAt: record.expiresAt,
      remainingUses: record.remainingUses,
      className,
    });
  }

  function authorize({ accessId, path: inputPath, operation } = {}) {
    const record = typeof accessId === "string" ? grants.get(accessId) : undefined;
    if (!record) throw codedError("HOST_CAPABILITY_REQUIRED", "Host capability is required");

    const currentTime = now();
    if (!Number.isFinite(currentTime)) throw new TypeError("now must return a finite number");
    if (currentTime >= record.expiresAt) {
      grants.delete(record.accessId);
      throw codedError("HOST_CAPABILITY_EXPIRED", "Host capability has expired");
    }

    const target = canonicalAbsolute(inputPath, "capability path");
    if ((operation !== "read" && operation !== "list") || !record.operations.includes(operation) || !isWithin(target, record.root)) {
      throw codedError("HOST_CAPABILITY_SCOPE_MISMATCH", "Host capability does not cover this operation or path");
    }

    const remainingUses = record.remainingUses - 1;
    if (remainingUses <= 0) {
      grants.delete(record.accessId);
    } else {
      grants.set(record.accessId, Object.freeze({ ...record, remainingUses }));
    }
    return target;
  }

  function revoke(accessId) {
    return grants.delete(accessId);
  }

  function clear() {
    grants.clear();
  }

  function size() {
    return grants.size;
  }

  return Object.freeze({ issue, authorize, revoke, clear, size });
}

module.exports = {
  createHostCapabilityStore,
  isWithin,
};
