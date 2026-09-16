const fs = require("node:fs");
const path = require("node:path");

function boundedText(value, max = 64) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function sanitizeReason(reason) {
  if (!reason || typeof reason !== "object") return null;
  const safe = {};
  const code = boundedText(reason.code, 96);
  const kind = boundedText(reason.kind, 32);
  const signal = boundedText(reason.signal, 32);
  if (code) safe.code = code;
  if (kind) safe.kind = kind;
  if (Number.isSafeInteger(reason.failures) && reason.failures >= 0) safe.failures = reason.failures;
  if (Number.isSafeInteger(reason.exitCode)) safe.exitCode = reason.exitCode;
  if (signal) safe.signal = signal;
  return Object.keys(safe).length ? safe : null;
}

function createRuntimeEventJournal({
  filePath,
  maxEntries = 120,
  now = () => new Date().toISOString(),
  readFile = (target) => fs.readFileSync(target, "utf8"),
  writeFile = (target, data) => {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    fs.writeFileSync(temporary, data, { mode: 0o600 });
    fs.renameSync(temporary, target);
  },
} = {}) {
  if (typeof filePath !== "string" || !filePath) throw new TypeError("filePath is required");
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000) throw new RangeError("maxEntries must be between 1 and 1000");
  let entries = [];
  try {
    const parsed = JSON.parse(readFile(filePath));
    if (Array.isArray(parsed)) entries = parsed.slice(-maxEntries);
  } catch {
    entries = [];
  }

  function append(status) {
    if (!status || typeof status !== "object") return;
    const entry = {
      at: boundedText(now(), 64),
      state: boundedText(status.state, 32),
      agentHealth: boundedText(status.agentHealth, 32),
      tunnelReadiness: boundedText(status.tunnelReadiness, 32),
      transitionId: Number.isSafeInteger(status.transitionId) ? status.transitionId : 0,
      reason: sanitizeReason(status.lastExitReason),
    };
    entries.push(entry);
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
    writeFile(filePath, `${JSON.stringify(entries, null, 2)}\n`);
  }

  return Object.freeze({ append });
}

module.exports = { createRuntimeEventJournal };
