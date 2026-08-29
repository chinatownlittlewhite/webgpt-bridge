(function initRendererLogState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.WebGPTLogState = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  const DEFAULT_CAPACITY = 600;
  const MAX_PENDING_EVENTS = 128;

  function positiveInteger(value, fallback, label) {
    const resolved = value === undefined ? fallback : value;
    if (!Number.isInteger(resolved) || resolved <= 0) throw new TypeError(`${label} must be a positive integer`);
    return resolved;
  }

  function copyEntry(entry) {
    return Object.freeze({
      seq: entry.seq,
      source: String(entry.source || "host"),
      line: String(entry.line || ""),
      at: String(entry.at || ""),
    });
  }

  function validSequence(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function normalizeEntries(value) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((entry) => entry && Number.isSafeInteger(entry.seq) && entry.seq > 0)
      .map(copyEntry);
  }

  function createRendererLogState({
    capacity = DEFAULT_CAPACITY,
    requestSnapshot,
    onSnapshot = () => {},
    onAppend = () => {},
  } = {}) {
    capacity = positiveInteger(capacity, DEFAULT_CAPACITY, "capacity");
    if (typeof requestSnapshot !== "function") throw new TypeError("requestSnapshot must be a function");
    if (typeof onSnapshot !== "function") throw new TypeError("onSnapshot must be a function");
    if (typeof onAppend !== "function") throw new TypeError("onAppend must be a function");

    let generation = "";
    let lastSeq = 0;
    let entries = [];
    let initialized = false;
    let resyncPromise = null;
    let snapshotEpoch = 0;
    let pendingEvents = [];
    let pendingOverflow = false;

    function getState() {
      return Object.freeze({
        generation,
        lastSeq,
        initialized,
        entries: Object.freeze(entries.map(copyEntry)),
      });
    }

    function queueEvent(event) {
      pendingEvents.push(event);
      if (pendingEvents.length > MAX_PENDING_EVENTS) {
        pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS);
        pendingOverflow = true;
      }
    }

    function applySnapshot(event) {
      if (!event || event.kind !== "snapshot" || typeof event.generation !== "string" || !event.generation || !validSequence(event.lastSeq)) {
        throw new Error("Invalid Host log snapshot");
      }
      const nextEntries = normalizeEntries(event.entries).slice(-capacity);
      generation = event.generation;
      lastSeq = event.lastSeq;
      entries = nextEntries;
      initialized = true;
      onSnapshot(Object.freeze(entries.map(copyEntry)), Object.freeze({ generation, lastSeq }));
    }

    function applyAppend(event) {
      if (!event || event.kind !== "append" || typeof event.generation !== "string" || !validSequence(event.fromSeq) || !validSequence(event.toSeq) || event.fromSeq <= 0 || event.toSeq < event.fromSeq) {
        return "gap";
      }
      if (event.generation !== generation) return "gap";
      if (event.toSeq <= lastSeq) return "ok";
      if (event.fromSeq > lastSeq + 1) return "gap";

      const incoming = normalizeEntries(event.entries).filter((entry) => entry.seq > lastSeq);
      if (!incoming.length) return "gap";
      let expectedSeq = lastSeq + 1;
      for (const item of incoming) {
        if (item.seq !== expectedSeq) return "gap";
        expectedSeq += 1;
      }
      if (incoming[incoming.length - 1].seq !== event.toSeq) return "gap";

      entries.push(...incoming);
      const trimCount = Math.max(0, entries.length - capacity);
      if (trimCount) entries.splice(0, trimCount);
      lastSeq = event.toSeq;
      onAppend(Object.freeze(incoming.map(copyEntry)), Object.freeze({ generation, lastSeq, trimCount }));
      return "ok";
    }

    async function drainPending() {
      const queued = pendingEvents;
      const overflowed = pendingOverflow;
      pendingEvents = [];
      pendingOverflow = false;
      if (overflowed) return startResync();
      for (const event of queued) {
        if (event?.generation !== generation) continue;
        if (applyAppend(event) === "gap") {
          queueEvent(event);
          return startResync();
        }
      }
      return undefined;
    }

    function startResync() {
      if (resyncPromise) return resyncPromise;
      const requestEpoch = snapshotEpoch;
      resyncPromise = (async () => {
        try {
          const snapshot = await requestSnapshot();
          if (requestEpoch === snapshotEpoch) applySnapshot(snapshot);
        } finally {
          resyncPromise = null;
        }
        return drainPending();
      })();
      return resyncPromise;
    }

    function handle(event) {
      if (!event || (event.kind !== "snapshot" && event.kind !== "append")) return Promise.resolve();
      if (event.kind === "snapshot") {
        snapshotEpoch += 1;
        applySnapshot(event);
        return Promise.resolve();
      }
      if (!initialized || resyncPromise) {
        queueEvent(event);
        return resyncPromise || Promise.resolve();
      }
      if (applyAppend(event) === "ok") return Promise.resolve();
      queueEvent(event);
      return startResync();
    }

    return Object.freeze({
      bootstrap: startResync,
      getState,
      handle,
    });
  }

  return Object.freeze({ createRendererLogState });
});
