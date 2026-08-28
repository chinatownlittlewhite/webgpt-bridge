const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createUpdateService } = require("../src/update-service.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeUpdater(options = {}) {
  const updater = new EventEmitter();
  updater.checkCalls = 0;
  updater.downloadCalls = 0;
  updater.quitAndInstallCalls = [];
  const pendingCheck = deferred();
  const pendingDownload = deferred();

  updater.checkForUpdates = () => {
    updater.checkCalls += 1;
    return options.deferredCheck ? pendingCheck.promise : Promise.resolve({ updateInfo: { version: "0.3.5" } });
  };
  updater.downloadUpdate = () => {
    updater.downloadCalls += 1;
    return options.deferredDownload ? pendingDownload.promise : Promise.resolve([]);
  };
  updater.quitAndInstall = (...args) => {
    updater.quitAndInstallCalls.push(args);
    if (options.quitError) throw options.quitError;
  };
  updater.resolveCheck = (value = { updateInfo: { version: "0.3.5" } }) => pendingCheck.resolve(value);
  updater.rejectCheck = (error) => pendingCheck.reject(error);
  updater.resolveDownload = (value = []) => pendingDownload.resolve(value);
  updater.rejectDownload = (error) => pendingDownload.reject(error);
  return updater;
}

function baseOptions(overrides = {}) {
  return {
    updater: fakeUpdater(),
    currentVersion: "0.3.4",
    isPackaged: true,
    stopRuntime: async () => {},
    setQuitting: () => {},
    emitState: () => {},
    log: () => {},
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
    ...overrides,
  };
}

test("configures stable explicit user-controlled updates", () => {
  const updater = fakeUpdater();
  createUpdateService(baseOptions({ updater }));
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoRunAppAfterInstall, true);
});

test("normalizes available progress and downloaded states", () => {
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({ updater }));
  updater.emit("update-available", {
    version: "0.3.5",
    releaseDate: "2026-08-26T00:00:00Z",
    releaseNotes: "<b>Fix</b> <script>x()</script>",
  });
  assert.equal(service.getState().status, "available");
  assert.equal(service.getState().releaseNotes, "Fix");
  assert.equal(service.getState().canDownload, true);

  updater.emit("download-progress", { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 50 });
  const progress = service.getState();
  assert.equal(progress.status, "downloading");
  assert.equal(progress.downloadPercent, 42.5);
  assert.equal(progress.downloadedBytes, 425);
  assert.equal(progress.totalBytes, 1000);
  assert.equal(progress.bytesPerSecond, 50);

  updater.emit("update-downloaded", { version: "0.3.5" });
  assert.equal(service.getState().status, "downloaded");
  assert.equal(service.getState().canInstall, true);
});

test("deduplicates simultaneous checks and downloads", async () => {
  const updater = fakeUpdater({ deferredCheck: true, deferredDownload: true });
  const service = createUpdateService(baseOptions({ updater }));
  const a = service.checkForUpdates();
  const b = service.checkForUpdates();
  assert.strictEqual(a, b);
  assert.equal(updater.checkCalls, 1);
  updater.resolveCheck();
  await a;

  updater.emit("update-available", { version: "0.3.5" });
  const c = service.downloadUpdate();
  const d = service.downloadUpdate();
  assert.strictEqual(c, d);
  assert.equal(updater.downloadCalls, 1);
  updater.resolveDownload();
  await c;
});

test("installs only after runtime shutdown and explicit request", async () => {
  const calls = [];
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({
    updater,
    stopRuntime: async () => calls.push("stop"),
    setQuitting: (value) => calls.push(`quitting:${value}`),
  }));
  updater.emit("update-downloaded", { version: "0.3.5" });
  await service.installUpdateAndRestart();
  assert.deepEqual(calls, ["stop", "quitting:true"]);
  assert.deepEqual(updater.quitAndInstallCalls, [[false, true]]);
  assert.equal(service.getState().status, "installing");
});

test("update install delegates teardown to the lifecycle preparation gate", async () => {
  const calls = [];
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({
    updater,
    stopRuntime: undefined,
    setQuitting: undefined,
    prepareForInstall: async () => calls.push("prepare"),
  }));
  updater.emit("update-downloaded", { version: "0.3.5" });
  await service.installUpdateAndRestart();
  assert.deepEqual(calls, ["prepare"]);
  assert.deepEqual(updater.quitAndInstallCalls, [[false, true]]);
  assert.equal(service.getState().status, "installing");
});

test("failed shutdown does not invoke installer", async () => {
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({ updater, stopRuntime: async () => { throw new Error("busy"); } }));
  updater.emit("update-downloaded", { version: "0.3.5" });
  await service.installUpdateAndRestart();
  assert.equal(updater.quitAndInstallCalls.length, 0);
  assert.equal(service.getState().errorCode, "shutdown_failed");
});

test("installer launch failure resets quitting intent and reports bounded error", async () => {
  const calls = [];
  const updater = fakeUpdater({ quitError: new Error("launcher exploded") });
  const service = createUpdateService(baseOptions({ updater, setQuitting: (value) => calls.push(value) }));
  updater.emit("update-downloaded", { version: "0.3.5" });
  await service.installUpdateAndRestart();
  assert.deepEqual(calls, [true, false]);
  assert.equal(service.getState().errorCode, "install_launch_failed");
});

test("maps network checksum signature publisher and download failures", () => {
  const cases = [
    ["getaddrinfo ENOTFOUND github.com", "network_unavailable"],
    ["sha512 checksum mismatch", "checksum_mismatch"],
    ["downloaded file has invalid Authenticode signature", "signature_invalid"],
    ["installer is not signed by expected publisher", "publisher_mismatch"],
    ["download failed with status 500", "download_failed"],
  ];
  for (const [message, code] of cases) {
    const updater = fakeUpdater();
    const service = createUpdateService(baseOptions({ updater }));
    updater.emit("error", new Error(message));
    assert.equal(service.getState().errorCode, code, message);
  }
});

test("bounds release notes error text and numeric progress", () => {
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({ updater }));
  updater.emit("update-available", { version: "0.3.5", releaseNotes: `<style>x</style>${"a".repeat(5000)}` });
  assert.equal(service.getState().releaseNotes.length, 4000);
  updater.emit("download-progress", { percent: 900, transferred: -12, total: -4, bytesPerSecond: -3 });
  const state = service.getState();
  assert.equal(state.downloadPercent, 100);
  assert.equal(state.downloadedBytes, 0);
  assert.equal(state.totalBytes, 0);
  assert.equal(state.bytesPerSecond, 0);
  updater.emit("error", new Error("x".repeat(1000)));
  assert.equal(service.getState().errorMessage.length, 300);
});

test("returns frozen independent snapshots", () => {
  const service = createUpdateService(baseOptions());
  const a = service.getState();
  const b = service.getState();
  assert.equal(Object.isFrozen(a), true);
  assert.notStrictEqual(a, b);
  a.status = "owned";
  assert.equal(a.status, "idle");
  assert.equal(service.getState().status, "idle");
});

test("schedules a startup check after ten seconds and six-hour periodic checks", () => {
  const scheduled = [];
  const intervals = [];
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({
    updater,
    setTimeoutFn: (fn, ms) => { scheduled.push({ fn, ms }); return { unref() {} }; },
    clearTimeoutFn: () => {},
    setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return { unref() {} }; },
    clearIntervalFn: () => {},
  }));
  service.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 10_000);
  scheduled[0].fn();
  assert.equal(updater.checkCalls, 1);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 21_600_000);
});

test("non-packaged service does not schedule or query public updates", () => {
  let timers = 0;
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({
    updater,
    isPackaged: false,
    setTimeoutFn: () => { timers += 1; return {}; },
  }));
  service.start();
  assert.equal(timers, 0);
  assert.equal(updater.checkCalls, 0);
  const state = service.checkForUpdates();
  assert.equal(state.status, "error");
  assert.equal(state.errorCode, "unsupported_environment");
});

test("retry from error rechecks metadata instead of downloading stale state", async () => {
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({ updater }));
  updater.emit("error", new Error("network offline"));
  assert.equal(service.getState().canRetry, true);
  await service.checkForUpdates();
  assert.equal(updater.checkCalls, 1);
  assert.equal(updater.downloadCalls, 0);
});
