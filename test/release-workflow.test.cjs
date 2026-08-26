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

test("release workflow has no external signing or notarization dependency", () => {
  const release = readReleaseWorkflow();
  assert.doesNotMatch(release, /environment:\s*desktop-release-(?:windows|macos)/);
  assert.doesNotMatch(release, /id-token:\s*write/);
  assert.doesNotMatch(release, /AZURE_|WEBGPT_WINDOWS_SIGN_|WEBGPT_MAC_IDENTITY|CSC_LINK|CSC_KEY_PASSWORD|APPLE_API_/);
  assert.doesNotMatch(release, /Get-AuthenticodeSignature|codesign\s+--verify|stapler\s+validate|spctl\s+--assess/);
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

test("macOS GitHub release stays Universal and publishes DMG plus ZIP without signing or notarization", () => {
  const release = readReleaseWorkflow();
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  assert.match(mac, /npm run dist:mac/);
  assert.match(mac, /lipo\s+-archs/);
  assert.match(mac, /Contents\/MacOS\/WebGPT Bridge/);
  assert.match(mac, /Contents\/Resources\/tunnel-client\/tunnel-client/);
  assert.match(mac, /Contents\/Resources\/tunnel-client\/cloudflared/);
  assert.match(mac, /WebGPT-Bridge-\*-mac-universal\.dmg/);
  assert.match(mac, /WebGPT-Bridge-\*-mac-universal\.zip/);
  assert.match(mac, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(mac, /WEBGPT_FORMAL_RELEASE|CSC_LINK|APPLE_API_|codesign|stapler|spctl/);
});

module.exports = { readReleaseWorkflow };
