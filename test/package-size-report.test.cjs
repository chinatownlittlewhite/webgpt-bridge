const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function write(root, relative, bytes) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(bytes, 1));
}

test("package size reporter returns deterministic macOS component byte totals", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-size-mac-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "Contents/Frameworks/a.bin", 11);
  write(root, "Contents/Resources/app.asar", 7);
  write(root, "Contents/Resources/app.asar.unpacked/agent-runtime/dist/server.js", 13);
  write(root, "Contents/Resources/app.asar.unpacked/agent-runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node", 19);
  write(root, "Contents/Resources/app.asar.unpacked/agent-runtime/native/helper.bin", 23);
  write(root, "Contents/Resources/tunnel-client/cloudflared", 17);

  const { collectPackageSizes } = require("../scripts/report-package-size.cjs");
  assert.deepEqual(collectPackageSizes(root, { platform: "darwin" }), {
    totalBytes: 90,
    frameworksBytes: 11,
    resourcesBytes: 79,
    appAsarBytes: 7,
    appAsarUnpackedBytes: 55,
    agentRuntimeBytes: 55,
    nodePtyBytes: 19,
    agentNativeBytes: 23,
    tunnelClientBytes: 17,
    windowsNodeRuntimeBytes: 0,
  });
});

test("package size reporter resolves Windows resources and bundled Node runtime", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-size-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "resources/app.asar", 5);
  write(root, "resources/app.asar.unpacked/agent-runtime/dist/server.js", 7);
  write(root, "resources/app.asar.unpacked/agent-runtime/node_modules/node-pty/prebuilds/win32-x64/pty.node", 11);
  write(root, "resources/app.asar.unpacked/agent-runtime/native/windows-host/bin/release/host.exe", 13);
  write(root, "resources/tunnel-client/tunnel-client.exe", 17);
  write(root, "resources/node-runtime/node.exe", 19);

  const { collectPackageSizes } = require("../scripts/report-package-size.cjs");
  assert.deepEqual(collectPackageSizes(root, { platform: "win32" }), {
    totalBytes: 72,
    frameworksBytes: 0,
    resourcesBytes: 72,
    appAsarBytes: 5,
    appAsarUnpackedBytes: 31,
    agentRuntimeBytes: 31,
    nodePtyBytes: 11,
    agentNativeBytes: 13,
    tunnelClientBytes: 17,
    windowsNodeRuntimeBytes: 19,
  });
});
