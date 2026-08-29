const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");
const builderConfig = createBuilderConfig({});


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
  assert.equal(config.nsis.allowToChangeInstallationDirectory, true);
  assert.deepEqual(config.mac.target, ["dmg", "zip"]);
  assert.equal(config.mac.mergeASARs, false, "universal packaging must not rebuild the fully unpacked Agent runtime into one giant ASAR glob");
  assert.deepEqual(config.asarUnpack, [
    "agent-runtime/dist/**/*",
    "agent-runtime/node_modules/**/*",
    "agent-runtime/package.json",
    "agent-runtime/native/windows-host/bin/release/**/*",
    "shared/**/*",
  ], "the production Agent runtime and shared broker protocol must remain on the real filesystem without unpacking development sources");
  assert.equal(config.mac.x64ArchFiles, "**/{node-pty/prebuilds/darwin-*/pty.node,node-pty/prebuilds/darwin-*/spawn-helper,node-pty-helper/darwin-*/spawn-helper}");
});

test("formal builder config scopes credentials to one platform and fails closed", () => {
  assert.throws(() => createBuilderConfig({ WEBGPT_FORMAL_RELEASE: "windows" }), /WEBGPT_WINDOWS_PUBLISHER/);
  assert.throws(() => createBuilderConfig({ WEBGPT_FORMAL_RELEASE: "macos" }), /WEBGPT_MAC_IDENTITY/);
  assert.throws(() => createBuilderConfig({ WEBGPT_FORMAL_RELEASE: "linux" }), /WEBGPT_FORMAL_RELEASE must be windows or macos/);

  const windows = createBuilderConfig({
    WEBGPT_FORMAL_RELEASE: "windows",
    WEBGPT_WINDOWS_PUBLISHER: "CN=WebGPT Bridge",
    WEBGPT_WINDOWS_SIGN_ENDPOINT: "https://example.codesigning.azure.net/",
    WEBGPT_WINDOWS_SIGN_ACCOUNT: "webgpt-signing",
    WEBGPT_WINDOWS_SIGN_PROFILE: "public-trust",
  });
  assert.equal(windows.win.forceCodeSigning, true);
  assert.equal(windows.win.azureSignOptions.publisherName, "CN=WebGPT Bridge");
  assert.equal(windows.win.azureSignOptions.codeSigningAccountName, "webgpt-signing");
  assert.equal(windows.win.azureSignOptions.certificateProfileName, "public-trust");
  assert.equal(windows.mac.forceCodeSigning, undefined);
});

test("current release policy documents unsigned GitHub distribution and controlled prerelease replacement", () => {
  const docs = fs.readFileSync(path.join(__dirname, "..", "docs", "release-signing.md"), "utf8");
  assert.match(docs, /without requiring external code-signing or Apple notarization credentials/);
  assert.match(docs, /published prerelease may be deleted and rebuilt under the same version/);
  assert.match(docs, /Never overwrite a stable public release/);
  assert.doesNotMatch(docs, /AZURE_CLIENT_SECRET/);
});

test("packaging contains only production Agent runtime payload and bounded Electron locales", () => {
  assert.ok(builderConfig.files.includes("agent-runtime/dist/**/*"));
  assert.ok(builderConfig.files.includes("agent-runtime/node_modules/**/*"));
  assert.ok(builderConfig.files.includes("agent-runtime/package.json"));
  assert.ok(builderConfig.files.includes("agent-runtime/native/windows-host/bin/release/**/*"));
  assert.ok(builderConfig.files.includes("shared/**/*"));
  assert.equal(builderConfig.files.includes("agent-runtime/**/*"), false);
  assert.equal(builderConfig.files.some((entry) => /agent-runtime\/(?:src|test|scripts)\/\*\*/.test(entry)), false);
  assert.deepEqual(builderConfig.asarUnpack, [
    "agent-runtime/dist/**/*",
    "agent-runtime/node_modules/**/*",
    "agent-runtime/package.json",
    "agent-runtime/native/windows-host/bin/release/**/*",
    "shared/**/*",
  ]);
  assert.deepEqual(builderConfig.electronLanguages, ["en-US", "zh-CN", "zh-TW", "ja"]);
});

test("canonical tool registry is part of the packaged shared runtime payload", () => {
  const registryPath = path.join(__dirname, "..", "shared", "tool-registry.cjs");
  assert.equal(fs.existsSync(registryPath), true);
  assert.ok(builderConfig.files.includes("shared/**/*"), "shared/tool-registry.cjs must be included in packaged files");
  assert.ok(builderConfig.asarUnpack.includes("shared/**/*"), "shared/tool-registry.cjs must remain available to the unpacked Agent runtime");
});

test("desktop host enables the dedicated network-tool sandbox", () => {
  const runtimeHost = fs.readFileSync(path.join(__dirname, "..", "src", "host", "runtime-host.cjs"), "utf8");
  assert.match(runtimeHost, /LPC_ENABLE_NETWORK_TOOLS:\s*"true"/);
});

test("desktop host re-resolves GitHub CLI for every agent start and passes a trusted binding", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  const runtimeHost = fs.readFileSync(path.join(__dirname, "..", "src", "host", "runtime-host.cjs"), "utf8");
  const brokerServer = fs.readFileSync(path.join(__dirname, "..", "src", "host", "broker-server.cjs"), "utf8");
  assert.match(mainSource, /resolveDesktopGitHubCli/);
  assert.match(runtimeHost, /LPC_GITHUB_CLI_PATH:\s*githubCliPath/);
  assert.match(brokerServer, /const trustedExecutables = \{[\s\S]{0,260}githubCliPath \? \{ gh: githubCliPath \} : \{\}/);
  assert.match(brokerServer, /createLocalTerminalBroker\(\{[\s\S]{0,500}trustedExecutables,/);
  assert.match(runtimeHost, /additionalPaths:[\s\S]*path\.dirname\(githubCliPath\)/);
});

test("desktop UI exposes four permission levels without a development Agent mode", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, />谨慎</);
  assert.match(html, />工作区自动（推荐）</);
  assert.match(html, />高自治</);
  assert.match(html, /value="full_control">完全控制（保留安全边界）</);
  assert.match(html, /同类低风险权限.*本次连接内记住/);
  assert.match(html, /完全控制.*只减少允许范围内的确认.*不会绕过敏感路径、Shell、SSH 校验、提权或沙箱边界/);
  assert.doesNotMatch(html, /桌面开发版|developmentPath|Agent 模式/);
});

test("bundled tunnel-client is the default and custom path is advanced-only", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const required = html.match(/<div class="grid required-grid">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.doesNotMatch(required, /tunnelClientPath|tunnel-client/);
  assert.match(html, /自定义 tunnel-client（可选）/);
  assert.match(html, /留空使用内置 v0\.0\.13/);

  const extras = builderConfig.extraResources || [];
  assert.ok(extras.some((item) => item.from === "build/tunnel-client" && item.to === "tunnel-client"));
  assert.match(packageJson.scripts["dist:mac"], /prepare:tunnel-client:mac/);
  assert.match(packageJson.scripts["dist:win"], /prepare:tunnel-client:win/);

  const manifest = require("../scripts/tunnel-client-release.json");
  assert.equal(manifest.version, "0.0.13");
  assert.equal(packageJson.scripts["prepare:tunnel-client:mac"], "node scripts/launch-tunnel-client-prepare.cjs darwin-universal");
  for (const key of ["darwin-arm64", "windows-amd64"]) {
    assert.match(manifest.assets[key].sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.assets[key].file, `tunnel-client-v0.0.13-${key}.zip`);
  }
  assert.equal(manifest.assets["darwin-amd64"].file, "tunnel-client-v0.0.13-darwin-amd64.zip");
  assert.equal(manifest.assets["darwin-amd64"].sha256, "c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c");
  const prepare = fs.readFileSync(path.join(__dirname, "..", "scripts", "prepare-tunnel-client.cjs"), "utf8");
  assert.match(prepare, /darwin-universal/);
  assert.match(prepare, /\/usr\/bin\/lipo/);
  assert.match(prepare, /darwin-arm64/);
  assert.match(prepare, /darwin-amd64/);
});

test("formal mac builder signs embedded native binaries and notarizes", () => {
  const config = createBuilderConfig({
    WEBGPT_FORMAL_RELEASE: "macos",
    WEBGPT_MAC_IDENTITY: "Developer ID Application: WebGPT Bridge (TEAMID1234)",
  });
  assert.equal(config.mac.forceCodeSigning, true);
  assert.equal(config.mac.identity, "Developer ID Application: WebGPT Bridge (TEAMID1234)");
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.entitlements, "build/entitlements.mac.plist");
  assert.equal(config.mac.entitlementsInherit, "build/entitlements.mac.plist");
  assert.ok(config.mac.binaries.includes("Contents/Resources/tunnel-client/tunnel-client"));
  assert.ok(config.mac.binaries.includes("Contents/Resources/tunnel-client/cloudflared"));
});

test("mac entitlements stay minimal", () => {
  const plist = fs.readFileSync(path.join(__dirname, "..", "build", "entitlements.mac.plist"), "utf8");
  assert.match(plist, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(plist, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.doesNotMatch(plist, /disable-library-validation|allow-dyld-environment-variables/);
});

test("Windows installer is per-machine NSIS and owns fixed host-preparation lifecycle", () => {
  assert.doesNotMatch(packageJson.scripts["dist:win"], /\bzip\b/);
  assert.deepEqual(builderConfig.win.target, ["nsis"]);
  assert.equal(builderConfig.nsis.perMachine, true);
  assert.equal(builderConfig.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(builderConfig.nsis.include, "build/installer.nsh");
  const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.match(gitignore, /^!build\/installer\.nsh$/m, "the NSIS source include must be tracked even though generated build outputs are ignored");

  const installer = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");
  assert.doesNotMatch(installer, /!macro customInit[\s\S]*StrCpy\s+\$INSTDIR/, "installer must not re-pin the directory chosen by the assisted installer");
  assert.match(installer, /WEBGPT_BRIDGE_PROTECTED_HOST_ROOT/);
  assert.match(installer, /\$PROGRAMFILES64|\$PROGRAMFILES/);
  assert.match(installer, /CopyFiles[\s\S]*lpc-windows-host\.exe/);
  assert.match(installer, /CopyFiles[\s\S]*windows-host-prep-task\.xml/);
  assert.match(installer, /!macro customInstall/);
  assert.match(installer, /!macro customUnInstall/);
  assert.match(installer, /WebGPT Bridge Host Preparation/);
  assert.match(installer, /lpc-windows-host\.exe/);
  assert.match(installer, /--apply/);
  assert.match(installer, /--remove/);
  assert.match(installer, /\/RU SYSTEM/);
  assert.match(installer, /\/SC ONSTART/);
  assert.match(installer, /\/RL HIGHEST/);
  assert.ok(installer.includes('!define WEBGPT_BRIDGE_HOST_RELATIVE "resources\\app.asar.unpacked\\agent-runtime\\native\\windows-host\\bin\\release\\lpc-windows-host.exe"'));
  assert.match(installer, /StrCpy\s+\$9\s+"\$PROGRAMFILES(?:64)?\\\$\{WEBGPT_BRIDGE_PROTECTED_HOST_ROOT\}"/);
  assert.match(installer, /\$9\\lpc-windows-host\.exe/);
  assert.doesNotMatch(installer, /ExecWait\s+'"\$INSTDIR\\\$\{WEBGPT_BRIDGE_HOST_RELATIVE\}"/, "host preparation must never execute a helper from a user-selectable install directory");
  assert.match(installer, /ExecWait\s+'"\$9\\lpc-windows-host\.exe" host-prep --apply'/);
  const hostPrepTask = fs.readFileSync(path.join(__dirname, "..", "build", "windows-host-prep-task.xml"), "utf8");
  assert.match(hostPrepTask, /%ProgramFiles%\\WebGPT Bridge Host\\lpc-windows-host\.exe/);
  assert.doesNotMatch(hostPrepTask, /WebGPT Bridge\\resources|%LOCALAPPDATA%|%APPDATA%/i);
  assert.doesNotMatch(installer, /\$TEMP|\$APPDATA|\$LOCALAPPDATA/);

  const createTask = installer.indexOf('/Create /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}"');
  const apply = installer.indexOf('--apply');
  assert.ok(createTask >= 0 && apply > createTask, "SYSTEM task must be registered before mutating the null-device security descriptor");
  const applyFailure = installer.indexOf('host preparation failed');
  assert.ok(applyFailure > apply, "installer must have an explicit host-prep failure branch");
  const rollbackDelete = installer.indexOf('/Delete /TN "${WEBGPT_BRIDGE_HOST_PREP_TASK}"', apply);
  assert.ok(rollbackDelete > apply && rollbackDelete < applyFailure, "failed host preparation must delete the newly registered SYSTEM task before aborting");
});

test("desktop release workflow delegates platform preparation to the dist scripts", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");
  assert.match(workflow, /macOS universal[\s\S]*npm run dist:mac/);
  assert.match(workflow, /Windows x64[\s\S]*npm run dist:win/);
  assert.doesNotMatch(workflow, /prepare:tunnel-client:/);
});

test("desktop pull requests trigger the Windows native acceptance workflow", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");
  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\n\s*-\s*main/);
});

test("Windows CI runs native Agent acceptance as a hard gate before desktop packaging", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");
  const windows = workflow.slice(workflow.indexOf("  windows:"));
  const dotnetSetup = windows.indexOf("actions/setup-dotnet@v4");
  const dependencyInstall = windows.indexOf("npm --prefix agent-runtime ci");
  const acceptance = windows.indexOf("npm --prefix agent-runtime run acceptance");
  const packaging = windows.indexOf("npm run dist:win");
  assert.ok(dotnetSetup >= 0, "Windows build host must install a .NET 8 SDK for self-contained helper publishing");
  assert.match(windows, /dotnet-version:\s*["']?8\.0\.x["']?/);
  assert.ok(dependencyInstall > dotnetSetup, "agent-runtime dependency installation must run after build-host SDK setup");
  assert.ok(acceptance > dependencyInstall, "Windows native acceptance must run after agent-runtime dependencies are installed");
  assert.ok(packaging > acceptance, "Windows packaging must not run until native acceptance passes");
});

test("Windows CI provisions host preparation and runs acceptance as an ephemeral standard user", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");
  const windows = workflow.slice(workflow.indexOf("  windows:"));
  const nativeBuild = windows.indexOf("npm --prefix agent-runtime run build:native");
  const firstApply = windows.indexOf("--apply");
  const secondApply = windows.indexOf("--apply", firstApply + 1);
  const check = windows.indexOf("--check --json");
  const repairRemove = windows.indexOf("--remove", check);
  const removedCheck = windows.indexOf("--check --json", repairRemove);
  const repairApply = windows.indexOf("--apply", removedCheck);
  const repairedCheck = windows.indexOf("--check --json", repairApply);
  const acceptance = windows.indexOf("npm --prefix agent-runtime run acceptance");
  assert.ok(nativeBuild >= 0 && firstApply > nativeBuild, "host preparation must run only after native helpers are built");
  assert.ok(secondApply > firstApply, "host preparation apply must be exercised twice for idempotence");
  assert.ok(check > secondApply, "host preparation must be checked after repeated apply");
  assert.ok(repairRemove > check, "CI must exercise removal after proving the initial ready state");
  assert.ok(removedCheck > repairRemove, "CI must verify host preparation is not ready after removal");
  assert.ok(repairApply > removedCheck, "CI must exercise repair after removal");
  assert.ok(repairedCheck > repairApply, "CI must verify host preparation returns to ready after repair");
  assert.match(windows, /capability_ace_missing/);
  assert.match(windows, /New-LocalUser/);
  assert.match(windows, /Get-LocalGroupMember[^\n]*Administrators/);
  assert.match(windows, /Start-Process[\s\S]*-Credential/);
  assert.match(windows, /-ArgumentList\s+@\("--prefix",\s*"agent-runtime",\s*"run",\s*"acceptance",\s*"--",\s*"--prebuilt-native"\)/);
  assert.match(windows, /Write-Host\s+"Running as \$\{qualified\}: \$acceptanceCommand"/);
  assert.doesNotMatch(windows, /Write-Host\s+"Running as \$qualified:/);
  assert.match(windows, /Remove-LocalUser/);
  assert.ok(acceptance > repairedCheck, "the standard-user acceptance command must run only after remove/reapply repair returns host preparation to ready");
  assert.match(windows, /if:\s*always\(\)[\s\S]*--remove/);
});

test("Windows installer lifecycle smoke is reusable by PR and release CI", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "build-desktop.yml"), "utf8");
  const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-installer-smoke.ps1"), "utf8");
  const windows = workflow.slice(workflow.indexOf("  windows:"));
  const packaging = windows.indexOf("npm run dist:win");
  const smoke = windows.indexOf("windows-installer-smoke.ps1");
  const upload = windows.indexOf("actions/upload-artifact@v4");
  assert.ok(packaging >= 0 && smoke > packaging, "the reusable installer smoke must run after NSIS packaging");
  assert.ok(upload > smoke, "artifact upload must wait for reusable installer smoke");
  assert.match(workflow, /windows-installer-smoke\.ps1/);
  assert.match(script, /capability_ace_missing/);
  assert.match(script, /Get-ScheduledTask/);
  assert.match(script, /Principal\.UserId/);
  assert.match(script, /Principal\.RunLevel/);
  assert.match(script, /MSFT_TaskBootTrigger/);
  assert.match(script, /Arguments[^\n]*--apply/);
  assert.match(script, /installed host-prep payload remained after uninstall/);
  assert.match(script, /finally/);
  assert.match(script, /Write-Warning/);
});

test("platform dist scripts enforce desktop tests and native Agent acceptance before packaging", () => {
  assert.equal(packageJson.scripts["verify:desktop"], "node scripts/verify-desktop.cjs");
  for (const name of ["dist:mac", "dist:win"]) {
    assert.match(packageJson.scripts[name], /npm run verify:desktop/);
    assert.match(packageJson.scripts[name], /npm --prefix agent-runtime run acceptance/);
    assert.match(packageJson.scripts[name], /electron-builder .*--publish never/);
  }
});

test("root package exposes standard safe test and lint entrypoints for project verification", () => {
  assert.equal(packageJson.scripts.test, "npm run verify:desktop");
  assert.equal(packageJson.scripts.lint, "npm --prefix agent-runtime run lint");
});

test("hidden macOS title bar provides a draggable header while controls remain interactive", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles.css"), "utf8");
  assert.match(css, /\.app-header[^}]*-webkit-app-region:\s*drag/s);
  assert.match(css, /button[^}]*-webkit-app-region:\s*no-drag/s);
  assert.match(css, /select[^}]*-webkit-app-region:\s*no-drag/s);
});

test("desktop visual system uses the refreshed bridge mark and polished surface tokens", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "styles.css"), "utf8");
  const icon = fs.readFileSync(path.join(__dirname, "..", "build", "icon.svg"), "utf8");
  assert.match(html, /brand-mark/);
  assert.match(css, /--surface:/);
  assert.match(css, /backdrop-filter:/);
  assert.match(icon, /linearGradient/);
  assert.match(icon, /bridge-node/);
});

test("mac packaging uses a reproducible generated icns asset", () => {
  assert.equal(builderConfig.mac.icon, "build/icon.icns");
  assert.equal(packageJson.scripts["build:icon"], "node scripts/build-icon.cjs");
  assert.match(packageJson.scripts["dist:mac"], /npm run build:icon/);
  assert.match(packageJson.scripts["dist:mac"], /--universal/);
  const generator = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-icon.cjs"), "utf8");
  assert.match(generator, /function renderPng/);
  assert.match(generator, /function buildIcns/);
  assert.doesNotMatch(generator, /sips|iconutil|electron/i);
});
