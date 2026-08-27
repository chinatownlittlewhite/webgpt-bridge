function createAppLifecycleCoordinator(options) {
  const {
    app,
    supervisor,
    disposeHostServices = async () => {},
  } = options || {};
  if (!app || typeof app.quit !== "function") throw new Error("app lifecycle requires app.quit");
  if (!supervisor || typeof supervisor.shutdown !== "function") throw new Error("app lifecycle requires supervisor.shutdown");
  if (typeof disposeHostServices !== "function") throw new Error("disposeHostServices must be a function");

  let phase = "idle";
  let settlePromise = null;

  function nativeQuitAllowed() {
    return phase === "native_quit_allowed";
  }

  function beginShutdown(reason, { requestNativeQuit }) {
    if (nativeQuitAllowed()) return settlePromise || Promise.resolve();
    if (settlePromise) return settlePromise;
    phase = "quit_requested";
    settlePromise = (async () => {
      phase = "shutting_down";
      await supervisor.shutdown(reason);
      await disposeHostServices();
      phase = "native_quit_allowed";
      if (requestNativeQuit) app.quit();
    })();
    return settlePromise;
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

module.exports = { createAppLifecycleCoordinator };
