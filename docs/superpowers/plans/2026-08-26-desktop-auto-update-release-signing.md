# Desktop Auto-Update, Release, and Signing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-controlled in-app updates for Windows and macOS, publish only fully signed/notarized GitHub Releases, produce a real Universal macOS build, and preserve the existing Windows AppContainer host-preparation lifecycle during upgrades.

**Architecture:** A focused `src/update-service.cjs` owns `electron-updater` state and exposes a narrow main-process interface; preload/renderer only request state transitions and never control feed URLs or installer paths. Packaging moves to a testable Electron Builder config module, formal releases use a draft-first GitHub Actions workflow with platform-native signing and validation, and the existing Windows installer lifecycle smoke is extracted into a reusable script shared by PR and release CI.

**Tech Stack:** Electron 40, `electron-builder@26.15.3`, `electron-updater@6.8.9`, Node.js 22, NSIS per-machine x64, Microsoft Artifact Signing / Trusted Signing via GitHub OIDC, Apple Developer ID + notarization, GitHub Releases, GitHub Actions, `js-yaml@4.1.0` for release-manifest validation.

**Spec:** `docs/superpowers/specs/2026-08-26-desktop-auto-update-release-signing-design.md`

## Global Constraints

- Public update source is fixed to GitHub repository `chinatownlittlewhite/webgpt-bridge`; renderer/settings never choose a feed URL or repository.
- Root `package.json.version` is the sole desktop version authority; formal tag must equal `v${version}`.
- Stable channel only: `allowPrerelease = false`; downgrade disabled: `allowDowngrade = false`.
- Published stable dependencies for this implementation are pinned to `electron-builder@26.15.3` and `electron-updater@6.8.9`. Do not implement against unreleased v27 APIs.
- With `electron-updater@6.8.9`, explicit/manual installation is expressed as `autoUpdater.autoInstallOnAppQuit = false`; explicit install uses `autoUpdater.quitAndInstall(false, true)` after the app has completed its own shutdown preflight.
- `autoDownload = false`. Normal application quit must never install a pending downloaded update.
- Real update checks only run in packaged builds; development tests inject a fake updater adapter and never query GitHub.
- Windows remains x64, per-machine NSIS, fixed Program Files install root, no formal portable ZIP while SYSTEM host-preparation is required.
- Updater code never invokes `windows-host-prep --apply` or `--remove`, never creates/deletes the SYSTEM task, and never modifies `NUL`; NSIS remains the privileged upgrade boundary.
- Windows `verifyUpdateCodeSignature` stays enabled. Formal builds must embed one exact expected publisher from `WEBGPT_WINDOWS_PUBLISHER`.
- Formal Windows signing uses v26 `win.azureSignOptions` and GitHub OIDC workload identity through `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and an ephemeral `AZURE_FEDERATED_TOKEN_FILE`; no Azure client secret is required by the design.
- macOS formal target is `--universal` and produces both DMG and ZIP from the same signed/notarized app.
- macOS formal signing uses Developer ID Application, Hardened Runtime, notarization, and Gatekeeper verification. Production does not add `com.apple.security.cs.disable-library-validation` merely to make signing pass.
- Formal signing/notarization credentials are unavailable to PR jobs and packaged clients.
- Draft GitHub Release is the publication isolation boundary. A release becomes public only after both platform gates and local release-asset validation pass.
- No unsigned/unnotarized fallback is permitted in the formal release workflow.
- Published versions are immutable; a bad public release is repaired by a higher version, never by replacing public bytes or forced downgrade.
- Existing Agent public 23-tool surface and Windows AppContainer security boundaries remain unchanged.

---

## File Structure Locked by This Plan

### New focused modules

- `src/update-service.cjs` — pure, dependency-injected update state machine; no direct renderer access.
- `build/electron-builder-options.cjs` — testable function that returns Electron Builder configuration from environment.
- `electron-builder.config.cjs` — thin production adapter that exports `createBuilderConfig(process.env)`.
- `build/entitlements.mac.plist` — minimal Hardened Runtime entitlements required by Electron.
- `scripts/windows-installer-smoke.ps1` — reusable real NSIS install/task/uninstall lifecycle test.
- `scripts/release-contract.cjs` — pure version/manifest/hash validation helpers.
- `scripts/verify-release-tag.cjs` — CI CLI for exact tag/package version validation.
- `scripts/validate-release-assets.cjs` — CI CLI for update metadata/assets/hashes.
- `scripts/write-release-checksums.cjs` — emits deterministic `SHA256SUMS` for user-facing artifacts.
- `.github/workflows/release-desktop.yml` — formal draft-first signed/notarized release workflow.
- `docs/release-signing.md` — exact external environment/secret provisioning contract.

### New tests

- `test/update-service.test.cjs` — state machine, scheduling, sanitization, dedupe, install shutdown behavior.
- `test/update-boundary.test.cjs` — main/preload IPC and no arbitrary feed/path surface.
- `test/release-contract.test.cjs` — tag/version, YAML/hash/asset validation helpers.
- `test/release-workflow.test.cjs` — release workflow privilege/signing/draft/publication invariants.

### Existing files modified

- `package.json`, `package-lock.json` — dependencies/scripts; move static `build` object to JS config.
- `src/main.cjs` — updater lifecycle integration, bounded IPC, tray status, update-install shutdown preflight.
- `src/preload.cjs` — five narrow updater methods/event.
- `src/renderer/index.html`, `src/renderer/renderer.js`, `src/renderer/styles.css` — update card and progress/error state.
- `.github/workflows/build-desktop.yml` — PR/manual build only; call reusable Windows installer smoke; no formal tag publishing.
- `test/package-content.test.cjs` — package/build config and existing installer smoke assertions updated to reusable script.
- `README.md` — user-facing check/update behavior and signed release expectation.

---

### Task 1: Pin updater dependencies and make packaging configuration testable

**Files:**
- Create: `build/electron-builder-options.cjs`
- Create: `electron-builder.config.cjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `test/package-content.test.cjs`

**Interfaces:**
- Consumes: root package metadata and environment variables.
- Produces: `createBuilderConfig(env): object` in `build/electron-builder-options.cjs`; root Electron Builder config imports it.
- Environment contract produced for later tasks: `WEBGPT_FORMAL_RELEASE` is empty for ordinary builds and exactly `windows` or `macos` for formal platform builds; platform-specific identity variables are `WEBGPT_WINDOWS_PUBLISHER`, `WEBGPT_WINDOWS_SIGN_ENDPOINT`, `WEBGPT_WINDOWS_SIGN_ACCOUNT`, `WEBGPT_WINDOWS_SIGN_PROFILE`, and `WEBGPT_MAC_IDENTITY`.

- [ ] **Step 1: Add failing package/config tests**

Add assertions to `test/package-content.test.cjs`:

```js
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");

test("desktop updater dependencies are pinned to the published stable v26 line", () => {
  assert.equal(packageJson.dependencies["electron-updater"], "6.8.9");
  assert.equal(packageJson.devDependencies["electron-builder"], "26.15.3");
  assert.equal(packageJson.devDependencies["js-yaml"], "4.1.0");
});

test("builder config fixes GitHub update source and platform targets", () => {
  const config = createBuilderConfig({});
  assert.deepEqual(config.publish, [{ provider: "github", owner: "chinatownlittlewhite", repo: "webgpt-bridge", releaseType: "draft" }]);
  assert.deepEqual(config.win.target, ["nsis"]);
  assert.equal(config.win.verifyUpdateCodeSignature, true);
  assert.equal(config.nsis.perMachine, true);
  assert.equal(config.nsis.allowToChangeInstallationDirectory, false);
  assert.deepEqual(config.mac.target, ["dmg", "zip"]);
});

test("formal builder config scopes credentials to one platform and fails closed", () => {
  assert.throws(() => createBuilderConfig({ WEBGPT_FORMAL_RELEASE: "windows" }), /WEBGPT_WINDOWS_PUBLISHER/);
  assert.throws(() => createBuilderConfig({ WEBGPT_FORMAL_RELEASE: "macos" }), /WEBGPT_MAC_IDENTITY/);
  assert.throws(() => createBuilderConfig({ WEBGPT_FORMAL_RELEASE: "linux" }), /WEBGPT_FORMAL_RELEASE must be windows or macos/);
});
```

- [ ] **Step 2: Run the desktop suite and verify RED**

Run:

```bash
node scripts/verify-desktop.cjs
```

Expected: FAIL because `electron-updater`, exact builder/js-yaml pins, and `build/electron-builder-options.cjs` do not exist.

- [ ] **Step 3: Install exact dependencies**

Run:

```bash
npm install --save-exact electron-updater@6.8.9
npm install --save-dev --save-exact electron-builder@26.15.3 js-yaml@4.1.0
```

Expected `package.json` shape:

```json
{
  "dependencies": {
    "electron-updater": "6.8.9"
  },
  "devDependencies": {
    "electron": "^40.0.0",
    "electron-builder": "26.15.3",
    "js-yaml": "4.1.0"
  }
}
```

- [ ] **Step 4: Extract Electron Builder options into a testable config function**

Create `build/electron-builder-options.cjs` with this public shape:

```js
function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`Missing formal release configuration: ${name}`);
  return value;
}

function createBuilderConfig(env = process.env) {
  const formalPlatform = String(env.WEBGPT_FORMAL_RELEASE || "").trim();
  if (formalPlatform && formalPlatform !== "windows" && formalPlatform !== "macos") {
    throw new Error("WEBGPT_FORMAL_RELEASE must be windows or macos");
  }
  const config = {
    appId: "com.localagenthost.desktop",
    productName: "WebGPT Bridge",
    artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
    asar: true,
    asarUnpack: ["agent-runtime/**/*"],
    npmRebuild: false,
    directories: { buildResources: "build", output: "release" },
    files: [
      "src/**/*",
      "!src/update-e2e-control.cjs",
      "agent-runtime/**/*",
      "!agent-runtime/.webgpt-bridge{,/**}",
      "!agent-runtime/.npm{,/**}",
      "package.json",
      "README.md",
    ],
    extraResources: [{ from: "build/tunnel-client", to: "tunnel-client" }],
    publish: [{ provider: "github", owner: "chinatownlittlewhite", repo: "webgpt-bridge", releaseType: "draft" }],
    mac: {
      icon: "build/icon.icns",
      category: "public.app-category.developer-tools",
      target: ["dmg", "zip"],
      hardenedRuntime: true,
      gatekeeperAssess: false,
    },
    win: {
      target: ["nsis"],
      verifyUpdateCodeSignature: true,
    },
    nsis: {
      oneClick: false,
      perMachine: true,
      include: "build/installer.nsh",
      allowToChangeInstallationDirectory: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
    },
  };

  if (formalPlatform === "windows") {
    config.win.forceCodeSigning = true;
    config.win.azureSignOptions = {
      publisherName: required(env, "WEBGPT_WINDOWS_PUBLISHER"),
      endpoint: required(env, "WEBGPT_WINDOWS_SIGN_ENDPOINT"),
      codeSigningAccountName: required(env, "WEBGPT_WINDOWS_SIGN_ACCOUNT"),
      certificateProfileName: required(env, "WEBGPT_WINDOWS_SIGN_PROFILE"),
    };
  }
  if (formalPlatform === "macos") {
    config.mac.forceCodeSigning = true;
    config.mac.identity = required(env, "WEBGPT_MAC_IDENTITY");
    config.mac.notarize = true;
    config.mac.entitlements = "build/entitlements.mac.plist";
    config.mac.entitlementsInherit = "build/entitlements.mac.plist";
  }

  return config;
}

module.exports = { createBuilderConfig };
```

Create root `electron-builder.config.cjs`:

```js
const { createBuilderConfig } = require("./build/electron-builder-options.cjs");
module.exports = createBuilderConfig(process.env);
```

Remove the old root `package.json.build` object and make every builder command pass `--config electron-builder.config.cjs`.

- [ ] **Step 5: Make macOS dist truly Universal and keep ordinary builds non-publishing**

Update scripts to this intent:

```json
{
  "dist:mac": "npm run build:icon && npm run prepare:tunnel-client:mac && npm run prepare:agent && npm run verify:desktop && npm --prefix agent-runtime run acceptance && electron-builder --config electron-builder.config.cjs --mac dmg zip --universal --publish never",
  "dist:win": "npm run prepare:tunnel-client:win && npm run prepare:agent && npm run verify:desktop && npm --prefix agent-runtime run acceptance && electron-builder --config electron-builder.config.cjs --win nsis --x64 --publish never"
}
```

Do not add a Windows ZIP target.

- [ ] **Step 6: Run package regression tests**

Run:

```bash
node scripts/verify-desktop.cjs
```

Expected: PASS, including existing per-machine NSIS/host-prep assertions and new updater/build config assertions.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json build/electron-builder-options.cjs electron-builder.config.cjs test/package-content.test.cjs
git commit -m "build: prepare desktop updater packaging"
```

---

### Task 2: Implement the pure updater state machine

**Files:**
- Create: `src/update-service.cjs`
- Create: `test/update-service.test.cjs`

**Interfaces:**
- Consumes injected updater adapter with properties/events compatible with `electron-updater@6.8.9`.
- Produces `createUpdateService(options)` returning `{ start, dispose, getState, checkForUpdates, downloadUpdate, installUpdateAndRestart }`.
- `options`: `{ updater, currentVersion, isPackaged, stopRuntime, setQuitting, emitState, log, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn }`.
- Bounded state shape used by preload/renderer later:

```js
{
  status,
  currentVersion,
  availableVersion,
  releaseDate,
  releaseNotes,
  downloadPercent,
  downloadedBytes,
  totalBytes,
  bytesPerSecond,
  errorCode,
  errorMessage,
  canCheck,
  canDownload,
  canInstall,
  canRetry
}
```

- [ ] **Step 1: Write failing state-machine tests**

Create `test/update-service.test.cjs` with a fake event-emitting updater and tests covering at minimum:

```js
test("configures stable explicit user-controlled updates", () => {
  const updater = fakeUpdater();
  createUpdateService(baseOptions({ updater }));
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.autoRunAppAfterInstall, true);
});

test("normalizes available download and downloaded states", async () => {
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({ updater }));
  updater.emit("update-available", { version: "0.3.5", releaseDate: "2026-08-26T00:00:00Z", releaseNotes: "<b>Fix</b> <script>x()</script>" });
  assert.equal(service.getState().status, "available");
  assert.equal(service.getState().releaseNotes, "Fix");
  updater.emit("download-progress", { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 50 });
  assert.equal(service.getState().downloadPercent, 42.5);
  updater.emit("update-downloaded", { version: "0.3.5" });
  assert.equal(service.getState().canInstall, true);
});

test("deduplicates simultaneous checks and downloads", async () => {
  const updater = fakeUpdater({ deferredCheck: true, deferredDownload: true });
  const service = createUpdateService(baseOptions({ updater }));
  const a = service.checkForUpdates();
  const b = service.checkForUpdates();
  assert.strictEqual(a, b);
  updater.resolveCheck();
  await a;
});

test("installs only after runtime shutdown and explicit request", async () => {
  const calls = [];
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({
    updater,
    stopRuntime: async () => calls.push("stop"),
    setQuitting: (value) => calls.push(`quitting:${value}`),
  }));
  updater.emit("update-downloaded", { version: "0.3.5" });
  await service.installUpdateAndRestart();
  assert.deepEqual(calls, ["stop", "quitting:true"]);
  assert.deepEqual(updater.quitAndInstallCalls, [[false, true]]);
});

test("failed shutdown does not invoke installer", async () => {
  const updater = fakeUpdater();
  const service = createUpdateService(baseOptions({ updater, stopRuntime: async () => { throw new Error("busy"); } }));
  updater.emit("update-downloaded", { version: "0.3.5" });
  await service.installUpdateAndRestart();
  assert.equal(updater.quitAndInstallCalls.length, 0);
  assert.equal(service.getState().errorCode, "shutdown_failed");
});
```

Also test `network_unavailable`, checksum/signature/publisher error mapping, startup timer = `10_000`, periodic interval = `21_600_000`, non-packaged `start()` does not check, release-note length bound, numeric progress bounds, and immutable snapshots.

- [ ] **Step 2: Run the new unit test and verify RED**

Run:

```bash
node --test test/update-service.test.cjs
```

Expected: FAIL because `src/update-service.cjs` does not exist.

- [ ] **Step 3: Implement bounded release-note and error normalization**

Start `src/update-service.cjs` with pure helpers:

```js
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
  return { code, message: text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_MESSAGE) || "更新操作失败。" };
}
```

- [ ] **Step 4: Implement state ownership and updater event wiring**

Use one private mutable state and only return frozen copies:

```js
function snapshot(state) {
  return Object.freeze({ ...state });
}

function createUpdateService(options) {
  const {
    updater,
    currentVersion,
    isPackaged,
    stopRuntime,
    setQuitting,
    emitState = () => {},
    log = () => {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  } = options;

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

  function publish(next) {
    state = makeState(next.status, { ...state, ...next, currentVersion });
    const value = snapshot(state);
    emitState(value);
    log(`update:${value.status}${value.availableVersion ? `:${value.availableVersion}` : ""}`);
    return value;
  }

  // register checking-for-update, update-available, update-not-available,
  // download-progress, update-downloaded, update-cancelled, and error here.
  // Each handler calls publish() with only bounded fields.
```

`makeState()` must derive action booleans from `status`; do not let event payloads set them directly.

- [ ] **Step 5: Implement check/download/install methods and timers**

Use promise dedupe and the published v6 API:

```js
async function checkForUpdates() {
  if (!isPackaged) return publish({ status: "error", errorCode: "unsupported_environment", errorMessage: "更新检查仅在已安装版本中可用。" });
  if (checkPromise) return checkPromise;
  checkPromise = Promise.resolve(updater.checkForUpdates())
    .catch((error) => publishError(error))
    .finally(() => { checkPromise = null; });
  return checkPromise;
}

async function downloadUpdate() {
  if (state.status !== "available") return snapshot(state);
  if (downloadPromise) return downloadPromise;
  downloadPromise = Promise.resolve(updater.downloadUpdate())
    .catch((error) => publishError(error))
    .finally(() => { downloadPromise = null; });
  return downloadPromise;
}

async function installUpdateAndRestart() {
  if (state.status !== "downloaded") return snapshot(state);
  try {
    await stopRuntime();
  } catch (error) {
    return publish({ status: "error", errorCode: "shutdown_failed", errorMessage: String(error?.message || error).slice(0, 300) });
  }

  setQuitting(true);
  publish({ status: "installing", errorCode: "", errorMessage: "" });
  try {
    updater.quitAndInstall(false, true);
  } catch (error) {
    setQuitting(false);
    return publish({ status: "error", errorCode: "install_launch_failed", errorMessage: String(error?.message || error).slice(0, 300) });
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
```

`dispose()` removes event listeners and clears both timers.

- [ ] **Step 6: Run updater unit tests GREEN**

Run:

```bash
node --test test/update-service.test.cjs
```

Expected: PASS.

- [ ] **Step 7: Run full desktop tests and commit**

Run:

```bash
node scripts/verify-desktop.cjs
```

Expected: PASS.

Commit:

```bash
git add src/update-service.cjs test/update-service.test.cjs
git commit -m "feat: add desktop update state service"
```

---

### Task 3: Integrate updater into main/preload and make update shutdown truly orderly

**Files:**
- Modify: `src/main.cjs:1-581`
- Modify: `src/preload.cjs`
- Create: `test/update-boundary.test.cjs`

**Interfaces:**
- Consumes `createUpdateService()` from Task 2 and `electron-updater.autoUpdater` only in main process.
- Produces IPC handlers `update:get-state`, `update:check`, `update:download`, `update:install` and renderer event `update:state`.
- Produces preload methods `getUpdateState`, `checkForUpdates`, `downloadUpdate`, `installUpdateAndRestart`, `onUpdateState`.

- [ ] **Step 1: Write failing IPC/trust-boundary tests**

Create `test/update-boundary.test.cjs`:

```js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");

test("renderer update IPC has no URL repository path or installer arguments", () => {
  for (const channel of ["update:get-state", "update:check", "update:download", "update:install"]) assert.match(main, new RegExp(channel.replace(":", "\\:")));
  assert.match(preload, /getUpdateState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:get-state"\)/);
  assert.match(preload, /checkForUpdates:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("update:check"\)/);
  assert.doesNotMatch(preload, /setFeedURL|feedURL|installerPath|repository|publisherName/);
});

test("update installation marks quit intent before electron-updater closes windows", () => {
  assert.match(main, /setQuitting:\s*\(value\)\s*=>\s*\{\s*isQuitting\s*=\s*Boolean\(value\)/s);
});

test("main process does not expose host-prep mutation through update IPC", () => {
  const updateSection = main.slice(main.indexOf("update:get-state"));
  assert.doesNotMatch(updateSection, /windows-host-prep|--apply|--remove|schtasks/i);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
node --test test/update-boundary.test.cjs
```

Expected: FAIL because update IPC/preload methods do not exist.

- [ ] **Step 3: Harden child shutdown for update installation**

Replace the macOS-only fire-and-forget SIGTERM behavior with a bounded helper. Keep Windows `taskkill /T /F` synchronous.

Add in `src/main.cjs` near `stopChild`:

```js
function waitForChildExit(child, timeoutMs = 5000) {
  if (!processIsLive(child)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`进程在 ${timeoutMs}ms 内未退出。`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const onExit = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopChild(child, name) {
  if (!processIsLive(child)) return;
  appendLog("host", `正在停止 ${name}…`);
  if (process.platform === "win32" && child.pid) {
    const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    if (result.status !== 0 && processIsLive(child)) throw new Error(`${name} 无法停止。`);
    return;
  }
  try {
    const gracefulExit = waitForChildExit(child, 5000);
    child.kill("SIGTERM");
    await gracefulExit;
  } catch {
    if (processIsLive(child)) {
      const forcedExit = waitForChildExit(child, 2000);
      child.kill("SIGKILL");
      await forcedExit;
    }
  }
}
```

This makes `await stopAll()` meaningful before an updater install.

- [ ] **Step 4: Create the production updater service only in Electron main**

At startup, require the adapter in main process:

```js
const { createUpdateService } = require("./update-service.cjs");
const { autoUpdater } = require("electron-updater");
```

Create service after `app.whenReady()` begins:

```js
updateService = createUpdateService({
  updater: autoUpdater,
  currentVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  stopRuntime: stopAll,
  setQuitting: (value) => { isQuitting = Boolean(value); },
  emitState: (state) => {
    windowRef?.webContents?.send("update:state", state);
    updateTray();
  },
  log: (line) => appendLog("update", line),
});
```

Do not call `setFeedURL()` anywhere. The packaged `app-update.yml` remains the only production feed definition.

- [ ] **Step 5: Register zero-argument update IPC and start scheduling**

Inside the existing IPC registration block:

```js
ipcMain.handle("update:get-state", () => updateService.getState());
ipcMain.handle("update:check", () => updateService.checkForUpdates());
ipcMain.handle("update:download", () => updateService.downloadUpdate());
ipcMain.handle("update:install", () => updateService.installUpdateAndRestart());
```

After tray/window creation:

```js
updateService.start();
```

On final app quit call `updateService.dispose()` before/alongside normal cleanup.

- [ ] **Step 6: Add narrow preload methods**

Extend `src/preload.cjs`:

```js
getUpdateState: () => ipcRenderer.invoke("update:get-state"),
checkForUpdates: () => ipcRenderer.invoke("update:check"),
downloadUpdate: () => ipcRenderer.invoke("update:download"),
installUpdateAndRestart: () => ipcRenderer.invoke("update:install"),
onUpdateState: (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on("update:state", listener);
  return () => ipcRenderer.removeListener("update:state", listener);
},
```

No method accepts an updater URL/path/repository/version argument.

- [ ] **Step 7: Run focused and full tests**

Run:

```bash
node --test test/update-boundary.test.cjs test/update-service.test.cjs
node scripts/verify-desktop.cjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main.cjs src/preload.cjs test/update-boundary.test.cjs
git commit -m "feat: integrate secure desktop updater"
```

---

### Task 4: Add the application-update UI and tray status

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/styles.css`
- Modify: `src/main.cjs` tray template
- Modify: `test/update-boundary.test.cjs`

**Interfaces:**
- Consumes Task 3 preload state methods/events.
- Produces renderer IDs: `updateCurrentVersion`, `updateHeadline`, `updateNotes`, `updateProgress`, `updateProgressBar`, `updateMeta`, `updateAction`.

- [ ] **Step 1: Add failing renderer/tray assertions**

Extend `test/update-boundary.test.cjs`:

```js
const html = fs.readFileSync(path.join(root, "src", "renderer", "index.html"), "utf8");
const renderer = fs.readFileSync(path.join(root, "src", "renderer", "renderer.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "src", "renderer", "styles.css"), "utf8");

test("renderer exposes one bounded update panel and state-dependent action", () => {
  for (const id of ["updateCurrentVersion", "updateHeadline", "updateNotes", "updateProgress", "updateProgressBar", "updateMeta", "updateAction"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(renderer, /api\.getUpdateState\(\)/);
  assert.match(renderer, /api\.onUpdateState/);
  assert.match(renderer, /api\.checkForUpdates\(\)/);
  assert.match(renderer, /api\.downloadUpdate\(\)/);
  assert.match(renderer, /api\.installUpdateAndRestart\(\)/);
  assert.doesNotMatch(renderer, /fetch\(|XMLHttpRequest|setFeedURL|github\.com\/.*releases/);
  assert.match(styles, /\.update-card/);
});

test("tray can surface a downloaded or available update without installing it", () => {
  assert.match(main, /发现更新|更新已下载/);
});
```

- [ ] **Step 2: Run focused test RED**

Run:

```bash
node --test test/update-boundary.test.cjs
```

Expected: FAIL on missing update panel/tray text.

- [ ] **Step 3: Add the update card between runtime status and advanced settings**

Insert in `src/renderer/index.html`:

```html
<section class="update-card card" aria-labelledby="updateHeadline">
  <div class="section-heading">
    <div>
      <h2 id="updateHeadline">应用更新</h2>
      <p id="updateCurrentVersion">当前版本</p>
    </div>
    <button id="updateAction" class="secondary" type="button">检查更新</button>
  </div>
  <p id="updateNotes" class="update-notes" hidden></p>
  <div id="updateProgress" class="update-progress" hidden>
    <progress id="updateProgressBar" max="100" value="0"></progress>
    <span id="updateMeta"></span>
  </div>
</section>
```

Do not render release notes with `innerHTML`; use `textContent` only.

- [ ] **Step 4: Implement renderer state mapping with one action button**

Add to `renderer.js`:

```js
let updateState;

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderUpdate(state) {
  updateState = state;
  byId("updateCurrentVersion").textContent = `当前版本 v${state.currentVersion}`;
  byId("updateNotes").hidden = !state.releaseNotes;
  byId("updateNotes").textContent = state.releaseNotes || "";
  byId("updateProgress").hidden = state.status !== "downloading";
  byId("updateProgressBar").value = state.downloadPercent || 0;
  byId("updateMeta").textContent = state.status === "downloading"
    ? `${(state.downloadPercent || 0).toFixed(1)}% · ${formatBytes(state.downloadedBytes)} / ${formatBytes(state.totalBytes)}`
    : "";

  const button = byId("updateAction");
  button.disabled = state.status === "checking" || state.status === "downloading" || state.status === "installing";
  if (state.canInstall) button.textContent = "更新并重新启动";
  else if (state.canDownload) button.textContent = `下载 v${state.availableVersion}`;
  else if (state.status === "error") button.textContent = "重试";
  else button.textContent = "检查更新";
}

byId("updateAction").addEventListener("click", async () => {
  if (updateState?.canInstall) await api.installUpdateAndRestart();
  else if (updateState?.canDownload) await api.downloadUpdate();
  else await api.checkForUpdates();
});
```

Map headline/error copy without exposing raw paths or stack traces. Initialize with `renderUpdate(await api.getUpdateState())` and subscribe via `api.onUpdateState(renderUpdate)`.

- [ ] **Step 5: Add restrained card/progress styles**

Add CSS that follows existing card tokens, uses native `<progress>`, and does not introduce a new visual system. Example selectors:

```css
.update-card .section-heading { align-items: center; }
.update-notes { white-space: pre-wrap; margin: 10px 0 0; }
.update-progress { display: grid; gap: 6px; margin-top: 12px; }
.update-progress progress { width: 100%; height: 8px; }
```

- [ ] **Step 6: Add tray-only update status**

In `updateTray()`, read `updateService?.getState()` and insert a disabled row only for `available`/`downloaded`:

```js
const update = updateService?.getState();
const updateItem = update?.status === "downloaded"
  ? { label: `更新已下载 · v${update.availableVersion}`, enabled: false }
  : update?.status === "available"
    ? { label: `发现更新 · v${update.availableVersion}`, enabled: false }
    : null;
```

Do not add a tray action that bypasses the main-window explicit install flow.

- [ ] **Step 7: Run desktop tests and commit**

Run:

```bash
node --test test/update-boundary.test.cjs
node scripts/verify-desktop.cjs
```

Expected: PASS.

Commit:

```bash
git add src/main.cjs src/renderer/index.html src/renderer/renderer.js src/renderer/styles.css test/update-boundary.test.cjs
git commit -m "feat: add in-app update controls"
```

---

### Task 5: Extract and strengthen the real Windows NSIS lifecycle smoke

**Files:**
- Create: `scripts/windows-installer-smoke.ps1`
- Modify: `.github/workflows/build-desktop.yml`
- Modify: `test/package-content.test.cjs`

**Interfaces:**
- Consumes `-ArtifactsDir`, `-SourcePrep`, optional `-InstallRoot`.
- Produces exit 0 only after precondition missing -> real install -> exact SYSTEM task -> ready -> uninstall -> task/payload/ACE removed.
- This script is reused by PR CI and formal release CI.

- [ ] **Step 1: Write failing assertions that inline smoke is replaced by a reusable script**

Update `test/package-content.test.cjs`:

```js
test("Windows installer lifecycle smoke is reusable by PR and release CI", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-installer-smoke.ps1"), "utf8");
  assert.match(workflow, /windows-installer-smoke\.ps1/);
  assert.match(script, /capability_ace_missing/);
  assert.match(script, /Get-ScheduledTask/);
  assert.match(script, /Principal\.UserId/);
  assert.match(script, /Principal\.RunLevel/);
  assert.match(script, /MSFT_TaskBootTrigger/);
  assert.match(script, /Arguments.*--apply/);
  assert.match(script, /installed host-prep payload remained after uninstall/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node scripts/verify-desktop.cjs
```

Expected: FAIL because the PowerShell script does not exist.

- [ ] **Step 3: Move the already-tested inline smoke into `scripts/windows-installer-smoke.ps1`**

The script begins:

```powershell
param(
  [Parameter(Mandatory = $true)][string]$ArtifactsDir,
  [Parameter(Mandatory = $true)][string]$SourcePrep,
  [string]$InstallRoot = (Join-Path $env:ProgramFiles "WebGPT Bridge")
)
$ErrorActionPreference = "Stop"
$taskName = "WebGPT Bridge Host Preparation"
$installer = Get-ChildItem -Path $ArtifactsDir -Filter "WebGPT Bridge-*-win-x64.exe" -File | Select-Object -First 1
if (-not $installer) { throw "built Windows NSIS installer was not found" }
if (Test-Path $InstallRoot) { throw "pre-existing WebGPT Bridge Program Files installation would invalidate installer smoke" }
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { throw "pre-existing SYSTEM host-preparation task would invalidate installer smoke" }
```

Copy the current proven pre-remove/check, install, task principal/runlevel/action/boot-trigger validation, installed `--check --json`, uninstall, task/payload removal, and final `capability_ace_missing` assertions into the script unchanged in meaning.

Wrap the body in `try/finally`; the finally block attempts silent uninstall if an install directory remains, deletes the fixed task, and runs source `--remove`. Cleanup failures are warnings, not replacements for the original failure.

- [ ] **Step 4: Make PR workflow call the script**

Replace the inline `Smoke install Windows NSIS artifact` PowerShell body with:

```powershell
$prep = (Resolve-Path "agent-runtime\native\windows-host-prep\bin\release\lpc-windows-host-prep.exe").Path
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -ExecutionPolicy Bypass `
  -File "scripts\windows-installer-smoke.ps1" `
  -ArtifactsDir "release" `
  -SourcePrep $prep
if ($LASTEXITCODE -ne 0) { throw "Windows installer lifecycle smoke failed with exit $LASTEXITCODE" }
```

Keep the final `if: always()` source host-prep cleanup as defense in depth.

- [ ] **Step 5: Run local static verification**

Run:

```bash
node scripts/verify-desktop.cjs
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/build-desktop.yml'); puts 'YAML OK'"
git diff --check
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/windows-installer-smoke.ps1 .github/workflows/build-desktop.yml test/package-content.test.cjs
git commit -m "test: reuse Windows installer lifecycle smoke"
```

---

### Task 6: Add release-contract validation and checksums

**Files:**
- Create: `scripts/release-contract.cjs`
- Create: `scripts/verify-release-tag.cjs`
- Create: `scripts/validate-release-assets.cjs`
- Create: `scripts/write-release-checksums.cjs`
- Create: `test/release-contract.test.cjs`
- Modify: `package.json`

**Interfaces:**
- `release-contract.cjs` produces `verifyTagVersion({ tag, version })`, `readUpdateManifest(file)`, `validateManifest({ manifest, version, assetDir })`, `sha512Base64(file)`, `sha256Hex(file)`.
- CLIs return nonzero on any mismatch; no network is required.

- [ ] **Step 1: Write failing pure release-contract tests**

Create fixtures in temp directories from the test itself and assert:

```js
test("release tag must exactly equal v + root version", () => {
  assert.doesNotThrow(() => verifyTagVersion({ tag: "v0.3.5", version: "0.3.5" }));
  assert.throws(() => verifyTagVersion({ tag: "v0.3.6", version: "0.3.5" }), /tag\/version mismatch/);
});

test("manifest validation requires same version existing assets and matching sha512", () => {
  // Write installer bytes, compute sha512, write latest.yml through js-yaml, then expect pass.
  // Change one byte and expect /sha512 mismatch/.
});

test("manifest cannot reference an asset outside its release directory", () => {
  assert.throws(() => validateManifest({ manifest: { version: "0.3.5", files: [{ url: "../evil.exe", sha512: "x" }] }, version: "0.3.5", assetDir }), /unsafe asset name/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/release-contract.test.cjs
```

Expected: FAIL because release contract module does not exist.

- [ ] **Step 3: Implement strict local manifest validation**

Use `js-yaml` only for parsing; never execute YAML tags. Key implementation rules:

```js
const yaml = require("js-yaml");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function safeAssetName(value) {
  const name = String(value || "");
  if (!name || path.basename(name) !== name || name.includes("..") || /[\\/]/.test(name)) {
    throw new Error(`unsafe asset name: ${name}`);
  }
  return name;
}

function sha512Base64(file) {
  return crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}
```

`validateManifest()` must require exact version, non-empty `files[]`, every referenced asset exists, and every `sha512` equals the actual file bytes. Support `latest.yml` and `latest-mac.yml` current v26 `files[]` shape; do not rely only on legacy top-level `path`.

- [ ] **Step 4: Implement tag CLI and checksum CLI**

`verify-release-tag.cjs` reads root package version and `GITHUB_REF_NAME` (or `--tag`) and prints JSON plus optional GitHub output:

```js
const { version } = require("../package.json");
const tag = process.argv[process.argv.indexOf("--tag") + 1] || process.env.GITHUB_REF_NAME || "";
verifyTagVersion({ tag, version });
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\n`);
console.log(JSON.stringify({ ok: true, version, tag }));
```

`write-release-checksums.cjs` sorts only user-facing `.exe`, `.dmg`, `.zip` files and writes:

```text
<sha256>  <basename>
```

Never include credential files, `.p8`, token files, or unpacked CI temp paths.

- [ ] **Step 5: Implement release-asset CLI**

`validate-release-assets.cjs` accepts explicit directories:

```bash
node scripts/validate-release-assets.cjs --version 0.3.5 --windows release-win --mac release-mac
```

It requires:

- Windows installer matching `WebGPT Bridge-${version}-win-x64.exe`;
- `latest.yml` with exact version/hash references;
- Universal mac DMG and ZIP for exact version;
- `latest-mac.yml` with exact version/hash references;
- no duplicate basename across platform upload sets except `SHA256SUMS` after final generation.

This CLI validates bytes/metadata only; platform signature validation remains native workflow steps.

- [ ] **Step 6: Add package scripts and run GREEN**

Add:

```json
{
  "release:verify-tag": "node scripts/verify-release-tag.cjs",
  "release:validate-assets": "node scripts/validate-release-assets.cjs",
  "release:checksums": "node scripts/write-release-checksums.cjs"
}
```

Run:

```bash
node --test test/release-contract.test.cjs
node scripts/verify-desktop.cjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/release-contract.cjs scripts/verify-release-tag.cjs scripts/validate-release-assets.cjs scripts/write-release-checksums.cjs test/release-contract.test.cjs package.json package-lock.json
git commit -m "build: validate desktop release contract"
```

---

### Task 7: Create the draft-first formal GitHub Release workflow

**Files:**
- Create: `.github/workflows/release-desktop.yml`
- Create: `test/release-workflow.test.cjs`
- Modify: `.github/workflows/build-desktop.yml`

**Interfaces:**
- Tag trigger: `v*` only.
- Formal environments: `desktop-release-windows`, `desktop-release-macos`.
- Produces one draft release per tag and public release only after both signed platform jobs + final validation.

- [ ] **Step 1: Write failing workflow-structure tests**

Create `test/release-workflow.test.cjs` asserting:

```js
test("formal release is isolated from PR CI and starts as draft", () => {
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "release-desktop.yml"), "utf8");
  const build = fs.readFileSync(path.join(root, ".github", "workflows", "build-desktop.yml"), "utf8");
  assert.match(release, /push:\s*\n\s*tags:\s*\n\s*-\s*["']v\*["']/);
  assert.match(release, /gh release create[^\n]*--draft/);
  assert.match(release, /release:verify-tag/);
  assert.match(release, /needs:\s*\[[^\]]*windows[^\]]*macos[^\]]*\]/s);
  assert.match(release, /gh release edit[^\n]*--draft=false/);
  assert.doesNotMatch(build, /push:\s*\n\s*tags:/);
});

test("formal signing credentials are scoped away from PR workflow", () => {
  const build = fs.readFileSync(path.join(root, ".github", "workflows", "build-desktop.yml"), "utf8");
  assert.doesNotMatch(build, /AZURE_FEDERATED_TOKEN_FILE|APPLE_API_KEY|CSC_LINK|WEBGPT_FORMAL_RELEASE/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/release-workflow.test.cjs
```

Expected: FAIL because formal workflow does not exist and build workflow still has tag trigger.

- [ ] **Step 3: Remove formal tag trigger from ordinary build workflow**

Keep only:

```yaml
on:
  workflow_dispatch:
  pull_request:
    branches:
      - main
```

This workflow remains unsigned CI artifact + Windows P0 gate only.

- [ ] **Step 4: Add common validation and draft creation jobs**

Start `.github/workflows/release-desktop.yml`:

```yaml
name: Release desktop apps

on:
  push:
    tags:
      - "v*"

concurrency:
  group: desktop-release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm --prefix agent-runtime ci
      - run: npm run release:verify-tag
      - run: npm run verify:desktop
      - run: npm --prefix agent-runtime test
      - run: npm --prefix agent-runtime run lint
      - run: npm --prefix agent-runtime run contract

  draft:
    needs: verify
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - name: Create or reuse only an unpublished exact draft
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          if gh release view "$GITHUB_REF_NAME" --json isDraft >/tmp/release.json 2>/dev/null; then
            node -e 'const v=require("/tmp/release.json"); if(v.isDraft!==true){process.exit(1)}'
            echo "Reusing existing unpublished draft $GITHUB_REF_NAME"
          else
            gh release create "$GITHUB_REF_NAME" --verify-tag --draft --title "$GITHUB_REF_NAME"
          fi
```

A rerun may reuse only an existing release whose `isDraft` is exactly `true`; an existing public or prerelease object for the tag fails the job instead of being repurposed.

- [ ] **Step 5: Add platform jobs that upload only Actions artifacts**

`windows` and `macos` jobs both `needs: [verify, draft]`. They receive signing identity only through their own protected environment. They do not get `contents: write`; they upload to Actions artifacts with `actions/upload-artifact@v4`.

- [ ] **Step 6: Add final validation/upload/publication job**

The final job:

```yaml
  publish:
    needs: [windows, macos]
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci --ignore-scripts
      - uses: actions/download-artifact@v4
        with:
          name: desktop-release-windows
          path: release-win
      - uses: actions/download-artifact@v4
        with:
          name: desktop-release-macos
          path: release-mac
      - run: node scripts/validate-release-assets.cjs --version "${GITHUB_REF_NAME#v}" --windows release-win --mac release-mac
      - run: node scripts/write-release-checksums.cjs release-win release-mac SHA256SUMS
      - name: Upload exact validated assets to draft
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "$GITHUB_REF_NAME" release-win/* release-mac/* SHA256SUMS
      - name: Publish stable release atomically after all gates
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release edit "$GITHUB_REF_NAME" --draft=false --prerelease=false --latest
```

Do not use `--clobber` after a release is public. Any upload/validation failure leaves the release draft.

- [ ] **Step 7: Run workflow/static tests**

Run:

```bash
node --test test/release-workflow.test.cjs
node scripts/verify-desktop.cjs
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/build-desktop.yml'); YAML.load_file('.github/workflows/release-desktop.yml'); puts 'YAML OK'"
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add .github/workflows/build-desktop.yml .github/workflows/release-desktop.yml test/release-workflow.test.cjs
git commit -m "ci: add draft-first desktop release workflow"
```

---

### Task 8: Add Windows Artifact Signing through GitHub OIDC and signed-release validation

**Files:**
- Modify: `.github/workflows/release-desktop.yml`
- Modify: `build/electron-builder-options.cjs`
- Modify: `test/release-workflow.test.cjs`
- Modify: `test/package-content.test.cjs`
- Create: `docs/release-signing.md` (Windows section initially)

**Interfaces:**
- Required GitHub Environment variables in `desktop-release-windows`:
  - `AZURE_TENANT_ID`
  - `AZURE_CLIENT_ID`
  - `WEBGPT_WINDOWS_SIGN_ENDPOINT`
  - `WEBGPT_WINDOWS_SIGN_ACCOUNT`
  - `WEBGPT_WINDOWS_SIGN_PROFILE`
  - `WEBGPT_WINDOWS_PUBLISHER`
- Runtime-generated secret file: `AZURE_FEDERATED_TOKEN_FILE` under `$RUNNER_TEMP`, deleted in `always()` cleanup.
- Azure app/service principal must have Artifact Signing Certificate Profile Signer role and a federated credential scoped to GitHub environment `desktop-release-windows`.

- [ ] **Step 1: Add failing OIDC/signature gate tests**

Extend `test/release-workflow.test.cjs`:

```js
test("Windows formal release uses OIDC and never falls back to unsigned output", () => {
  const release = readReleaseWorkflow();
  const windows = release.slice(release.indexOf("  windows:"), release.indexOf("  macos:"));
  assert.match(windows, /permissions:[\s\S]*id-token:\s*write/);
  assert.match(windows, /AZURE_FEDERATED_TOKEN_FILE/);
  assert.match(windows, /WEBGPT_FORMAL_RELEASE:\s*["']windows["']/);
  assert.match(windows, /Get-AuthenticodeSignature/);
  assert.match(windows, /Status[^\n]*Valid/);
  assert.match(windows, /WEBGPT_WINDOWS_PUBLISHER/);
  assert.doesNotMatch(windows, /continue-on-error:\s*true[\s\S]*unsigned fallback/i);
  assert.doesNotMatch(windows, /AZURE_CLIENT_SECRET/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/release-workflow.test.cjs
```

Expected: FAIL until Windows formal signing steps exist.

- [ ] **Step 3: Request a GitHub OIDC token and expose it as Azure workload identity file**

Give Windows job:

```yaml
permissions:
  contents: read
  id-token: write
environment: desktop-release-windows
```

Create token file in PowerShell without logging token contents:

```powershell
$audience = [uri]::EscapeDataString("api://AzureADTokenExchange")
$separator = if ($env:ACTIONS_ID_TOKEN_REQUEST_URL.Contains("?")) { "&" } else { "?" }
$uri = "$env:ACTIONS_ID_TOKEN_REQUEST_URL${separator}audience=$audience"
$response = Invoke-RestMethod -Uri $uri -Headers @{ Authorization = "Bearer $env:ACTIONS_ID_TOKEN_REQUEST_TOKEN" }
$tokenFile = Join-Path $env:RUNNER_TEMP "webgpt-azure-federated-token.jwt"
[IO.File]::WriteAllText($tokenFile, $response.value, [Text.UTF8Encoding]::new($false))
"AZURE_FEDERATED_TOKEN_FILE=$tokenFile" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
```

The job environment sets `AZURE_TENANT_ID` and `AZURE_CLIENT_ID` from protected environment variables; no client secret.

- [ ] **Step 4: Run the formal signed Windows build through existing package gates**

Set:

```yaml
env:
  WEBGPT_FORMAL_RELEASE: "windows"
  AZURE_TENANT_ID: ${{ vars.AZURE_TENANT_ID }}
  AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}
  WEBGPT_WINDOWS_SIGN_ENDPOINT: ${{ vars.WEBGPT_WINDOWS_SIGN_ENDPOINT }}
  WEBGPT_WINDOWS_SIGN_ACCOUNT: ${{ vars.WEBGPT_WINDOWS_SIGN_ACCOUNT }}
  WEBGPT_WINDOWS_SIGN_PROFILE: ${{ vars.WEBGPT_WINDOWS_SIGN_PROFILE }}
  WEBGPT_WINDOWS_PUBLISHER: ${{ vars.WEBGPT_WINDOWS_PUBLISHER }}
```

Then run the same Node/.NET install, native build, host-prep remove/reapply, standard-user acceptance, and `npm run dist:win` sequence used by PR CI. The builder config's formal branch creates `win.azureSignOptions`; missing signing identity is a hard build failure.

After packaging invoke reusable:

```powershell
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts\windows-installer-smoke.ps1 -ArtifactsDir release -SourcePrep $prep
```

- [ ] **Step 5: Verify Authenticode publisher/timestamp on required binaries**

Validate final installer and packaged executables before artifact upload. Use the expected publisher variable; do not hardcode a not-yet-issued certificate subject in source:

```powershell
$required = @(
  (Get-ChildItem release -Filter "WebGPT Bridge-*-win-x64.exe" -File | Select-Object -First 1).FullName,
  (Get-ChildItem release -Recurse -Filter "WebGPT Bridge.exe" -File | Select-Object -First 1).FullName,
  (Get-ChildItem release -Recurse -Filter "lpc-windows-sandbox.exe" -File | Select-Object -First 1).FullName,
  (Get-ChildItem release -Recurse -Filter "lpc-windows-host-prep.exe" -File | Select-Object -First 1).FullName
)
foreach ($file in $required) {
  if (-not $file) { throw "required signed release executable missing" }
  $sig = Get-AuthenticodeSignature -FilePath $file
  if ($sig.Status -ne "Valid") { throw "invalid Authenticode signature: $file ($($sig.Status))" }
  if ($sig.SignerCertificate.Subject -ne $env:WEBGPT_WINDOWS_PUBLISHER) { throw "publisher mismatch: $file ($($sig.SignerCertificate.Subject))" }
  if (-not $sig.TimeStamperCertificate) { throw "timestamp missing: $file" }
}
```

If unpacked paths differ in electron-builder 26 output, discover by basename but require exactly one candidate per expected executable.

- [ ] **Step 6: Document exact Azure external setup**

Create `docs/release-signing.md` Windows section specifying:

- Artifact Signing Public Trust account/profile;
- one fixed expected certificate subject stored as `WEBGPT_WINDOWS_PUBLISHER`;
- Entra app registration/service principal;
- Artifact Signing Certificate Profile Signer role scoped only to the signing account/profile;
- GitHub federated credential subject tied to environment `desktop-release-windows`;
- no `AZURE_CLIENT_SECRET` requirement;
- expected browser result is Verified Publisher, not a promise of immediate zero SmartScreen reputation prompts.

- [ ] **Step 7: Run local static tests and commit**

Run:

```bash
node --test test/release-workflow.test.cjs test/package-content.test.cjs
node scripts/verify-desktop.cjs
```

Expected: PASS locally without production credentials because formal build steps are not executed.

Commit:

```bash
git add .github/workflows/release-desktop.yml build/electron-builder-options.cjs test/release-workflow.test.cjs test/package-content.test.cjs docs/release-signing.md
git commit -m "ci: enforce signed Windows desktop releases"
```

---

### Task 9: Add macOS Developer ID signing, notarization, and true Universal verification

**Files:**
- Create: `build/entitlements.mac.plist`
- Modify: `.github/workflows/release-desktop.yml`
- Modify: `build/electron-builder-options.cjs`
- Modify: `test/release-workflow.test.cjs`
- Modify: `test/package-content.test.cjs`
- Modify: `docs/release-signing.md`

**Interfaces:**
- Protected environment `desktop-release-macos`.
- Required secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_API_KEY_BASE64`.
- Required variables: `WEBGPT_MAC_IDENTITY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- Runtime file `APPLE_API_KEY` is an ephemeral `.p8` path under `$RUNNER_TEMP` and is removed in cleanup.

- [ ] **Step 1: Add failing Universal/signing/notarization tests**

Extend `test/release-workflow.test.cjs` and `test/package-content.test.cjs`:

```js
test("formal macOS release is universal signed notarized and Gatekeeper checked", () => {
  const release = readReleaseWorkflow();
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  assert.match(mac, /--universal/);
  assert.match(mac, /CSC_LINK/);
  assert.match(mac, /APPLE_API_KEY/);
  assert.match(mac, /codesign\s+--verify/);
  assert.match(mac, /lipo\s+-archs/);
  assert.match(mac, /xcrun\s+stapler/);
  assert.match(mac, /spctl\s+--assess/);
  assert.doesNotMatch(mac, /unsigned fallback|continue-on-error:\s*true/i);
});

test("mac entitlements stay minimal", () => {
  const plist = fs.readFileSync(path.join(root, "build", "entitlements.mac.plist"), "utf8");
  assert.match(plist, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(plist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.doesNotMatch(plist, /disable-library-validation/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/release-workflow.test.cjs test/package-content.test.cjs
```

Expected: FAIL because entitlements/formal mac job are incomplete.

- [ ] **Step 3: Add minimal Electron Hardened Runtime entitlements**

Create `build/entitlements.mac.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
```

Do not add DYLD environment or library-validation bypass entitlements without a separately reproduced signing/runtime failure and user-approved design change.

- [ ] **Step 4: Prepare ephemeral Developer ID and notarization credentials**

The mac job sets:

```yaml
permissions:
  contents: read
environment: desktop-release-macos
env:
  WEBGPT_FORMAL_RELEASE: "macos"
  WEBGPT_MAC_IDENTITY: ${{ vars.WEBGPT_MAC_IDENTITY }}
  CSC_LINK: ${{ secrets.MAC_CSC_LINK }}
  CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
  APPLE_API_KEY_ID: ${{ vars.APPLE_API_KEY_ID }}
  APPLE_API_ISSUER: ${{ vars.APPLE_API_ISSUER }}
```

Decode API key without logging it:

```bash
KEY_PATH="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
printf '%s' "$APPLE_API_KEY_BASE64" | base64 --decode > "$KEY_PATH"
chmod 600 "$KEY_PATH"
echo "APPLE_API_KEY=$KEY_PATH" >> "$GITHUB_ENV"
```

Pass `APPLE_API_KEY_BASE64` only to this step from the protected secret.

- [ ] **Step 5: Build signed/notarized Universal DMG + ZIP**

Run the same desktop/Agent regression gates, then:

```bash
npm run dist:mac
```

Because Task 1 changed `dist:mac` to `--universal` and the macOS release job sets `WEBGPT_FORMAL_RELEASE=macos`, builder requires Developer ID signing and built-in notarization without requiring Windows signing variables.

- [ ] **Step 6: Verify actual Universal slices, signing, stapling and Gatekeeper**

Find exactly one packaged app and require both arches:

```bash
APP="$(find release -type d -name 'WebGPT Bridge.app' -print | head -n 1)"
[ -n "$APP" ] || { echo "packaged app missing"; exit 1; }
ARCHS="$(lipo -archs "$APP/Contents/MacOS/WebGPT Bridge")"
printf '%s\n' "$ARCHS" | grep -qw arm64
printf '%s\n' "$ARCHS" | grep -qw x86_64
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP" 2>&1 | grep -F "$WEBGPT_MAC_IDENTITY"
spctl --assess --type execute --verbose=4 "$APP"
DMG="$(find release -maxdepth 1 -name 'WebGPT Bridge-*-mac-universal.dmg' -print | head -n 1)"
ZIP="$(find release -maxdepth 1 -name 'WebGPT Bridge-*-mac-universal.zip' -print | head -n 1)"
[ -f "$DMG" ] && [ -f "$ZIP" ]
xcrun stapler validate "$DMG"
```

If electron-builder's notarization staples the app/DMG automatically, validation proves it. Do not call `xattr -cr` in the release workflow because removing quarantine attributes is not a valid Gatekeeper acceptance strategy.

- [ ] **Step 7: Document Apple setup and cleanup secrets**

Append `docs/release-signing.md` with Developer ID Application certificate export, `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, App Store Connect API key inputs, `WEBGPT_MAC_IDENTITY`, and protected environment names. Add an `if: always()` cleanup step deleting the `.p8` file and temporary keychain/certificate files created by Electron Builder/GitHub steps where identifiable.

- [ ] **Step 8: Run local tests and commit**

Run:

```bash
node --test test/release-workflow.test.cjs test/package-content.test.cjs
node scripts/verify-desktop.cjs
```

Expected: PASS locally.

Commit:

```bash
git add build/entitlements.mac.plist .github/workflows/release-desktop.yml build/electron-builder-options.cjs test/release-workflow.test.cjs test/package-content.test.cjs docs/release-signing.md
git commit -m "ci: enforce notarized Universal macOS releases"
```

---

### Task 10: Add packaged updater E2E harnesses and final release-readiness gates

**Files:**
- Create: `scripts/update-e2e-feed.cjs`
- Create: `scripts/update-e2e-assert.cjs`
- Create: `src/update-e2e-control.cjs`
- Create: `test/update-e2e-contract.test.cjs`
- Modify: `.github/workflows/release-desktop.yml`
- Modify: `src/main.cjs`
- Modify: `README.md`
- Modify: `docs/release-signing.md`

**Interfaces:**
- Production feed remains fixed GitHub and has no runtime override.
- E2E feed is a **build-time-only Electron Builder config override** generated into an isolated CI artifact; it is not a renderer setting, application setting, or production environment-variable feed override.
- Production Builder config explicitly excludes `src/update-e2e-control.cjs`; generated E2E config removes that exclusion and embeds `WEBGPT_UPDATE_E2E_BUILD`, `WEBGPT_UPDATE_E2E_EXPECTED_VERSION`, and a CI-only sentinel path in test artifact metadata.
- E2E success is observed through a benign launch sentinel containing only `{ version, pid, platform, phase }`; production artifacts neither contain the control module nor E2E metadata.

- [ ] **Step 1: Write failing E2E-contract tests**

Create `test/update-e2e-contract.test.cjs`:

```js
test("production app has no runtime update feed override", () => {
  const main = fs.readFileSync(path.join(root, "src", "main.cjs"), "utf8");
  const preload = fs.readFileSync(path.join(root, "src", "preload.cjs"), "utf8");
  assert.doesNotMatch(main, /WEBGPT_UPDATE_FEED|setFeedURL\(/);
  assert.doesNotMatch(preload, /feed|url|repository/i);
});

test("production package excludes E2E control while generated E2E config opts in at build time", () => {
  const { createBuilderConfig } = require("../build/electron-builder-options.cjs");
  const production = createBuilderConfig({});
  assert.ok(production.files.includes("!src/update-e2e-control.cjs"));
  const script = fs.readFileSync(path.join(root, "scripts", "update-e2e-feed.cjs"), "utf8");
  assert.match(script, /provider:\s*["']generic["']/);
  assert.match(script, /WEBGPT_UPDATE_E2E_BUILD/);
  assert.match(script, /WEBGPT_UPDATE_E2E_EXPECTED_VERSION/);
  assert.match(script, /!src\/update-e2e-control\.cjs/);
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test test/update-e2e-contract.test.cjs
```

Expected: FAIL because harness scripts do not exist.

- [ ] **Step 3: Generate isolated E2E builder config without changing production feed code**

`scripts/update-e2e-feed.cjs` accepts `--url`, `--version`, `--expected-version`, `--sentinel`, `--out` and writes a temporary builder config that imports Task 1 config, opts the test artifact into the E2E control module, and overrides only build metadata/feed for the CI fixture:

```js
const base = createBuilderConfig(process.env);
base.publish = [{ provider: "generic", url }];
base.files = base.files.filter((entry) => entry !== "!src/update-e2e-control.cjs");
base.extraMetadata = {
  ...(base.extraMetadata || {}),
  version,
  WEBGPT_UPDATE_E2E_BUILD: true,
  WEBGPT_UPDATE_E2E_EXPECTED_VERSION: expectedVersion,
  WEBGPT_UPDATE_E2E_SENTINEL: sentinel,
};
fs.writeFileSync(out, `module.exports = ${JSON.stringify(base, null, 2)};\n`);
```

The generated config file lives under `$RUNNER_TEMP`/CI temp and is never committed or used by the formal production artifact build.

- [ ] **Step 4: Add an E2E-only control module that is absent from production artifacts**

Create `src/update-e2e-control.cjs` with one exported function. It calls the same public service methods the UI calls, but only inside an artifact whose packaged metadata explicitly opts in:

```js
const fs = require("node:fs");

function waitForState(service, predicate, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const state = service.getState();
      if (predicate(state)) {
        clearInterval(timer);
        resolve(state);
      } else if (Date.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(`update E2E state timeout: ${state.status}`));
      }
    }, 250);
    timer.unref?.();
  });
}

async function runUpdateE2EControl({ packageMeta, updateService, app }) {
  if (packageMeta.WEBGPT_UPDATE_E2E_BUILD !== true) return false;
  const expected = String(packageMeta.WEBGPT_UPDATE_E2E_EXPECTED_VERSION || "");
  const sentinel = String(packageMeta.WEBGPT_UPDATE_E2E_SENTINEL || "");
  if (!expected || !sentinel) throw new Error("invalid update E2E package metadata");

  if (app.getVersion() === expected) {
    fs.writeFileSync(sentinel, JSON.stringify({ version: app.getVersion(), pid: process.pid, platform: process.platform, phase: "updated" }));
    return true;
  }

  await updateService.checkForUpdates();
  await waitForState(updateService, (state) => state.status === "available");
  await updateService.downloadUpdate();
  await waitForState(updateService, (state) => state.status === "downloaded");
  fs.writeFileSync(sentinel, JSON.stringify({ version: app.getVersion(), pid: process.pid, platform: process.platform, phase: "installing" }));
  await updateService.installUpdateAndRestart();
  return true;
}

module.exports = { runUpdateE2EControl };
```

In `main.cjs`, read packaged metadata after the updater service exists. Only if `WEBGPT_UPDATE_E2E_BUILD === true`, dynamically require `./update-e2e-control.cjs` and call it. Production config from Task 1 excludes this file, so a normal shipped app cannot activate the control path even if an attacker sets environment variables.

- [ ] **Step 5: Build two isolated signed test versions and serve metadata locally**

Use fixed localhost port `18181` so the feed URL is known before packaging: `http://127.0.0.1:18181/`. In the Windows release job keep `WEBGPT_FORMAL_RELEASE=windows`; in the macOS release job keep `WEBGPT_FORMAL_RELEASE=macos`. Generate two temporary E2E builder configs so each platform uses the same real signing/notarization identity as its formal build without requiring the other platform's credentials:

```bash
node scripts/update-e2e-feed.cjs --url http://127.0.0.1:18181/ --version 90.0.0 --expected-version 90.0.1 --sentinel "$RUNNER_TEMP/webgpt-update-e2e.json" --out "$RUNNER_TEMP/e2e-old.cjs"
node scripts/update-e2e-feed.cjs --url http://127.0.0.1:18181/ --version 90.0.1 --expected-version 90.0.1 --sentinel "$RUNNER_TEMP/webgpt-update-e2e.json" --out "$RUNNER_TEMP/e2e-new.cjs"
```

Build the old and new package into separate output directories by overriding `directories.output` in the generated config (`$RUNNER_TEMP/e2e-old`, `$RUNNER_TEMP/e2e-new`) so metadata/assets never overwrite one another.

Create `scripts/update-e2e-assert.cjs` as a localhost static server plus sentinel verifier. CLI:

```bash
node scripts/update-e2e-assert.cjs --root "$RUNNER_TEMP/e2e-new" --port 18181 --sentinel "$RUNNER_TEMP/webgpt-update-e2e.json" --expected-version 90.0.1 --timeout-ms 240000
```

The server must bind only `127.0.0.1`, reject URL paths containing `..`, serve only files whose basename exists under `--root`, and keep running until the sentinel JSON contains `{ "version": "90.0.1", "phase": "updated" }`; then exit 0. Timeout, malformed sentinel, or server error exits nonzero.

For Windows: start the E2E server in a managed/background PowerShell process, silently install the signed `90.0.0` per-machine NSIS, launch the installed `WebGPT Bridge.exe`, wait for the assertion process to exit 0, then verify the updated installation's host-prep state is `ready`, SYSTEM task still has the fixed protected action, and the installed app reports version `90.0.1` through the sentinel.

For macOS: start the E2E server, copy the signed/notarized `90.0.0` app to a temporary writable application directory owned by the runner, launch it with `open -W`, wait for the assertion process to exit 0 after relaunch, and require the sentinel version `90.0.1`. Re-run `codesign --verify --deep --strict` on the updated app.

No Playwright, production debug IPC, runtime feed override, arbitrary updater IPC, or auto-install flag is introduced for this E2E path.

- [ ] **Step 6: Gate formal release publication on platform updater E2E**

Add Windows/macOS E2E steps before each platform uploads its Actions artifact. Formal platform job must fail if old -> new download/install/relaunch does not complete. Draft publication remains blocked because `publish` needs both platform jobs.

- [ ] **Step 7: Add user-facing documentation**

Update `README.md` with:

- application update card behavior;
- startup/6-hour checks are check-only;
- downloads and install/restart require user action;
- Windows per-machine update may show UAC;
- signed GitHub Release expected publisher and macOS Developer ID/Gatekeeper expectation;
- direct GitHub download can still receive early SmartScreen reputation warnings even with valid signing.

Update `docs/release-signing.md` with release dry-run checklist and exact `v${package.version}` tag rule.

- [ ] **Step 8: Run full local regression**

Run from root:

```bash
node scripts/verify-desktop.cjs
npm --prefix agent-runtime test
npm --prefix agent-runtime run lint
npm --prefix agent-runtime run contract
npm --prefix agent-runtime run build
npm --prefix agent-runtime run acceptance:quick
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/build-desktop.yml'); YAML.load_file('.github/workflows/release-desktop.yml'); puts 'YAML OK'"
git diff --check
```

Expected:

- Desktop: all tests pass;
- Agent: 0 failures, 23-tool contract unchanged;
- acceptance:quick exits 0;
- both workflows parse;
- diff check exits 0.

- [ ] **Step 9: Commit**

```bash
git add scripts/update-e2e-feed.cjs scripts/update-e2e-assert.cjs src/update-e2e-control.cjs test/update-e2e-contract.test.cjs src/main.cjs .github/workflows/release-desktop.yml README.md docs/release-signing.md
git commit -m "test: gate signed desktop auto updates end to end"
```

---

## Final Verification Before Claiming Completion

After all tasks are implemented, use `superpowers:verification-before-completion` and gather fresh evidence. Do not declare the feature complete from local tests alone.

Required final evidence:

1. Worktree clean; `git diff --check` passes.
2. Full Desktop suite passes.
3. Agent tests/lint/build/23-tool contract/acceptance:quick pass.
4. PR Windows x64 gate passes including standard-user AppContainer acceptance and reusable real NSIS lifecycle smoke.
5. PR macOS build gate passes with the updated Universal packaging configuration (unsigned PR artifacts are acceptable only because they are not formal releases).
6. A protected formal-release dry run proves missing Windows/macOS credentials fail closed and do not publish a stable release.
7. After real external identities are provisioned, one formal tagged release proves:
   - Windows installer/main/sandbox-helper/host-prep helper signatures are `Valid`, exact publisher matches `WEBGPT_WINDOWS_PUBLISHER`, timestamp exists;
   - Windows signed old -> new updater E2E relaunches into the newer version and host-prep remains ready;
   - macOS app has both `arm64` and `x86_64`, Developer ID identity matches, codesign/notarization/stapling/Gatekeeper checks pass;
   - macOS old -> new updater E2E relaunches into the newer version;
   - `latest.yml` and `latest-mac.yml` match exact uploaded bytes;
   - Draft remains invisible until both platforms pass, then becomes one public stable GitHub Release.
8. No merge of PR #4 or any release branch occurs unless the user explicitly requests it.
