function createTrayController({ Tray, Menu, nativeImage, trayIconDataUrl, platform = process.platform, getStatus, getUpdateState, showWindow, start, stop, requestQuit, appendLog }) {
  let trayRef;

  function trayIcon() {
    const image = nativeImage.createFromDataURL(trayIconDataUrl(platform));
    if (image.isEmpty()) throw new Error("无法创建系统托盘图标。");
    if (platform === "darwin") image.setTemplateImage(true);
    return image;
  }

  function dockIcon() {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><defs><linearGradient id="b" x1="180" y1="96" x2="850" y2="920"><stop stop-color="#26312e"/><stop offset="1" stop-color="#0d1211"/></linearGradient><linearGradient id="a" x1="322" y1="384" x2="712" y2="650"><stop stop-color="#cff9e9"/><stop offset="1" stop-color="#56d6ae"/></linearGradient></defs><rect width="1024" height="1024" rx="226" fill="url(#b)"/><path d="M282 596c0-88 71-159 159-159h64" fill="none" stroke="#f3f7f5" stroke-width="92" stroke-linecap="round"/><path d="M742 428c0 88-71 159-159 159h-64" fill="none" stroke="url(#a)" stroke-width="92" stroke-linecap="round"/><circle cx="282" cy="596" r="62" fill="#f3f7f5"/><circle cx="742" cy="428" r="62" fill="#56d6ae"/></svg>`;
    return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  }

  function updateTray() {
    if (!trayRef) return;
    const status = getStatus();
    const connected = status.connected;
    const update = getUpdateState?.();
    const updateItem = update?.status === "downloaded"
      ? { label: `更新已下载 · v${update.availableVersion}`, enabled: false }
      : update?.status === "available"
        ? { label: `发现更新 · v${update.availableVersion}`, enabled: false }
        : null;
    trayRef.setToolTip(`WebGPT Bridge · ${connected ? "已连接" : "未连接"}`);
    trayRef.setContextMenu(Menu.buildFromTemplate([
      { label: connected ? "已连接到 ChatGPT" : "未连接", enabled: false },
      ...(updateItem ? [updateItem] : []),
      { type: "separator" },
      { label: "显示控制器", click: showWindow },
      {
        label: "启动连接",
        enabled: !connected,
        click: () => start().catch((error) => appendLog("host", `启动失败：${error.message}`)),
      },
      { label: "停止服务", enabled: status.server || status.tunnel, click: () => { void stop("tray"); } },
      { type: "separator" },
      {
        label: "退出 WebGPT Bridge",
        click: () => {
          void requestQuit("tray-quit").catch((error) => appendLog("host", `${error.code || "SHUTDOWN_FAILED"}：${error.message}`));
        },
      },
    ]));
  }

  function createTray() {
    trayRef = new Tray(trayIcon());
    trayRef.on("click", showWindow);
    updateTray();
    return trayRef;
  }

  function dispose() {
    trayRef?.destroy?.();
    trayRef = undefined;
  }

  return Object.freeze({ trayIcon, dockIcon, updateTray, createTray, dispose });
}

module.exports = { createTrayController };
