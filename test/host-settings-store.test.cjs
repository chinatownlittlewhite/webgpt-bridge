const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadFactory() {
  return require("../src/host/settings-store.cjs").createHostSettingsStore;
}

function createFixture({ platform = "linux", encryptionAvailable = true, legacyKey = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wgb-host-settings-"));
  const userData = path.join(root, "user-data");
  const calls = [];
  const app = {
    getPath(name) {
      assert.equal(name, "userData");
      return userData;
    },
  };
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString(value) {
      return Buffer.from(`cipher:${value}`, "utf8");
    },
    decryptString(value) {
      const text = value.toString("utf8");
      assert.match(text, /^cipher:/);
      return text.slice("cipher:".length);
    },
  };
  const spawnSync = (command, argv, options) => {
    calls.push({ command, argv, options });
    return legacyKey ? { status: 0, stdout: `${legacyKey}\n` } : { status: 44, stdout: "" };
  };
  const createHostSettingsStore = loadFactory();
  const store = createHostSettingsStore({
    app,
    safeStorage,
    bundledRuntimePath: () => path.join(root, "bundled-runtime"),
    spawnSync,
    platform,
  });
  return { root, userData, calls, store };
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("host settings store round-trips only normalized persisted settings", async () => {
  const fixture = createFixture();
  try {
    const written = await fixture.store.writeSettings({
      workspacePath: "/workspace",
      runtimePath: "",
      approvalMode: "full_control",
      sshEnabled: true,
      sshAllowedHosts: ["example.internal"],
      designIssueJournal: true,
      runtimeKey: "must-not-persist",
      hasRuntimeKey: true,
      unknownField: "drop-me",
    });
    assert.equal(written.runtimePath, path.join(fixture.root, "bundled-runtime"));
    assert.equal(written.approvalMode, "full_control");
    assert.equal(written.designIssueJournal, true);

    const raw = JSON.parse(fs.readFileSync(path.join(fixture.userData, "settings.json"), "utf8"));
    assert.equal(raw.runtimeKey, undefined);
    assert.equal(raw.hasRuntimeKey, undefined);
    assert.equal(raw.unknownField, undefined);
    assert.equal(raw.workspacePath, "/workspace");

    const loaded = await fixture.store.loadSettings();
    assert.equal(loaded.runtimePath, path.join(fixture.root, "bundled-runtime"));
    assert.equal(loaded.hasRuntimeKey, false);
    assert.equal(loaded.unknownField, undefined);
  } finally {
    cleanup(fixture);
  }
});

test("runtime key is encrypted, readable, and clearable", async () => {
  const fixture = createFixture();
  try {
    const key = "1234567890abcdef";
    await fixture.store.saveRuntimeKey(key);
    const secretPath = path.join(fixture.userData, "runtime-key.bin");
    const raw = fs.readFileSync(secretPath, "utf8");
    assert.doesNotMatch(raw, new RegExp(key));
    assert.equal(await fixture.store.readRuntimeKey(), key);
    assert.equal(fixture.store.hasRuntimeKey(), true);
    await fixture.store.clearRuntimeKey();
    assert.equal(fixture.store.hasRuntimeKey(), false);
  } finally {
    cleanup(fixture);
  }
});

test("unavailable safe storage never writes a plaintext runtime key", async () => {
  const fixture = createFixture({ encryptionAvailable: false });
  try {
    await assert.rejects(() => fixture.store.saveRuntimeKey("1234567890abcdef"), /安全存储/);
    assert.equal(fs.existsSync(path.join(fixture.userData, "runtime-key.bin")), false);
  } finally {
    cleanup(fixture);
  }
});

test("legacy Keychain lookup runs only on Darwin and migrates through safe storage", async () => {
  const linux = createFixture({ platform: "linux", legacyKey: "legacy-secret-1234" });
  try {
    assert.equal(await linux.store.readRuntimeKey(), "");
    assert.equal(linux.calls.length, 0);
  } finally {
    cleanup(linux);
  }

  const darwin = createFixture({ platform: "darwin", legacyKey: "legacy-secret-1234" });
  try {
    assert.equal(await darwin.store.readRuntimeKey(), "legacy-secret-1234");
    assert.equal(darwin.calls.length, 1);
    assert.equal(darwin.calls[0].command, "/usr/bin/security");
    assert.deepEqual(darwin.calls[0].argv, ["find-generic-password", "-s", "openai-tunnel-client", "-w"]);
    assert.equal(darwin.store.hasRuntimeKey(), true);
    assert.doesNotMatch(fs.readFileSync(path.join(darwin.userData, "runtime-key.bin"), "utf8"), /legacy-secret-1234/);
  } finally {
    cleanup(darwin);
  }
});
