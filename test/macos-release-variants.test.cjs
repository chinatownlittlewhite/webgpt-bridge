const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const workflow = (name) => fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8");

function assertThreeVariantAssets(source, label) {
  for (const variant of ["arm64", "x64", "universal"]) {
    assert.match(source, new RegExp(`release/WebGPT-Bridge-\\*\\-mac-${variant}\\.dmg`), `${label} must include ${variant} DMG`);
    assert.match(source, new RegExp(`release/WebGPT-Bridge-\\*\\-mac-${variant}\\.zip`), `${label} must include ${variant} ZIP`);
  }
  assert.match(source, /latest-mac\.yml/, `${label} must keep the Universal updater manifest`);
}

test("PR desktop workflow gates and uploads all three macOS variants", () => {
  const source = workflow("build-desktop.yml");
  const mac = source.slice(source.indexOf("  macos:"), source.indexOf("  windows:"));
  assert.match(mac, /npm run dist:mac/);
  assert.match(mac, /arm64 x64 universal/);
  assert.match(mac, /verify:mac-native-artifact -- "\$APP" "\$VARIANT"/);
  assert.match(mac, /verify:mac-packaged-pty -- "\$APP"/);
  assertThreeVariantAssets(mac, "PR macOS artifact upload");
});

test("formal release verifies and uploads arm64 x64 and Universal macOS variants", () => {
  const source = workflow("release-desktop.yml");
  const mac = source.slice(source.indexOf("  macos:"), source.indexOf("  publish:"));
  assert.match(mac, /npm run dist:mac/);
  assert.match(mac, /arm64 x64 universal/);
  assert.match(mac, /verify:mac-native-artifact -- "\$APP" "\$VARIANT"/);
  assert.match(mac, /verify:mac-packaged-pty -- "\$APP"/);
  assertThreeVariantAssets(mac, "formal macOS artifact upload");
});

test("release asset validator requires all three macOS distributable variants while updater stays Universal", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "validate-release-assets.cjs"), "utf8");
  assert.match(source, /MAC_VARIANTS[^\n]*arm64[^\n]*x64[^\n]*universal/);
  for (const variant of ["arm64", "x64", "universal"]) {
    assert.match(source, new RegExp(`mac-\\$\\{variant\\}\\.dmg`));
    assert.match(source, new RegExp(`mac-\\$\\{variant\\}\\.zip`));
  }
  assert.match(source, /latest-mac\.yml/);
  assert.match(source, /mac-universal\.zip/);
});
