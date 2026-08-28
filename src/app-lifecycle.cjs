const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;

function lifecycleError(code, message, cause) {
  const error = Object.assign(new Error(message), { code });
  if (cause !== undefined) error.cause = cause;
  return error;
}

function createAppLifecycleCoordinator(options) {
  const {
    app,
    supervisor,
    disposeHostServices = async () => {},
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options || {};
  if (!app || typeof app.quit !== "function") throw new Error("app lifecycle requires app.quit");
  if (!supervisor || typeof supervisor.shutdown !== "function") throw new Error("app lifecycle requires supervisor.shutdown");
  if (typeof disposeHostServices !== "function") throw new Error("disposeHostServices must be a function");
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs <= 0) throw new Error("shutdownTimeoutMs must be positive");
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") throw new Error("app lifecycle requires timer functions");

  let phase = "idle";
  let settlePromise = null;

  function nativeQuitAllowed() {
    return phase === "native_quit_allowed";
  }

  function boundedShutdown(reason) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        reject(lifecycleError("SHUTDOWN_TIMEOUT", `Runtime shutdown exceeded ${shutdownTimeoutMs}ms`));
      }, shutdownTimeoutMs);
      timer?.unref?.();
    });
    const shutdown = Promise.resolve().then(() => supervisor.shutdown(reason));
    return Promise.race([shutdown, timeout]).finally(() => {
      if (timer !== undefined) clearTimeoutFn(timer);
    });
  }

  function beginShutdown(reason, { requestNativeQuit }) {
    if (nativeQuitAllowed()) return settlePromise || Promise.resolve();
    if (settlePromise) return settlePromise;
    phase = "quit_requested";
    const operation = (async () => {
      phase = "shutting_down";
      try {
        await boundedShutdown(reason);
        await disposeHostServices();
        phase = "native_quit_allowed";
        if (requestNativeQuit) app.quit();
      } catch (error) {
        if (!requestNativeQuit) {
          phase = "idle";
          throw error;
        }
        try {
          await disposeHostServices();
        } catch {
          // Runtime shutdown failure is the primary lifecycle result.
        }
        phase = "native_quit_allowed";
        app.quit();
        throw lifecycleError("SHUTDOWN_INCOMPLETE", "Runtime shutdown did not complete before native quit", error);
      }
    })();
    settlePromise = operation;
    if (!requestNativeQuit) {
      void operation.catch(() => {
        if (settlePromise === operation && phase === "idle") settlePromise = null;
      });
    }
    return operation;
  }

  function requestQuit(reason = "quit") {
    return beginShutdown(reason, { requestNativeQuit: true });
  }

  function prepareForUpdateInstall() {
    return beginShutdown("update-install", { requestNativeQuit: false });
  }

  function handleBeforeQuit(event) {
    if (nativeQuitAllowed()) return;
    event?.preventDefault?.();
    void requestQuit("before-quit").catch(() => {});
  }

  function whenSettled() {
    return settlePromise || Promise.resolve();
  }

  return Object.freeze({
    handleBeforeQuit,
    nativeQuitAllowed,
    prepareForUpdateInstall,
    requestQuit,
    whenSettled,
  });
}

module.exports = {
  createAppLifecycleCoordinator,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
};
