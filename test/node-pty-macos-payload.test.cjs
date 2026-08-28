const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  inspectNodePtyMacPayload,
  normalizeNodePtyMacPayload,
} = require("../scripts/node-pty-macos-payload.cjs");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-node-pty-"));
  const packageRoot = path.join(
    root,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "agent-runtime",
    "node_modules",
    "node-pty",
  );
  const base = path.join(packageRoot, "prebuilds");
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const dir = path.join(base, arch);
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
  return root;
}

test("normalizer makes both packaged Darwin spawn-helper files executable without changing bytes", (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  }
  const root = makeFixture();
  try {
    const before = inspectNodePtyMacPayload(root);
    assert.deepEqual(before.helpers.map((item) => item.mode), [0o644, 0o644]);
    const bytes = before.helpers.map((item) => fs.readFileSync(item.path));

    const normalized = normalizeNodePtyMacPayload(root);
    assert.deepEqual(normalized.helpers.map((item) => item.mode), [0o755, 0o755]);
    assert.deepEqual(normalized.helpers.map((item) => fs.readFileSync(item.path)), bytes);

    const second = normalizeNodePtyMacPayload(root);
    assert.deepEqual(second.helpers.map((item) => item.mode), [0o755, 0o755]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("payload inspection fails closed when one architecture is missing", () => {
  const root = makeFixture();
  try {
    fs.rmSync(path.join(root, "Contents", "Resources", "app.asar.unpacked", "agent-runtime", "node_modules", "node-pty", "prebuilds", "darwin-x64"), { recursive: true, force: true });
    assert.throws(
      () => inspectNodePtyMacPayload(root),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID" && /darwin-x64/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("payload inspection rejects symlinked helpers", (t) => {
  if (process.platform === "win32") return t.skip("symlink fixture is not portable on Windows CI");
  const root = makeFixture();
  try {
    const helper = path.join(root, "Contents", "Resources", "app.asar.unpacked", "agent-runtime", "node_modules", "node-pty", "prebuilds", "darwin-arm64", "spawn-helper");
    const target = `${helper}.real`;
    fs.renameSync(helper, target);
    fs.symlinkSync(target, helper);
    assert.throws(() => inspectNodePtyMacPayload(root), (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
