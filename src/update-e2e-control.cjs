const fs = require("node:fs");
const path = require("node:path");

const POLL_MS = 250;
const STATE_TIMEOUT_MS = 120_000;

function writeSentinel(file, payload) {
  if (!path.isAbsolute(file)) throw new Error("update E2E sentinel must be an absolute path");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({
    version: String(payload.version || ""),
    pid: Number(payload.pid || 0),
    platform: String(payload.platform || ""),
    phase: String(payload.phase || ""),
  });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function waitForState(service, predicate, timeoutMs = STATE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const state = service.getState();
      if (predicate(state)) {
        clearInterval(timer);
        resolve(state);
        return;
      }
      if (state.status === "error") {
        clearInterval(timer);
        reject(new Error(`update E2E failed: ${state.errorCode || "unknown"}`));
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`update E2E state timeout: ${state.status}`));
      }
    }, POLL_MS);
  });
}

async function runUpdateE2EControl({ packageMeta, updateService, app }) {
  if (packageMeta?.WEBGPT_UPDATE_E2E_BUILD !== true) return false;
  const expected = String(packageMeta.WEBGPT_UPDATE_E2E_EXPECTED_VERSION || "").trim();
  const sentinel = String(packageMeta.WEBGPT_UPDATE_E2E_SENTINEL || "").trim();
  if (!expected || !sentinel || !path.isAbsolute(sentinel)) throw new Error("invalid update E2E package metadata");

  const current = app.getVersion();
  const base = { version: current, pid: process.pid, platform: process.platform };
  if (current === expected) {
    writeSentinel(sentinel, { ...base, phase: "updated" });
    setTimeout(() => app.quit(), 500);
    return true;
  }

  try {
    await updateService.checkForUpdates();
    const available = await waitForState(updateService, (state) => state.status === "available");
    if (available.availableVersion !== expected) throw new Error(`unexpected E2E update version: ${available.availableVersion}`);

    await updateService.downloadUpdate();
    const downloaded = await waitForState(updateService, (state) => state.status === "downloaded");
    if (downloaded.availableVersion !== expected) throw new Error(`unexpected downloaded E2E version: ${downloaded.availableVersion}`);

    writeSentinel(sentinel, { ...base, phase: "installing" });
    await updateService.installUpdateAndRestart();
    return true;
  } catch (error) {
    writeSentinel(sentinel, { ...base, phase: "failed" });
    throw error;
  }
}

module.exports = { runUpdateE2EControl, waitForState };
