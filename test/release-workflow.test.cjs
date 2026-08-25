const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const releasePath = path.join(root, ".github", "workflows", "release-desktop.yml");
const buildPath = path.join(root, ".github", "workflows", "build-desktop.yml");
const readReleaseWorkflow = () => fs.readFileSync(releasePath, "utf8");

test("formal release is isolated from PR CI and starts as draft", () => {
  const release = readReleaseWorkflow();
  const build = fs.readFileSync(buildPath, "utf8");
  assert.match(release, /push:\s*\n\s*tags:\s*\n\s*-\s*["']v\*["']/);
  assert.match(release, /gh release create[^\n]*--draft/);
  assert.match(release, /release:verify-tag/);
  assert.match(release, /needs:\s*\[[^\]]*windows[^\]]*macos[^\]]*\]/s);
  assert.match(release, /gh release edit[^\n]*--draft=false/);
  assert.doesNotMatch(build, /push:\s*\n\s*tags:/);
});

test("formal signing credentials are scoped away from PR workflow", () => {
  const build = fs.readFileSync(buildPath, "utf8");
  assert.doesNotMatch(build, /AZURE_FEDERATED_TOKEN_FILE|APPLE_API_KEY|CSC_LINK|WEBGPT_FORMAL_RELEASE/);
});

test("platform jobs cannot publish directly and publish waits for both", () => {
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

test("Windows formal release uses OIDC and never falls back to unsigned output", () => {
  const release = readReleaseWorkflow();
  const windows = release.slice(release.indexOf("  windows:"), release.indexOf("  macos:"));
  assert.match(windows, /permissions:[\s\S]*id-token:\s*write/);
  assert.match(windows, /environment:\s*desktop-release-windows/);
  assert.match(windows, /AZURE_FEDERATED_TOKEN_FILE/);
  assert.match(windows, /WEBGPT_FORMAL_RELEASE:\s*["']windows["']/);
  assert.match(windows, /Get-AuthenticodeSignature/);
  assert.match(windows, /Status[^\n]*Valid/);
  assert.match(windows, /WEBGPT_WINDOWS_PUBLISHER/);
  assert.match(windows, /windows-installer-smoke\.ps1/);
  assert.match(windows, /-ArgumentList\s+@\("--prefix",\s*"agent-runtime",\s*"run",\s*"acceptance",\s*"--",\s*"--prebuilt-native"\)/);
  assert.doesNotMatch(windows, /AZURE_CLIENT_SECRET/);
  assert.doesNotMatch(windows, /unsigned fallback|continue-on-error:\s*true/i);
});

test("formal macOS release is universal signed notarized and Gatekeeper checked", () => {
  const release = readReleaseWorkflow();
  const mac = release.slice(release.indexOf("  macos:"), release.indexOf("  publish:"));
  assert.match(mac, /environment:\s*desktop-release-macos/);
  assert.match(mac, /WEBGPT_FORMAL_RELEASE:\s*["']macos["']/);
  assert.match(mac, /CSC_LINK/);
  assert.match(mac, /CSC_KEY_PASSWORD/);
  assert.match(mac, /APPLE_API_KEY_BASE64/);
  assert.match(mac, /APPLE_API_KEY_ID/);
  assert.match(mac, /APPLE_API_ISSUER/);
  assert.match(mac, /APPLE_API_KEY=/);
  assert.match(mac, /lipo\s+-archs/);
  assert.match(mac, /Contents\/MacOS\/WebGPT Bridge/);
  assert.match(mac, /Contents\/Resources\/tunnel-client\/tunnel-client/);
  assert.match(mac, /Contents\/Resources\/tunnel-client\/cloudflared/);
  assert.match(mac, /codesign\s+--verify/);
  assert.match(mac, /xcrun\s+stapler\s+validate/);
  assert.match(mac, /spctl\s+--assess/);
  assert.match(mac, /Remove-Item|rm -f/);
  assert.doesNotMatch(mac, /xattr\s+-cr|unsigned fallback|continue-on-error:\s*true/i);
});

module.exports = { readReleaseWorkflow };
