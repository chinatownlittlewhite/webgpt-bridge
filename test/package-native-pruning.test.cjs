const test = require("node:test");
const assert = require("node:assert/strict");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");

function packagedFiles(platform) {
  return createBuilderConfig({}, { platform }).files;
}

test("macOS packaging removes Windows-only node-pty native payload while keeping both Darwin architectures", () => {
  const files = packagedFiles("darwin");

  assert.ok(files.includes("!agent-runtime/node_modules/node-pty/prebuilds/win32-*/**/*"));
  assert.ok(files.includes("!agent-runtime/node_modules/node-pty/third_party/**/*"));
  assert.ok(files.includes("!agent-runtime/node_modules/node-pty/deps/**/*"));
  assert.equal(files.includes("!agent-runtime/node_modules/node-pty/prebuilds/darwin-*/**/*"), false);
  assert.equal(files.includes("!agent-runtime/node_modules/node-pty/**/*"), false);
});

test("Windows packaging removes Darwin node-pty prebuilds while retaining Windows native payload", () => {
  const files = packagedFiles("win32");

  assert.ok(files.includes("!agent-runtime/node_modules/node-pty/prebuilds/darwin-*/**/*"));
  assert.equal(files.includes("!agent-runtime/node_modules/node-pty/prebuilds/win32-*/**/*"), false);
  assert.equal(files.includes("!agent-runtime/node_modules/node-pty/third_party/**/*"), false);
  assert.equal(files.includes("!agent-runtime/node_modules/node-pty/deps/**/*"), false);
  assert.equal(files.includes("!agent-runtime/node_modules/node-pty/**/*"), false);
});

test("unknown packaging platforms do not prune node-pty native payload", () => {
  const files = packagedFiles("linux");
  assert.equal(files.some((entry) => entry.startsWith("!agent-runtime/node_modules/node-pty/")), false);
});
