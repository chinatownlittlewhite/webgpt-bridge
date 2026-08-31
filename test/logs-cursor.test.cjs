const test = require("node:test");
const assert = require("node:assert/strict");

const { createLogStreamService } = require("../src/host/log-stream-service.cjs");

test("log stream returns only entries newer than the requested cursor", () => {
  let tick = 0;
  const stream = createLogStreamService({ maxEntries: 4, now: () => new Date(++tick * 1000).toISOString() });
  stream.append("host", "one\ntwo");

  const first = stream.read({ sinceCursor: 0 });
  assert.equal(first.reset, false);
  assert.equal(first.cursor, 2);
  assert.deepEqual(first.entries.map(({ cursor, source, line }) => ({ cursor, source, line })), [
    { cursor: 1, source: "host", line: "one" },
    { cursor: 2, source: "host", line: "two" },
  ]);

  const second = stream.read({ sinceCursor: first.cursor });
  assert.deepEqual(second, { cursor: 2, reset: false, entries: [] });

  stream.append("agent", "three");
  const third = stream.read({ sinceCursor: first.cursor });
  assert.equal(third.reset, false);
  assert.deepEqual(third.entries.map(({ cursor, line }) => ({ cursor, line })), [{ cursor: 3, line: "three" }]);
});

test("retention rollover declares reset and returns the current bounded window", () => {
  const stream = createLogStreamService({ maxEntries: 3, now: () => "2026-08-31T00:00:00.000Z" });
  stream.append("host", "one\ntwo\nthree");
  const before = stream.read({ sinceCursor: 0 });
  assert.equal(before.cursor, 3);

  stream.append("host", "four");
  const after = stream.read({ sinceCursor: before.cursor });
  assert.equal(after.reset, true);
  assert.equal(after.cursor, 4);
  assert.deepEqual(after.entries.map((entry) => entry.line), ["two", "three", "four"]);

  assert.deepEqual(stream.read({ sinceCursor: after.cursor }), { cursor: 4, reset: false, entries: [] });
});

test("explicit reset advances the cursor so clients replace stale local history once", () => {
  const stream = createLogStreamService({ maxEntries: 3, now: () => "2026-08-31T00:00:00.000Z" });
  stream.append("host", "one");
  const before = stream.read({ sinceCursor: 0 });
  stream.reset();

  const after = stream.read({ sinceCursor: before.cursor });
  assert.equal(after.reset, true);
  assert.equal(after.entries.length, 0);
  assert.ok(after.cursor > before.cursor);
  assert.deepEqual(stream.read({ sinceCursor: after.cursor }), { cursor: after.cursor, reset: false, entries: [] });
});

test("invalid cursors fail closed to a bounded reset snapshot", () => {
  const stream = createLogStreamService({ maxEntries: 2, now: () => "2026-08-31T00:00:00.000Z" });
  stream.append("host", "one\ntwo");
  for (const sinceCursor of [-1, 1.5, "1", null]) {
    const result = stream.read({ sinceCursor });
    assert.equal(result.reset, true);
    assert.equal(result.entries.length, 2);
  }
});
