const api = window.localAgentHost;
const ids = ["workspacePath", "runtimePath", "tunnelClientPath", "nodePath", "tunnelId", "profile", "httpsProxy", "sshAllowedHosts", "approvalMode", "runtimeKey"];
const byId = (id) => document.getElementById(id);
let updateState;

function message(text, error = false) {
  const target = byId("message");
  target.textContent = text;
  target.className = error ? "error" : "success";
}

function collect() {
  const sshAllowedHosts = byId("sshAllowedHosts").value.split(/[\n,]+/).map((host) => host.trim()).filter(Boolean);
  return {
    ...Object.fromEntries(ids.map((id) => [id, byId(id).value.trim()])),
    designIssueJournal: byId("designIssueJournal").checked,
    sshEnabled: byId("sshEnabled").checked,
    sshAllowedHosts,
  };
}

function renderStatus(status) {
  byId("serverState").textContent = status.server ? "运行中" : "未运行";
  byId("tunnelState").textContent = status.tunnel ? "已连接" : "未连接";
  byId("nextStep").textContent = status.tunnel ? "关闭窗口后继续运行" : status.server ? "正在连接 Tunnel" : "点击“启动连接”";
  const connection = byId("connection");
  connection.className = `connection ${status.tunnel ? "online" : "offline"}`;
  connection.querySelector("b").textContent = status.tunnel ? "已连接" : "未连接";
}

function renderLogs(logs) {
  byId("logOutput").textContent = logs.length ? logs.map(({ at, source, line }) => `${at.slice(11, 19)}  ${source.padEnd(12)} ${line}`).join("\n") : "尚未启动。";
  byId("logOutput").scrollTop = byId("logOutput").scrollHeight;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateHeadline(state) {
  if (state.status === "checking") return "正在检查更新…";
  if (state.status === "up_to_date") return "已是最新版本";
  if (state.status === "available") return `发现 v${state.availableVersion}`;
  if (state.status === "downloading") return `正在下载 v${state.availableVersion}`;
  if (state.status === "downloaded") return `v${state.availableVersion} 已准备好`;
  if (state.status === "installing") return "正在准备重新启动…";
  if (state.status === "error") return "更新操作未完成";
  return "应用更新";
}

function renderUpdate(state) {
  updateState = state;
  byId("updateHeadline").textContent = updateHeadline(state);
  byId("updateCurrentVersion").textContent = `当前版本 v${state.currentVersion}`;
  byId("updateNotes").hidden = !state.releaseNotes;
  byId("updateNotes").textContent = state.releaseNotes || "";

  const progress = byId("updateProgress");
  progress.hidden = state.status !== "downloading";
  byId("updateProgressBar").value = state.downloadPercent || 0;
  byId("updateMeta").textContent = state.status === "downloading"
    ? `${(state.downloadPercent || 0).toFixed(1)}% · ${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`
    : state.status === "error"
      ? (state.errorMessage || "请稍后重试。")
      : state.releaseDate && state.availableVersion
        ? `发布于 ${new Date(state.releaseDate).toLocaleDateString()}`
        : "";

  const button = byId("updateAction");
  button.disabled = state.status === "checking" || state.status === "downloading" || state.status === "installing";
  if ((state.status === "available" || state.status === "downloaded") && state.availableVersion) {
    button.textContent = `在 GitHub 下载 v${state.availableVersion}`;
  } else if (state.status === "up_to_date") {
    button.textContent = "再次检查";
  } else if (state.status === "error") {
    button.textContent = "重试";
  } else {
    button.textContent = "检查更新";
  }
}

function openAvailableRelease() {
  const version = String(updateState?.availableVersion || "").trim();
  if (!version) return false;
  const base = String(byId("updateAction").dataset.releaseBase || "");
  if (!base) return false;
  window.open(`${base}${encodeURIComponent(version)}`, "_blank", "noopener,noreferrer");
  return true;
}

async function save() {
  const saved = await api.saveSettings(collect());
  byId("runtimeKey").value = "";
  byId("keyStatus").textContent = saved.hasRuntimeKey ? "此电脑的密钥已安全保存" : "尚未保存运行时密钥";
  message("设置已保存。");
}

document.querySelectorAll("[data-picker]").forEach((button) => button.addEventListener("click", async () => {
  const selected = await api.chooseDirectory();
  if (selected) byId(button.dataset.picker).value = selected;
}));
document.querySelectorAll("[data-file-picker]").forEach((button) => button.addEventListener("click", async () => {
  const selected = await api.chooseFile();
  if (selected) byId(button.dataset.filePicker).value = selected;
}));
byId("save").addEventListener("click", () => save().catch((error) => message(error.message, true)));
byId("clearKey").addEventListener("click", () => api.clearKey().then(() => { byId("keyStatus").textContent = "运行时密钥已移除"; message("密钥已移除。"); }).catch((error) => message(error.message, true)));
byId("start").addEventListener("click", async () => { try { await save(); renderStatus(await api.start()); message("已连接。关闭窗口后会继续在菜单栏运行。"); } catch (error) { message(error.message, true); renderStatus(await api.status()); } });
byId("stop").addEventListener("click", async () => { await api.stop(); renderStatus(await api.status()); message("已停止本地服务与隧道。"); });
byId("openChatGPT").addEventListener("click", () => api.openChatGPT());
byId("updateAction").addEventListener("click", async () => {
  try {
    if (updateState?.status === "available" || updateState?.status === "downloaded") {
      if (!openAvailableRelease()) throw new Error("release unavailable");
    } else {
      await api.checkForUpdates();
    }
  } catch {
    message("更新操作失败，请重试。", true);
  }
});
api.onEvent((event) => { if (event.type === "logs") renderLogs(event.value); if (event.type === "status") renderStatus(event.value); });
api.onUpdateState(renderUpdate);

(async () => {
  const settings = await api.loadSettings();
  for (const id of ids) if (id !== "runtimeKey" && id !== "sshAllowedHosts") byId(id).value = settings[id] || "";
  byId("designIssueJournal").checked = settings.designIssueJournal === true;
  byId("sshEnabled").checked = settings.sshEnabled === true;
  byId("sshAllowedHosts").value = Array.isArray(settings.sshAllowedHosts) ? settings.sshAllowedHosts.join("\n") : "";
  byId("keyStatus").textContent = settings.hasRuntimeKey ? "此电脑的密钥已安全保存" : "尚未保存运行时密钥";
  renderStatus(await api.status());
  renderLogs(await api.logs());
  renderUpdate(await api.getUpdateState());
})();
