const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("public metadata describes the current unsigned distribution truthfully", () => {
  const pkg = JSON.parse(read("package.json"));
  const readme = read("README.md");
  const signing = read("docs/release-signing.md");
  assert.equal(pkg.private, true, "desktop package must not be publishable to npm accidentally");
  assert.match(signing, /without requiring external code-signing or Apple notarization credentials/i);
  assert.match(readme, /当前[^\n]*(?:未签名|unsigned)/i);
  assert.match(readme, /notarization[^\n]*(?:不是|未)|未[^\n]*notar/i);
  assert.doesNotMatch(readme, /应用本体使用 Developer ID 签名并完成 Apple notarization/);
  assert.doesNotMatch(readme, /正式安装器和关键可执行文件使用固定发布者身份签名/);
});

test("README and advanced UI describe bundled/runtime platform behavior accurately", () => {
  const readme = read("README.md");
  const html = read("src/renderer/index.html");
  assert.doesNotMatch(readme, /tunnel-client v0\.0\.11/);
  assert.match(readme, /tunnel-client v0\.0\.13/);
  assert.match(readme, /Windows[^\n]*内置[^\n]*Node 22/i);
  assert.match(readme, /macOS[^\n]*Node 20\+/i);
  assert.match(html, /SSH[^<]*Windows[^<]*(?:不支持|不可用)/i);
  assert.match(html, /macOS[^<]*(?:自动|读取)[^<]*系统代理[^<]*Windows[^<]*(?:手动|填写)/i);
});

test("historical signing design is explicitly superseded by current release policy", () => {
  const spec = read("docs/superpowers/specs/2026-08-26-desktop-auto-update-release-signing-design.md");
  const plan = read("docs/superpowers/plans/2026-08-26-desktop-auto-update-release-signing.md");
  assert.match(spec.slice(0, 800), /superseded|historical/i);
  assert.match(plan.slice(0, 800), /superseded|historical/i);
  assert.match(spec.slice(0, 800), /release-signing\.md/);
  assert.match(plan.slice(0, 800), /release-signing\.md/);
});
