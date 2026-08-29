const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createGitHubHealthProbe } = require("../src/github-health-probe.cjs");
const { createHostLogBuffer } = require("../src/host-log-buffer.cjs");

const ROOT = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("GitHub health never runs gh auth status synchronously on the Electron main thread", () => {
  const broker = read("src/host/broker-server.cjs");
  const main = read("src/main.cjs");
  const brokerCall = main.match(/const hostBroker = createHostBrokerServer\(\{([\s\S]*?)\n\}\);/);

  assert.match(broker, /createGitHubHealthProbe/);
  assert.doesNotMatch(broker, /spawnSync\(githubCliPath\s*,\s*\[\s*["']auth["']\s*,\s*["']status["']\s*\]/);
  assert.ok(brokerCall, "Desktop must construct the Host broker explicitly");
  assert.doesNotMatch(brokerCall[1], /\bspawnSync\b/);
});

test("async GitHub health keeps connectivity binary readiness and authentication as distinct bounded facts", () => {
  const modulePath = path.join(ROOT, "src", "github-health-probe.cjs");
  assert.equal(fs.existsSync(modulePath), true, "Stage 12 requires a dedicated async GitHub health helper");
  const source = fs.readFileSync(modulePath, "utf8");

  assert.match(source, /execFile/);
  assert.match(source, /timeoutMs/);
  assert.match(source, /maxBuffer/);
  assert.match(source, /connectivity/);
  assert.match(source, /binaryReady/);
  assert.match(source, /authenticated/);
  assert.doesNotMatch(source, /spawnSync/);
});

test("GitHub health executes auth asynchronously with a bounded shellless invocation", async () => {
  let observed;
  const probe = createGitHubHealthProbe({
    tcpProbe: async (target) => {
      assert.deepEqual(target, { host: "github.com", port: 443 });
      return { ok: true };
    },
    execFileImpl: (file, argv, options, callback) => {
      observed = { file, argv, options };
      queueMicrotask(() => callback(null, "", ""));
    },
    timeoutMs: 4_321,
  });

  const result = await probe({ githubCliPath: "/trusted/gh" });
  assert.equal(observed.file, "/trusted/gh");
  assert.deepEqual(observed.argv, ["auth", "status"]);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.equal(observed.options.timeout, 4_321);
  assert.ok(observed.options.maxBuffer <= 64 * 1024);
  assert.deepEqual(result, {
    ok: true,
    connectivity: true,
    binaryReady: true,
    authenticated: true,
  });
});

test("GitHub health distinguishes missing CLI, unauthenticated CLI, and failed connectivity", async () => {
  const missing = createGitHubHealthProbe({
    tcpProbe: async () => ({ ok: true }),
    execFileImpl: (_file, _argv, _options, callback) => callback(Object.assign(new Error("missing"), { code: "ENOENT" })),
  });
  assert.deepEqual(await missing({ githubCliPath: "/missing/gh" }), {
    ok: false,
    connectivity: true,
    binaryReady: false,
    authenticated: false,
  });

  const unauthenticated = createGitHubHealthProbe({
    tcpProbe: async () => ({ ok: true }),
    execFileImpl: (_file, _argv, _options, callback) => callback(Object.assign(new Error("not logged in"), { code: 1 })),
  });
  assert.deepEqual(await unauthenticated({ githubCliPath: "/trusted/gh" }), {
    ok: false,
    connectivity: true,
    binaryReady: true,
    authenticated: false,
  });

  const offline = createGitHubHealthProbe({
    tcpProbe: async () => ({ ok: false, error: "offline" }),
    execFileImpl: (_file, _argv, _options, callback) => callback(null, "", ""),
  });
  assert.deepEqual(await offline({ githubCliPath: "/trusted/gh" }), {
    ok: false,
    connectivity: false,
    binaryReady: true,
    authenticated: true,
  });
});

test("Host logs use one bounded snapshot and monotonic append protocol instead of full-ring retransmission", () => {
  const main = read("src/main.cjs");
  const ipc = read("src/host/ipc-controller.cjs");

  assert.match(main, /createHostLogBuffer/);
  assert.doesNotMatch(main, /let\s+logLines\s*=\s*\[\]/);
  assert.doesNotMatch(main, /emit\(["']logs["']\s*,\s*logLines\s*\)/);
  assert.match(main, /\.subscribe\(.*?emit\(["']logs["']/s);
  assert.match(ipc, /host:logs/);
});

test("Host log buffer emits new-only contiguous batches and bounds its snapshot ring", async () => {
  const events = [];
  const buffer = createHostLogBuffer({
    capacity: 2,
    maxBatchEntries: 2,
    maxBatchBytes: 64 * 1024,
    now: () => "2026-08-30T00:00:00.000Z",
    createGeneration: () => "g1",
  });
  buffer.subscribe((event) => events.push(event));

  buffer.append("agent", "one\ntwo\nthree");
  await Promise.resolve();

  assert.equal(events.length, 2);
  assert.deepEqual(events.map(({ kind, generation, fromSeq, toSeq, entries }) => ({
    kind,
    generation,
    fromSeq,
    toSeq,
    seqs: entries.map((entry) => entry.seq),
  })), [
    { kind: "append", generation: "g1", fromSeq: 1, toSeq: 2, seqs: [1, 2] },
    { kind: "append", generation: "g1", fromSeq: 3, toSeq: 3, seqs: [3] },
  ]);

  const snapshot = buffer.snapshot();
  assert.equal(snapshot.kind, "snapshot");
  assert.equal(snapshot.generation, "g1");
  assert.equal(snapshot.lastSeq, 3);
  assert.deepEqual(snapshot.entries.map((entry) => entry.seq), [2, 3]);
});

test("Host log reset changes generation, restarts sequence, and cancels stale queued batches", async () => {
  const generations = ["g1", "g2"];
  const events = [];
  const buffer = createHostLogBuffer({
    capacity: 600,
    now: () => "2026-08-30T00:00:00.000Z",
    createGeneration: () => generations.shift(),
  });
  buffer.subscribe((event) => events.push(event));

  buffer.append("agent", "stale-before-reset");
  const reset = buffer.reset();
  buffer.append("agent", "fresh-after-reset");
  await Promise.resolve();

  assert.deepEqual(reset, { kind: "snapshot", generation: "g2", lastSeq: 0, entries: [] });
  assert.equal(events.some((event) => event.kind === "append" && event.generation === "g1"), false);
  const fresh = events.find((event) => event.kind === "append");
  assert.equal(fresh.generation, "g2");
  assert.equal(fresh.fromSeq, 1);
  assert.equal(fresh.toSeq, 1);
  assert.equal(fresh.entries[0].line, "fresh-after-reset");
});

test("Host log buffer explicitly truncates oversized lines within its byte budget", async () => {
  const events = [];
  const buffer = createHostLogBuffer({
    capacity: 600,
    maxLineBytes: 32,
    now: () => "2026-08-30T00:00:00.000Z",
    createGeneration: () => "g1",
  });
  buffer.subscribe((event) => events.push(event));
  buffer.append("agent", "x".repeat(200));
  await Promise.resolve();

  const line = events[0].entries[0].line;
  assert.match(line, /\[truncated\]$/);
  assert.ok(Buffer.byteLength(line, "utf8") <= 32);
});
