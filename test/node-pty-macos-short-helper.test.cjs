const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  inspectPackagedNodePtyMacPayload,
  normalizeNodePtyMacPayload,
} = require("../scripts/node-pty-macos-payload.cjs");
const { verifyMacNativeArtifact } = require("../scripts/inspect-macos-native-artifact.cjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-short-helper-"));
  const packageRoot = path.join(
    root,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
  );
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const dir = path.join(packageRoot, "prebuilds", arch);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "spawn-helper"), `helper-${arch}`);
    fs.writeFileSync(path.join(dir, "pty.node"), `pty-${arch}`);
    fs.chmodSync(path.join(dir, "spawn-helper"), 0o644);
  }
  fs.mkdirSync(path.join(packageRoot, "lib"), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "lib", "unixTerminal.js"),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "let helperPath = native.dir + '/spawn-helper';",
      "helperPath = path.resolve(__dirname, helperPath);",
      "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
      "const DEFAULT_FILE = 'sh';",
      "",
    ].join("\n"),
  );
  return { root, packageRoot };
}

test("normalizer stages executable short Darwin helpers and patches resolver idempotently", (t) => {
  if (process.platform === "win32") return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  const fixture = makeFixture();
  try {
    normalizeNodePtyMacPayload(fixture.root);
    normalizeNodePtyMacPayload(fixture.root);
    const inspected = inspectPackagedNodePtyMacPayload(fixture.root);
    assert.deepEqual(inspected.shortHelpers.map((item) => item.mode), [0o755, 0o755]);
    for (let index = 0; index < inspected.helpers.length; index += 1) {
      assert.deepEqual(
        fs.readFileSync(inspected.shortHelpers[index].path),
        fs.readFileSync(inspected.helpers[index].path),
      );
    }
    const source = fs.readFileSync(path.join(fixture.packageRoot, "lib", "unixTerminal.js"), "utf8");
    assert.equal((source.match(/webgpt-bridge:darwin-short-spawn-helper/g) || []).length, 1);
    assert.match(source, /node-pty-helper\/' \+ process\.platform \+ '-' \+ process\.arch/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("packaged inspection rejects a missing short helper", (t) => {
  if (process.platform === "win32") return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  const fixture = makeFixture();
  try {
    normalizeNodePtyMacPayload(fixture.root);
    fs.rmSync(path.join(fixture.root, "Contents", "Resources", "node-pty-helper", "darwin-x64", "spawn-helper"));
    assert.throws(
      () => inspectPackagedNodePtyMacPayload(fixture.root),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID",
    );
    assert.throws(
      () => verifyMacNativeArtifact(fixture.root),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("normalizer fails closed when the staged unixTerminal helper-path anchor is absent", (t) => {
  if (process.platform === "win32") return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  const fixture = makeFixture();
  try {
    fs.writeFileSync(path.join(fixture.packageRoot, "lib", "unixTerminal.js"), "module.exports = {};\n");
    assert.throws(
      () => normalizeNodePtyMacPayload(fixture.root),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID",
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
