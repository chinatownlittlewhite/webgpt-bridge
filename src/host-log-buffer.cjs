const crypto = require("node:crypto");

const DEFAULT_CAPACITY = 600;
const DEFAULT_MAX_BATCH_ENTRIES = 64;
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE_BYTES = 8 * 1024;
const TRUNCATION_MARKER = " … [truncated]";

function positiveInteger(value, fallback, label) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new TypeError(`${label} must be a positive integer`);
  return resolved;
}

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  const prefix = encoded.subarray(0, budget).toString("utf8").replace(/\uFFFD$/u, "");
  return `${prefix}${TRUNCATION_MARKER}`;
}

function freezeEntry(entry) {
  return Object.freeze({
    seq: entry.seq,
    source: entry.source,
    line: entry.line,
    at: entry.at,
  });
}

function createHostLogBuffer({
  capacity = DEFAULT_CAPACITY,
  maxBatchEntries = DEFAULT_MAX_BATCH_ENTRIES,
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  now = () => new Date().toISOString(),
  createGeneration = () => crypto.randomUUID(),
} = {}) {
  capacity = positiveInteger(capacity, DEFAULT_CAPACITY, "capacity");
  maxBatchEntries = positiveInteger(maxBatchEntries, DEFAULT_MAX_BATCH_ENTRIES, "maxBatchEntries");
  maxBatchBytes = positiveInteger(maxBatchBytes, DEFAULT_MAX_BATCH_BYTES, "maxBatchBytes");
  maxLineBytes = positiveInteger(maxLineBytes, DEFAULT_MAX_LINE_BYTES, "maxLineBytes");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  if (typeof createGeneration !== "function") throw new TypeError("createGeneration must be a function");

  let generation = String(createGeneration());
  let nextSeq = 1;
  let entries = [];
  let pending = [];
  let flushScheduled = false;
  let flushToken = 0;
  const listeners = new Set();

  function notify(event) {
    for (const listener of [...listeners]) listener(event);
  }

  function snapshot() {
    return Object.freeze({
      kind: "snapshot",
      generation,
      lastSeq: nextSeq - 1,
      entries: Object.freeze(entries.map(freezeEntry)),
    });
  }

  function flush(token) {
    if (token !== flushToken) return;
    flushScheduled = false;
    while (pending.length) {
      const batch = [];
      let batchBytes = 0;
      while (pending.length && batch.length < maxBatchEntries) {
        const candidate = pending[0];
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
        if (batch.length && batchBytes + candidateBytes > maxBatchBytes) break;
        pending.shift();
        batch.push(candidate);
        batchBytes += candidateBytes;
      }
      if (!batch.length) batch.push(pending.shift());
      const frozenEntries = Object.freeze(batch.map(freezeEntry));
      notify(Object.freeze({
        kind: "append",
        generation,
        fromSeq: frozenEntries[0].seq,
        toSeq: frozenEntries[frozenEntries.length - 1].seq,
        entries: frozenEntries,
      }));
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    const token = flushToken;
    queueMicrotask(() => flush(token));
  }

  function append(source, data) {
    const safeSource = truncateUtf8(source || "host", 128);
    let appended = 0;
    for (const rawLine of String(data).split(/\r?\n/)) {
      if (!rawLine) continue;
      const entry = {
        seq: nextSeq++,
        source: safeSource,
        line: truncateUtf8(rawLine, maxLineBytes),
        at: String(now()),
      };
      entries.push(entry);
      pending.push(entry);
      appended += 1;
    }
    if (entries.length > capacity) entries = entries.slice(-capacity);
    if (appended) scheduleFlush();
    return appended;
  }

  function reset() {
    flushToken += 1;
    flushScheduled = false;
    pending = [];
    entries = [];
    generation = String(createGeneration());
    nextSeq = 1;
    const event = snapshot();
    notify(event);
    return event;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return Object.freeze({
    append,
    reset,
    snapshot,
    subscribe,
  });
}

module.exports = {
  createHostLogBuffer,
};
