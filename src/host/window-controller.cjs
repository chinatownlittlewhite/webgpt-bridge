function createWindowController({ BrowserWindow, shell, preloadPath, rendererPath, platform = process.platform, nativeQuitAllowed }) {
  let windowRef;

  function getWindow() {
    return windowRef;
  }

  function dialogOwner() {
    return windowRef && !windowRef.isDestroyed() ? windowRef : undefined;
  }

  function createWindow() {
    windowRef = new BrowserWindow({
      width: 720,
      height: 660,
      minWidth: 560,
      minHeight: 540,
      backgroundColor: "#edf1ef",
      titleBarStyle: platform === "darwin" ? "hiddenInset" : "default",
      ...(platform === "darwin" ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    windowRef.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    windowRef.webContents.on("will-navigate", (event) => event.preventDefault());
    windowRef.on("close", (event) => {
      if (nativeQuitAllowed()) return;
      event.preventDefault();
      windowRef.hide();
    });
    windowRef.on("closed", () => { windowRef = undefined; });
    windowRef.loadFile(rendererPath);
    return windowRef;
  }

  function showWindow() {
    if (!windowRef || windowRef.isDestroyed()) createWindow();
    if (windowRef.isMinimized()) windowRef.restore();
    windowRef.show();
    windowRef.focus();
    return windowRef;
  }

  return Object.freeze({ createWindow, showWindow, getWindow, dialogOwner });
}

module.exports = { createWindowController };
