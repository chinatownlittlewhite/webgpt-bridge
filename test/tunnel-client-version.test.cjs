const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = require("../scripts/tunnel-client-release.json");

const expected = Object.freeze({
  "darwin-arm64": Object.freeze({
    file: "tunnel-client-v0.0.14-darwin-arm64.zip",
    sha256: "b540493c5bdbcdbb755700c8e2e16597e28b1569e425007e0f73111047bd6a64",
  }),
  "darwin-amd64": Object.freeze({
    file: "tunnel-client-v0.0.14-darwin-amd64.zip",
    sha256: "75e10be774184fb42189e347b16eb6bc9fb0780135d8af714d34e30ce068dc53",
  }),
  "windows-amd64": Object.freeze({
    file: "tunnel-client-v0.0.14-windows-amd64.zip",
    sha256: "784ab8da7b5a88f0109f1fd8aaf0a1c86067430b896dddf307ef7e3cc49fa1a5",
  }),
});

test("desktop bundles the tunnel-client release that owns profile-dir and readyz semantics", () => {
  assert.equal(manifest.version, "0.0.14");
  assert.equal(manifest.baseUrl, "https://github.com/openai/tunnel-client/releases/download/v0.0.14");
  for (const [platform, asset] of Object.entries(expected)) {
    assert.equal(manifest.assets[platform].file, asset.file);
    assert.equal(manifest.assets[platform].sha256, asset.sha256);
  }

  const html = fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "index.html"), "utf8");
  assert.match(html, /留空使用内置 v0\.0\.14/);
  assert.doesNotMatch(html, /留空使用内置 v0\.0\.11/);
});
