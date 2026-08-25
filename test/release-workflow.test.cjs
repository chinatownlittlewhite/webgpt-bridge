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

module.exports = { readReleaseWorkflow };
