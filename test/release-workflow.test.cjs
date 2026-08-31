const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const releasePath = path.join(root, ".github", "workflows", "release-desktop.yml");
const buildPath = path.join(root, ".github", "workflows", "build-desktop.yml");
const readReleaseWorkflow = () => fs.readFileSync(releasePath, "utf8");

test("GitHub release is isolated from PR CI and starts as draft", () => {
  const release = readReleaseWorkflow();
  const build = fs.readFileSync(buildPath, "utf8");
  assert.match(release, /push:\s*\n\s*tags:\s*\n\s*-\s*["']v\*["']/);
  assert.match(release, /gh release create[^\n]*--draft/);
  assert.match(release, /release:verify-tag/);
  assert.match(release, /needs:\s*\[[^\]]*windows[^\]]*macos[^\]]*\]/s);
  assert.match(release, /gh release edit[^\n]*--draft=false[^\n]*--prerelease=false[^\n]*--latest/);
  assert.doesNotMatch(build, /push:\s*\n\s*tags:/);
});

test("GitHub release supports explicit dispatch only when the selected ref is a real tag", () => {
  const release = readReleaseWorkflow();
  assert.match(release, /workflow_dispatch:/);
  assert.match(release, /GITHUB_REF_TYPE/);
  assert.match(release, /GITHUB_REF_TYPE[^\n]*tag|tag[^\n]*GITHUB_REF_TYPE/);
});

test("formal macOS release fails closed on signing and notarization credentials", () => {
  const release = readReleaseWorkflow();
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  assert.match(mac, /WEBGPT_FORMAL_RELEASE:\s*macos/);
  assert.match(mac, /CSC_LINK:\s*\$\{\{\s*secrets\.MACOS_CSC_LINK\s*\}\}/);
  assert.match(mac, /CSC_KEY_PASSWORD:\s*\$\{\{\s*secrets\.MACOS_CSC_KEY_PASSWORD\s*\}\}/);
  assert.match(mac, /WEBGPT_MAC_IDENTITY:\s*\$\{\{\s*secrets\.MACOS_SIGNING_IDENTITY\s*\}\}/);
  assert.match(mac, /APPLE_ID:\s*\$\{\{\s*secrets\.APPLE_ID\s*\}\}/);
  assert.match(mac, /APPLE_APP_SPECIFIC_PASSWORD:\s*\$\{\{\s*secrets\.APPLE_APP_SPECIFIC_PASSWORD\s*\}\}/);
  assert.match(mac, /APPLE_TEAM_ID:\s*\$\{\{\s*secrets\.APPLE_TEAM_ID\s*\}\}/);
  for (const name of [
    "MACOS_CSC_LINK",
    "MACOS_CSC_KEY_PASSWORD",
    "MACOS_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]) {
    assert.match(mac, new RegExp(`missing.*${name}|${name}.*missing`, "i"));
  }
});

test("platform jobs cannot publish directly and publication waits for both validated artifacts", () => {
  const release = readReleaseWorkflow();
  const windows = release.slice(release.indexOf("  windows:"), release.indexOf("  macos:"));
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  const publish = release.slice(release.indexOf("  publish:"));
  assert.doesNotMatch(windows, /contents:\s*write/);
  assert.doesNotMatch(mac, /contents:\s*write/);
  assert.match(publish, /needs:\s*\[[^\]]*windows[^\]]*macos[^\]]*\]/s);
  assert.match(publish, /validate-release-assets\.cjs/);
  assert.match(publish, /write-release-checksums\.cjs/);
  assert.doesNotMatch(publish, /--clobber/);
});

test("release artifacts whitelist distributables instead of uploading the whole builder directory", () => {
  const release = readReleaseWorkflow();
  const windows = release.slice(release.indexOf("  windows:"), release.indexOf("  macos:"));
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  assert.doesNotMatch(windows, /path:\s*release\/\*/);
  assert.match(windows, /release\/WebGPT-Bridge-\*-win-x64\.exe/);
  assert.match(windows, /release\/latest\.yml/);
  assert.doesNotMatch(mac, /path:\s*release\/\*/);
  assert.match(mac, /release\/WebGPT-Bridge-\*-mac-universal\.dmg/);
  assert.match(mac, /release\/WebGPT-Bridge-\*-mac-universal\.zip/);
  assert.match(mac, /release\/latest-mac\.yml/);
  assert.doesNotMatch(release, /builder-debug\.yml|builder-effective-config\.yaml/);
});

test("Windows GitHub release keeps native acceptance and installer lifecycle smoke without signing", () => {
  const release = readReleaseWorkflow();
  const windows = release.slice(release.indexOf("  windows:"), release.indexOf("  macos:"));
  assert.match(windows, /actions\/setup-dotnet@v4/);
  assert.match(windows, /npm --prefix agent-runtime run build:native/);
  assert.match(windows, /-ArgumentList\s+@\("--prefix",\s*"agent-runtime",\s*"run",\s*"acceptance",\s*"--",\s*"--prebuilt-native"\)/);
  assert.match(windows, /npm run dist:win/);
  assert.match(windows, /windows-installer-smoke\.ps1/);
  assert.match(windows, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(windows, /WEBGPT_FORMAL_RELEASE|Get-AuthenticodeSignature|AZURE_|id-token:\s*write/);
});

test("macOS release signs, notarizes, staples, and passes Gatekeeper before upload", () => {
  const release = readReleaseWorkflow();
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  assert.match(mac, /npm run dist:mac/);
  assert.match(mac, /lipo\s+-archs/);
  assert.match(mac, /Contents\/MacOS\/WebGPT Bridge/);
  assert.match(mac, /Contents\/Resources\/tunnel-client\/tunnel-client/);
  assert.match(mac, /Contents\/Resources\/tunnel-client\/cloudflared/);
  assert.match(mac, /codesign\s+--verify[^\n]*--deep[^\n]*--strict/);
  assert.match(mac, /xcrun\s+stapler\s+validate/);
  assert.match(mac, /spctl\s+--assess[^\n]*--type\s+open/);
  assert.match(mac, /WebGPT-Bridge-\*-mac-universal\.dmg/);
  assert.match(mac, /WebGPT-Bridge-\*-mac-universal\.zip/);
  assert.match(mac, /actions\/upload-artifact@v4/);
});

module.exports = { readReleaseWorkflow };
