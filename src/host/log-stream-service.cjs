function createLogStreamService({ maxEntries = 600, now = () => new Date().toISOString() } = {}) {
  const limit = Number(maxEntries);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("maxEntries must be an integer between 1 and 10000");
  if (typeof now !== "function") throw new TypeError("now must be a function");

  let cursor = 0;
  let resetCursor = 0;
  let entries = [];

  function snapshot(reset, selected) {
    return Object.freeze({
      cursor,
      reset,
      entries: Object.freeze(selected.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  function append(source, data) {
    const boundedSource = String(source || "host").slice(0, 64) || "host";
    let added = 0;
    for (const rawLine of String(data ?? "").split(/\r?\n/)) {
      if (!rawLine) continue;
      cursor += 1;
      added += 1;
      entries.push(Object.freeze({
        cursor,
        source: boundedSource,
        line: rawLine.slice(0, 8192),
        at: String(now()).slice(0, 64),
      }));
    }
    if (entries.length > limit) {
      entries = entries.slice(-limit);
      resetCursor = cursor;
    }
    return Object.freeze({ cursor, added });
  }

  function reset() {
    cursor += 1;
    entries = [];
    resetCursor = cursor;
    return cursor;
  }

  function read({ sinceCursor = 0 } = {}) {
    const valid = Number.isInteger(sinceCursor) && sinceCursor >= 0 && sinceCursor <= cursor;
    if (!valid) return snapshot(true, entries);
    if (sinceCursor < resetCursor) return snapshot(true, entries);
    return snapshot(false, entries.filter((entry) => entry.cursor > sinceCursor));
  }

  function getCursor() {
    return cursor;
  }

  return Object.freeze({ append, getCursor, read, reset });
}

module.exports = { createLogStreamService };
