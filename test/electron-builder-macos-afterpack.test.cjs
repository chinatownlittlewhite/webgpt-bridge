const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBuilderConfig } = require("../build/electron-builder-options.cjs");
const { inspectNodePtyMacPayload } = require("../scripts/node-pty-macos-payload.cjs");

function makePackFixture({ includePayload = true } = {}) {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-afterpack-"));
  const appRoot = path.join(appOutDir, "WebGPT Bridge.app");
  if (includePayload) {
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
      fs.chmodSync(path.join(dir, "spawn-helper"), 0o644);
    }
  }
  return { appOutDir, appRoot };
}

function context(appOutDir, electronPlatformName) {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename: "WebGPT Bridge" } },
  };
}

test("macOS afterPack normalizes both staged Darwin spawn-helper files", async (t) => {
  if (process.platform === "win32") {
    return t.skip("POSIX execute-bit semantics are not portable on Windows CI");
  }
  const fixture = makePackFixture();
  try {
    const config = createBuilderConfig({});
    assert.equal(typeof config.afterPack, "function");
    await config.afterPack(context(fixture.appOutDir, "darwin"));
    const inspected = inspectNodePtyMacPayload(fixture.appRoot);
    assert.deepEqual(inspected.helpers.map((item) => item.mode), [0o755, 0o755]);
  } finally {
    fs.rmSync(fixture.appOutDir, { recursive: true, force: true });
  }
});

test("afterPack ignores non-macOS contexts", async () => {
  const fixture = makePackFixture({ includePayload: false });
  try {
    const config = createBuilderConfig({});
    assert.equal(typeof config.afterPack, "function");
    await assert.doesNotReject(() => config.afterPack(context(fixture.appOutDir, "win32")));
  } finally {
    fs.rmSync(fixture.appOutDir, { recursive: true, force: true });
  }
});

test("macOS afterPack propagates payload validation failures", async () => {
  const fixture = makePackFixture({ includePayload: false });
  try {
    const config = createBuilderConfig({});
    assert.equal(typeof config.afterPack, "function");
    await assert.rejects(
      () => config.afterPack(context(fixture.appOutDir, "darwin")),
      (error) => error?.code === "NATIVE_PTY_PAYLOAD_INVALID",
    );
  } finally {
    fs.rmSync(fixture.appOutDir, { recursive: true, force: true });
  }
});
