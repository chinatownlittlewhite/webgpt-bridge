const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyMacNativeArtifact } = require("../scripts/inspect-macos-native-artifact.cjs");

function makeFixture(mode = 0o755) {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-inspector-"));
  const base = path.join(
    appRoot,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const dir = path.join(base, arch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spawn-helper"), `helper-${arch}`);
    fs.writeFileSync(path.join(dir, "pty.node"), `pty-${arch}`);
    fs.chmodSync(path.join(dir, "spawn-helper"), mode);
  }
  return appRoot;
}

test("final artifact inspector accepts executable helpers for both Darwin architectures", (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  }
  const root = makeFixture(0o755);
  try {
    const result = verifyMacNativeArtifact(root);
    assert.deepEqual(result.helpers.map((item) => item.mode), [0o755, 0o755]);
    assert.equal(result.nativeModules.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final artifact inspector rejects non-executable helper without modifying it", (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  }
  const root = makeFixture(0o644);
  const helper = path.join(
    root,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-arm64",
    "spawn-helper",
  );
  try {
    const before = fs.lstatSync(helper).mode & 0o777;
    assert.throws(
      () => verifyMacNativeArtifact(root),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID",
    );
    const after = fs.lstatSync(helper).mode & 0o777;
    assert.equal(before, 0o644);
    assert.equal(after, before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("final artifact inspector rejects missing pty.node", () => {
  const root = makeFixture();
  const missing = path.join(
    root,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
    "prebuilds",
    "darwin-x64",
    "pty.node",
  );
  try {
    fs.rmSync(missing);
    assert.throws(
      () => verifyMacNativeArtifact(root),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
