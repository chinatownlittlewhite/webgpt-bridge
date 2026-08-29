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

test("package size reporter returns deterministic component byte totals", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-size-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, "Contents/Frameworks/a.bin", 11);
  write(root, "Contents/Resources/app.asar", 7);
  write(root, "Contents/Resources/app.asar.unpacked/agent-runtime/dist/server.js", 13);
  write(root, "Contents/Resources/app.asar.unpacked/agent-runtime/node_modules/node-pty/prebuilds/darwin-arm64/pty.node", 19);
  write(root, "Contents/Resources/tunnel-client/cloudflared", 17);

  const { collectPackageSizes } = require("../scripts/report-package-size.cjs");
  assert.deepEqual(collectPackageSizes(root), {
    totalBytes: 67,
    frameworksBytes: 11,
    resourcesBytes: 56,
    appAsarBytes: 7,
    appAsarUnpackedBytes: 32,
    agentRuntimeBytes: 32,
    nodePtyBytes: 19,
    tunnelClientBytes: 17,
  });
});
