const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const packageJson = require("../package.json");

test("packaging excludes Agent runtime state and npm logs", () => {
  assert.ok(packageJson.build.files.includes("!agent-runtime/.webgpt-bridge{,/**}"));
  assert.ok(packageJson.build.files.includes("!agent-runtime/.npm{,/**}"));
});

test("desktop host enables the dedicated network-tool sandbox", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(mainSource, /LPC_ENABLE_NETWORK_TOOLS:\s*"true"/);
});

test("desktop host re-resolves GitHub CLI for every agent start and passes a trusted binding", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(mainSource, /resolveDesktopGitHubCli/);
  assert.match(mainSource, /LPC_GITHUB_CLI_PATH:\s*githubCliPath/);
  assert.match(mainSource, /trustedExecutables:\s*githubCliPath\s*\?\s*\{\s*gh:\s*githubCliPath\s*\}/);
  assert.match(mainSource, /additionalPaths:[\s\S]*path\.dirname\(githubCliPath\)/);
});

test("desktop UI exposes four permission levels without a development Agent mode", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, />谨慎</);
  assert.match(html, />工作区自动（推荐）</);
  assert.match(html, />高自治</);
  assert.match(html, /value="full_control">完全控制（无确认）</);
  assert.match(html, /同类权限.*本次连接.*自动记住/);
  assert.match(html, /完全控制.*不会显示权限确认/);
  assert.doesNotMatch(html, /桌面开发版|developmentPath|Agent 模式/);
});

test("bundled tunnel-client is the default and custom path is advanced-only", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  const required = html.match(/<div class="grid required-grid">([\s\S]*?)<\/div>/)?.[1] || "";
  assert.doesNotMatch(required, /tunnelClientPath|tunnel-client/);
  assert.match(html, /自定义 tunnel-client（可选）/);
  assert.match(html, /留空使用内置 v0\.0\.11/);

  const extras = packageJson.build.extraResources || [];
  assert.ok(extras.some((item) => item.from === "build/tunnel-client" && item.to === "tunnel-client"));
  assert.match(packageJson.scripts["dist:mac"], /prepare:tunnel-client:mac/);
  assert.match(packageJson.scripts["dist:win"], /prepare:tunnel-client:win/);

  const manifest = require("../scripts/tunnel-client-release.json");
  assert.equal(manifest.version, "0.0.11");
  for (const key of ["darwin-arm64", "windows-amd64"]) {
    assert.match(manifest.assets[key].sha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.assets[key].file, `tunnel-client-v0.0.11-${key}.zip`);
  }
});

test("Windows installer is per-machine NSIS and owns fixed host-preparation lifecycle", () => {
  assert.doesNotMatch(packageJson.scripts["dist:win"], /\bzip\b/);
  assert.deepEqual(packageJson.build.win.target, ["nsis"]);
  assert.equal(packageJson.build.nsis.perMachine, true);
  assert.equal(packageJson.build.nsis.allowToChangeInstallationDirectory, false);
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  const gitignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.match(gitignore, /^!build\/installer\.nsh$/m, "the NSIS source include must be tracked even though generated build outputs are ignored");

  const installer = fs.readFileSync(path.join(__dirname, "..", "build", "installer.nsh"), "utf8");
  assert.match(installer, /!macro customInit/);
  const customInitStart = installer.indexOf("!macro customInit");
  const customInitEnd = installer.indexOf("!macroend", customInitStart);
  assert.ok(customInitStart >= 0 && customInitEnd > customInitStart, "installer must define a bounded customInit macro");
  const customInit = installer.slice(customInitStart, customInitEnd);
  assert.match(customInit, /\$PROGRAMFILES/);
  assert.match(customInit, /\$PROGRAMFILES64/);
  assert.match(customInit, /\$\{RunningX64\}/);
  assert.match(customInit, /\$\{APP_FILENAME\}/);
  assert.match(customInit, /StrCpy\s+\$INSTDIR/);
  assert.doesNotMatch(customInit, /GetDParameter|\$CMDLINE|\/D=/i, "customInit must ignore command-line installation-directory overrides");
  assert.match(installer, /!macro customInstall/);
  assert.match(installer, /!macro customUnInstall/);
  assert.match(installer, /WebGPT Bridge Host Preparation/);
  assert.match(installer, /lpc-windows-host-prep\.exe/);
  assert.match(installer, /--apply/);
  assert.match(installer, /--remove/);
  assert.match(installer, /\/RU SYSTEM/);
  assert.match(installer, /\/SC ONSTART/);
  assert.match(installer, /\/RL HIGHEST/);
  assert.ok(installer.includes('!define WEBGPT_BRIDGE_HOST_PREP_RELATIVE "resources\\app.asar.unpacked\\agent-runtime\\native\\windows-host-prep\\bin\\release\\lpc-windows-host-prep.exe"'));
  assert.ok(installer.includes('$INSTDIR\\${WEBGPT_BRIDGE_HOST_PREP_RELATIVE}'));
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
  const acceptance = windows.indexOf("npm --prefix agent-runtime run acceptance");
  assert.ok(nativeBuild >= 0 && firstApply > nativeBuild, "host preparation must run only after native helpers are built");
  assert.ok(secondApply > firstApply, "host preparation apply must be exercised twice for idempotence");
  assert.ok(check > secondApply, "host preparation must be checked after repeated apply");
  assert.match(windows, /New-LocalUser/);
  assert.match(windows, /Get-LocalGroupMember[^\n]*Administrators/);
  assert.match(windows, /Start-Process[\s\S]*-Credential/);
  assert.match(windows, /Remove-LocalUser/);
  assert.ok(acceptance > check, "the standard-user acceptance command must run after host preparation is ready");
  assert.match(windows, /if:\s*always\(\)[\s\S]*--remove/);
});

test("platform dist scripts enforce desktop tests and native Agent acceptance before packaging", () => {
  assert.equal(packageJson.scripts["verify:desktop"], "node scripts/verify-desktop.cjs");
  for (const name of ["dist:mac", "dist:win"]) {
    assert.match(packageJson.scripts[name], /npm run verify:desktop/);
    assert.match(packageJson.scripts[name], /npm --prefix agent-runtime run acceptance/);
    assert.match(packageJson.scripts[name], /electron-builder .*--publish never/);
  }
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
  assert.equal(packageJson.build.mac.icon, "build/icon.icns");
  assert.equal(packageJson.scripts["build:icon"], "node scripts/build-icon.cjs");
  assert.match(packageJson.scripts["dist:mac"], /npm run build:icon/);
  const generator = fs.readFileSync(path.join(__dirname, "..", "scripts", "build-icon.cjs"), "utf8");
  assert.match(generator, /function renderPng/);
  assert.match(generator, /function buildIcns/);
  assert.doesNotMatch(generator, /sips|iconutil|electron/i);
});
