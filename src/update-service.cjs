const MAX_RELEASE_NOTES = 4000;
const MAX_ERROR_MESSAGE = 300;
const STARTUP_CHECK_DELAY_MS = 10_000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

function normalizeReleaseNotes(value) {
  const raw = Array.isArray(value)
    ? value.map((item) => typeof item === "string" ? item : item?.note || "").join("\n")
    : String(value || "");
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_RELEASE_NOTES);
}

function classifyUpdateError(error) {
  const text = String(error?.message || error || "");
  const lower = text.toLowerCase();
  let code = "metadata_unavailable";
  if (/enotfound|econnreset|etimedout|network|offline/.test(lower)) code = "network_unavailable";
  else if (/sha512|checksum|digest/.test(lower)) code = "checksum_mismatch";
  else if (/publisher|not signed by|certificate subject/.test(lower)) code = "publisher_mismatch";
  else if (/signature|authenticode/.test(lower)) code = "signature_invalid";
  else if (/download/.test(lower)) code = "download_failed";
  else if (/yaml|metadata.*invalid|invalid.*metadata|parse/.test(lower)) code = "metadata_invalid";
  return {
    code,
    message: text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE) || "更新操作失败。",
  };
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function percent(value) {
  return Math.min(100, nonNegative(value));
}

function makeState(status, fields = {}) {
  return {
    status,
    currentVersion: String(fields.currentVersion || ""),
    availableVersion: String(fields.availableVersion || ""),
    releaseDate: String(fields.releaseDate || ""),
    releaseNotes: String(fields.releaseNotes || "").slice(0, MAX_RELEASE_NOTES),
    downloadPercent: percent(fields.downloadPercent),
    downloadedBytes: nonNegative(fields.downloadedBytes),
    totalBytes: nonNegative(fields.totalBytes),
    bytesPerSecond: nonNegative(fields.bytesPerSecond),
    errorCode: String(fields.errorCode || ""),
    errorMessage: String(fields.errorMessage || "").slice(0, MAX_ERROR_MESSAGE),
    canCheck: status === "idle" || status === "up_to_date" || status === "available" || status === "error",
    canDownload: status === "available",
    canInstall: status === "downloaded",
    canRetry: status === "error",
  };
}

function snapshot(state) {
  return Object.freeze({ ...state });
}

function createUpdateService(options) {
  const {
    updater,
    currentVersion,
    isPackaged,
    prepareForInstall,
    stopRuntime,
    setQuitting,
    emitState = () => {},
    log = () => {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;
  const prepareInstall = typeof prepareForInstall === "function" ? prepareForInstall : stopRuntime;
  const setQuittingIntent = typeof setQuitting === "function" ? setQuitting : () => {};

  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.autoRunAppAfterInstall = true;

  let state = makeState("idle", { currentVersion });
  let checkPromise = null;
  let downloadPromise = null;
  let startupTimer = null;
  let periodicTimer = null;
  const handlers = new Map();

  function publish(next) {
    state = makeState(next.status, { ...state, ...next, currentVersion });
    const value = snapshot(state);
    emitState(value);
    log(`update:${value.status}${value.availableVersion ? `:${value.availableVersion}` : ""}`);
    return value;
  }

  function publishError(error) {
    const normalized = classifyUpdateError(error);
    return publish({ status: "error", errorCode: normalized.code, errorMessage: normalized.message });
  }

  function publishAvailable(info = {}) {
    return publish({
      status: "available",
      availableVersion: info.version || state.availableVersion,
      releaseDate: info.releaseDate || "",
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      downloadPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      errorCode: "",
      errorMessage: "",
    });
  }

  function publishUpToDate() {
    return publish({
      status: "up_to_date",
      availableVersion: "",
      releaseDate: "",
      releaseNotes: "",
      downloadPercent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      errorCode: "",
      errorMessage: "",
    });
  }

  function on(name, handler) {
    handlers.set(name, handler);
    updater.on(name, handler);
  }

  on("checking-for-update", () => publish({ status: "checking", errorCode: "", errorMessage: "" }));
  on("update-available", (info = {}) => publishAvailable(info));
  on("update-not-available", () => publishUpToDate());
  on("download-progress", (progress = {}) => publish({
    status: "downloading",
    downloadPercent: percent(progress.percent),
    downloadedBytes: nonNegative(progress.transferred),
    totalBytes: nonNegative(progress.total),
    bytesPerSecond: nonNegative(progress.bytesPerSecond),
    errorCode: "",
    errorMessage: "",
  }));
  on("update-downloaded", (info = {}) => publish({
    status: "downloaded",
    availableVersion: info.version || state.availableVersion,
    downloadPercent: 100,
    errorCode: "",
    errorMessage: "",
  }));
  on("update-cancelled", () => publish({ status: "error", errorCode: "download_failed", errorMessage: "更新下载已取消。" }));
  on("error", (error) => publishError(error));

  function getState() {
    return snapshot(state);
  }

  function settleCheckResult(result) {
    if (state.status !== "checking") return snapshot(state);
    const info = result?.updateInfo || {};
    if (result?.isUpdateAvailable === false || (info.version && String(info.version) === String(currentVersion))) {
      return publishUpToDate();
    }
    if (result?.isUpdateAvailable === true || info.version) {
      return publishAvailable(info);
    }
    return publishError(new Error("更新检查没有返回可用的版本状态。"));
  }

  function checkForUpdates() {
    if (!isPackaged) {
      return publish({ status: "error", errorCode: "unsupported_environment", errorMessage: "更新检查仅在已安装版本中可用。" });
    }
    if (checkPromise) return checkPromise;
    publish({ status: "checking", errorCode: "", errorMessage: "" });
    let result;
    try {
      result = updater.checkForUpdates();
    } catch (error) {
      return Promise.resolve(publishError(error));
    }
    checkPromise = Promise.resolve(result)
      .then((value) => settleCheckResult(value))
      .catch((error) => publishError(error))
      .finally(() => { checkPromise = null; });
    return checkPromise;
  }

  function downloadUpdate() {
    if (state.status !== "available") return snapshot(state);
    if (downloadPromise) return downloadPromise;
    let result;
    try {
      result = updater.downloadUpdate();
    } catch (error) {
      return Promise.resolve(publishError(error));
    }
    downloadPromise = Promise.resolve(result)
      .catch((error) => publishError(error))
      .finally(() => { downloadPromise = null; });
    return downloadPromise;
  }

  async function installUpdateAndRestart() {
    if (state.status !== "downloaded") return snapshot(state);
    try {
      await prepareInstall();
    } catch (error) {
      return publish({
        status: "error",
        errorCode: "shutdown_failed",
        errorMessage: String(error?.message || error).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE),
      });
    }

    setQuittingIntent(true);
    publish({ status: "installing", errorCode: "", errorMessage: "" });
    try {
      updater.quitAndInstall(false, true);
    } catch (error) {
      setQuittingIntent(false);
      return publish({
        status: "error",
        errorCode: "install_launch_failed",
        errorMessage: String(error?.message || error).replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE),
      });
    }
    return snapshot(state);
  }

  function start() {
    if (!isPackaged || startupTimer) return;
    startupTimer = setTimeoutFn(() => {
      void checkForUpdates();
      periodicTimer = setIntervalFn(() => { void checkForUpdates(); }, PERIODIC_CHECK_MS);
      periodicTimer?.unref?.();
    }, STARTUP_CHECK_DELAY_MS);
    startupTimer?.unref?.();
  }

  function dispose() {
    if (startupTimer) clearTimeoutFn(startupTimer);
    if (periodicTimer) clearIntervalFn(periodicTimer);
    startupTimer = null;
    periodicTimer = null;
    for (const [name, handler] of handlers) updater.removeListener(name, handler);
    handlers.clear();
  }

  return {
    start,
    dispose,
    getState,
    checkForUpdates,
    downloadUpdate,
    installUpdateAndRestart,
  };
}

module.exports = {
  createUpdateService,
  normalizeReleaseNotes,
  classifyUpdateError,
  STARTUP_CHECK_DELAY_MS,
  PERIODIC_CHECK_MS,
};
