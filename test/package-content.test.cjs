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
