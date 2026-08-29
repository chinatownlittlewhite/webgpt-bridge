const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const helperPath = path.join(ROOT, "src", "renderer", "log-state.js");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function loadHelper() {
  assert.equal(fs.existsSync(helperPath), true, "renderer incremental log state helper must exist");
  delete require.cache[helperPath];
  return require(helperPath);
}

function entry(seq, line = `line-${seq}`) {
  return { seq, source: "test", line, at: "2026-08-30T00:00:00.000Z" };
}

test("listener-before-snapshot bootstrap de-duplicates overlap and appends only unseen log entries", async () => {
  const { createRendererLogState } = loadHelper();
  const initial = deferred();
  let requests = 0;
  const snapshots = [];
  const appends = [];
  const state = createRendererLogState({
    capacity: 600,
    requestSnapshot: () => { requests += 1; return initial.promise; },
    onSnapshot: (entries) => snapshots.push(entries.map((item) => item.seq)),
    onAppend: (entries, metadata) => appends.push({ seqs: entries.map((item) => item.seq), metadata }),
  });

  state.handle({ kind: "append", generation: "g1", fromSeq: 1, toSeq: 2, entries: [entry(1), entry(2)] });
  const boot = state.bootstrap();
  initial.resolve({ kind: "snapshot", generation: "g1", lastSeq: 1, entries: [entry(1)] });
  await boot;

  assert.equal(requests, 1);
  assert.deepEqual(snapshots, [[1]]);
  assert.deepEqual(appends.map((item) => item.seqs), [[2]]);
  assert.deepEqual(state.getState().entries.map((item) => item.seq), [1, 2]);
  assert.equal(state.getState().lastSeq, 2);
});

test("a sequence gap requests one bounded resync while it is in flight and keeps the visible ring at 600 entries", async () => {
  const { createRendererLogState } = loadHelper();
  const resync = deferred();
  let requests = 0;
  const state = createRendererLogState({
    capacity: 600,
    requestSnapshot: () => {
      requests += 1;
      if (requests === 1) return Promise.resolve({ kind: "snapshot", generation: "g1", lastSeq: 0, entries: [] });
      return resync.promise;
    },
    onSnapshot: () => {},
    onAppend: () => {},
  });

  await state.bootstrap();
  const firstGap = state.handle({ kind: "append", generation: "g1", fromSeq: 2, toSeq: 2, entries: [entry(2)] });
  const secondGap = state.handle({ kind: "append", generation: "g1", fromSeq: 3, toSeq: 3, entries: [entry(3)] });
  assert.equal(requests, 2, "gap burst must share one in-flight snapshot request");

  const snapshotEntries = Array.from({ length: 650 }, (_, index) => entry(index + 1));
  resync.resolve({ kind: "snapshot", generation: "g1", lastSeq: 650, entries: snapshotEntries });
  await Promise.all([firstGap, secondGap]);

  const current = state.getState();
  assert.equal(requests, 2);
  assert.equal(current.entries.length, 600);
  assert.equal(current.entries[0].seq, 51);
  assert.equal(current.entries.at(-1).seq, 650);
  assert.equal(current.lastSeq, 650);
});

test("an unsolicited reset snapshot wins over an older in-flight resync response", async () => {
  const { createRendererLogState } = loadHelper();
  const staleSnapshot = deferred();
  const snapshots = [];
  const state = createRendererLogState({
    capacity: 600,
    requestSnapshot: () => staleSnapshot.promise,
    onSnapshot: (_entries, metadata) => snapshots.push(metadata.generation),
    onAppend: () => {},
  });

  const bootstrap = state.bootstrap();
  await Promise.resolve();
  await state.handle({ kind: "snapshot", generation: "g2", lastSeq: 0, entries: [] });
  staleSnapshot.resolve({ kind: "snapshot", generation: "g1", lastSeq: 1, entries: [entry(1)] });
  await bootstrap;

  const current = state.getState();
  assert.equal(current.generation, "g2");
  assert.equal(current.lastSeq, 0);
  assert.deepEqual(current.entries, []);
  assert.deepEqual(snapshots, ["g2"]);
});

test("renderer loads the recovery helper before renderer.js and updates logs incrementally", () => {
  const html = fs.readFileSync(path.join(ROOT, "src", "renderer", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(ROOT, "src", "renderer", "renderer.js"), "utf8");
  const helperIndex = html.indexOf("./log-state.js");
  const rendererIndex = html.indexOf("./renderer.js");

  assert.ok(helperIndex >= 0 && rendererIndex > helperIndex, "log-state helper must load before renderer.js");
  assert.match(renderer, /createRendererLogState/);
  assert.match(renderer, /replaceChildren/);
  assert.match(renderer, /appendChild/);
  assert.match(renderer, /scrollHeight\s*-\s*.*scrollTop/);
  assert.doesNotMatch(renderer, /renderLogs\(await api\.logs\(\)\)/);
});
