const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { normalizeSettings } = require("../host-config.cjs");

function createHostSettingsStore({ app, safeStorage, bundledRuntimePath, spawnSync, platform = process.platform }) {
  function configPath() {
    return path.join(app.getPath("userData"), "settings.json");
  }

  function secretPath() {
    return path.join(app.getPath("userData"), "runtime-key.bin");
  }

  function defaultSettings() {
    return {
      workspacePath: "",
      runtimePath: bundledRuntimePath(),
      agentMode: "bundled",
      developmentPath: "",
      tunnelClientPath: "",
      nodePath: "",
      tunnelId: "",
      profile: "webgpt-bridge",
      httpsProxy: "",
      sshEnabled: false,
      sshAllowedHosts: [],
      approvalMode: "development",
      designIssueJournal: false,
    };
  }

  function hasRuntimeKey() {
    return fs.existsSync(secretPath());
  }

  async function loadSettings() {
    try {
      const parsed = JSON.parse(await fsp.readFile(configPath(), "utf8"));
      const settings = normalizeSettings(parsed, defaultSettings());
      return { ...settings, runtimePath: settings.runtimePath || bundledRuntimePath(), hasRuntimeKey: hasRuntimeKey() };
    } catch {
      return { ...defaultSettings(), hasRuntimeKey: hasRuntimeKey() };
    }
  }

  async function writeSettings(input) {
    const settings = { ...normalizeSettings(input, defaultSettings()), runtimePath: input.runtimePath || bundledRuntimePath() };
    delete settings.runtimeKey;
    delete settings.hasRuntimeKey;
    await fsp.mkdir(app.getPath("userData"), { recursive: true });
    await fsp.writeFile(configPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
    return settings;
  }

  async function saveRuntimeKey(key) {
    if (typeof key !== "string" || key.length < 16) throw new Error("运行时密钥为空或格式不正确。");
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用；不会将密钥保存为明文。");
    }
    await fsp.mkdir(app.getPath("userData"), { recursive: true });
    await fsp.writeFile(secretPath(), safeStorage.encryptString(key).toString("base64"), { mode: 0o600 });
  }

  async function migrateLegacyMacKey() {
    if (platform !== "darwin") return "";
    const result = spawnSync("/usr/bin/security", ["find-generic-password", "-s", "openai-tunnel-client", "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const legacyKey = result.status === 0 ? result.stdout.trim() : "";
    if (!legacyKey) return "";
    await saveRuntimeKey(legacyKey);
    return legacyKey;
  }

  async function readRuntimeKey() {
    if (hasRuntimeKey()) {
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储不可用，无法读取运行时密钥。");
        const encrypted = Buffer.from(await fsp.readFile(secretPath(), "utf8"), "base64");
        return safeStorage.decryptString(encrypted);
      } catch {
        const migrated = await migrateLegacyMacKey();
        if (migrated) return migrated;
        throw new Error("无法读取已保存的运行时密钥。请在高级设置中重新保存此电脑的密钥。");
      }
    }
    return migrateLegacyMacKey();
  }

  async function clearRuntimeKey() {
    await fsp.rm(secretPath(), { force: true });
    return { hasRuntimeKey: false };
  }

  return Object.freeze({
    configPath,
    secretPath,
    defaultSettings,
    hasRuntimeKey,
    loadSettings,
    writeSettings,
    saveRuntimeKey,
    readRuntimeKey,
    clearRuntimeKey,
  });
}

module.exports = { createHostSettingsStore };
