const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = require("../scripts/tunnel-client-release.json");

const expected = Object.freeze({
  "darwin-arm64": Object.freeze({
    file: "tunnel-client-v0.0.13-darwin-arm64.zip",
    sha256: "15abf165f06050af642c948ba6bd6c905191dc5420a9422dadde2b49d892e2c6",
  }),
  "darwin-amd64": Object.freeze({
    file: "tunnel-client-v0.0.13-darwin-amd64.zip",
    sha256: "c683e15d84fb997f5af1cc7c4cb55008e19a555a9ed2ec0f89a5ff426d85f85c",
  }),
  "windows-amd64": Object.freeze({
    file: "tunnel-client-v0.0.13-windows-amd64.zip",
    sha256: "17113162b353906bbb884c3ed7620facba5cc72b5fdc94fd54fd7208c7166edb",
  }),
});

test("desktop bundles the tunnel-client release that owns profile-dir and readyz semantics", () => {
  assert.equal(manifest.version, "0.0.13");
  assert.equal(manifest.baseUrl, "https://github.com/openai/tunnel-client/releases/download/v0.0.13");
  for (const [platform, asset] of Object.entries(expected)) {
    assert.equal(manifest.assets[platform].file, asset.file);
    assert.equal(manifest.assets[platform].sha256, asset.sha256);
  }

  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /留空使用内置 v0\.0\.13/);
  assert.doesNotMatch(html, /留空使用内置 v0\.0\.11/);
});
