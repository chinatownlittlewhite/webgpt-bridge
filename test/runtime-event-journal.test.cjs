const test = require("node:test");
const assert = require("node:assert/strict");
const { createRuntimeEventJournal } = require("../src/host/runtime-event-journal.cjs");

test("runtime event journal persists a bounded redacted status history", () => {
  let stored = "";
  const journal = createRuntimeEventJournal({
    filePath: "/virtual/runtime-events.json",
    maxEntries: 2,
    now: () => "2026-09-16T05:00:00.000Z",
    readFile: () => stored,
    writeFile: (_path, data) => { stored = data; },
  });

  journal.append({
    state: "degraded", agentHealth: "ready", tunnelReadiness: "failed",
    transitionId: 11,
    lastExitReason: { code: "TUNNEL_HEALTH_FAILED", kind: "tunnel", failures: 2, message: "secret proxy http://user:pass@host" },
  });
  journal.append({ state: "tunnel_starting", agentHealth: "ready", tunnelReadiness: "starting", transitionId: 12, lastExitReason: null });
  journal.append({ state: "connected", agentHealth: "ready", tunnelReadiness: "ready", transitionId: 13, lastExitReason: null });

  const saved = JSON.parse(stored);
  assert.equal(saved.length, 2);
  assert.deepEqual(saved.map((entry) => entry.transitionId), [12, 13]);
  assert.deepEqual(Object.keys(saved[0]).sort(), ["agentHealth", "at", "reason", "state", "transitionId", "tunnelReadiness"].sort());
  assert.equal(stored.includes("secret"), false);
  assert.equal(stored.includes("pass@host"), false);
});

test("runtime event journal persists only allowlisted reason fields", () => {
  let stored = "";
  const journal = createRuntimeEventJournal({
    filePath: "/virtual/runtime-events.json",
    readFile: () => stored,
    writeFile: (_path, data) => { stored = data; },
  });
  journal.append({
    state: "degraded", agentHealth: "ready", tunnelReadiness: "failed", transitionId: 7,
    lastExitReason: { code: "TUNNEL_HEALTH_FAILED", kind: "tunnel", failures: 2, exitCode: 1, signal: "SIGTERM", message: "do not persist" },
  });
  const [entry] = JSON.parse(stored);
  assert.deepEqual(entry.reason, { code: "TUNNEL_HEALTH_FAILED", kind: "tunnel", failures: 2, exitCode: 1, signal: "SIGTERM" });
});
