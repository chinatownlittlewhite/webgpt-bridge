function establishSingleInstanceOwnership({ app, activatePrimary } = {}) {
  if (!app || typeof app.requestSingleInstanceLock !== "function" || typeof app.quit !== "function" || typeof app.on !== "function" || typeof app.removeListener !== "function") {
    throw new TypeError("Electron app ownership API is required");
  }
  if (typeof activatePrimary !== "function") throw new TypeError("activatePrimary must be a function");

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return Object.freeze({ primary: false, dispose() {} });
  }

  const onSecondInstance = () => activatePrimary();
  app.on("second-instance", onSecondInstance);
  let disposed = false;

  return Object.freeze({
    primary: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      app.removeListener("second-instance", onSecondInstance);
    },
  });
}

module.exports = { establishSingleInstanceOwnership };
