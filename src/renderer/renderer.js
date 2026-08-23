const api = window.localAgentHost;
const ids = ["workspacePath", "runtimePath", "tunnelClientPath", "nodePath", "tunnelId", "profile", "httpsProxy", "runtimeKey"];
const byId = (id) => document.getElementById(id);

function message(text, error = false) {
  const target = byId("message");
  target.textContent = text;
  target.className = error ? "error" : "success";
}

function collect() {
  return Object.fromEntries(ids.map((id) => [id, byId(id).value.trim()]));
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
api.onEvent((event) => { if (event.type === "logs") renderLogs(event.value); if (event.type === "status") renderStatus(event.value); });

(async () => {
  const settings = await api.loadSettings();
  for (const id of ids) if (id !== "runtimeKey") byId(id).value = settings[id] || "";
  byId("keyStatus").textContent = settings.hasRuntimeKey ? "此电脑的密钥已安全保存" : "尚未保存运行时密钥";
  renderStatus(await api.status());
  renderLogs(await api.logs());
})();
