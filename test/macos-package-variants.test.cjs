const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createBuilderConfig } = require("../build/electron-builder-options.cjs");
const { verifyMacNativeArtifact } = require("../scripts/inspect-macos-native-artifact.cjs");

const UNIX_TERMINAL_ANCHOR = "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');";
const POSIX_ONLY = process.platform === "win32"
  ? "POSIX execute-bit semantics are not portable on Windows CI"
  : false;

function writeFile(target, content = "x", mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode !== undefined) fs.chmodSync(target, mode);
}

function makeFixture() {
  const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-mac-variant-"));
  const appRoot = path.join(appOutDir, "WebGPT Bridge.app");
  const resources = path.join(appRoot, "Contents", "Resources");
  const agentRoot = path.join(resources, "app.asar.unpacked", "agent-runtime");
  const nodePtyRoot = path.join(agentRoot, "node_modules", "node-pty");

  writeFile(path.join(agentRoot, "dist", "server.js"), "export {};");
  writeFile(path.join(nodePtyRoot, "lib", "unixTerminal.js"), `const fs = require('fs');\nconst path = require('path');\nlet helperPath = 'x';\n${UNIX_TERMINAL_ANCHOR}\n`);
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    writeFile(path.join(nodePtyRoot, "prebuilds", arch, "spawn-helper"), `helper-${arch}`, 0o644);
    writeFile(path.join(nodePtyRoot, "prebuilds", arch, "pty.node"), `pty-${arch}`);
  }
  return { appOutDir, appRoot, resources, agentRoot, nodePtyRoot };
}

function context(appOutDir, arch) {
  return {
    appOutDir,
    electronPlatformName: "darwin",
    arch,
    packager: { appInfo: { productFilename: "WebGPT Bridge" } },
  };
}

function exists(root, relative) {
  return fs.existsSync(path.join(root, ...relative.split("/")));
}

for (const variant of ["arm64", "x64"]) {
  test(`macOS ${variant} afterPack retains only its Darwin PTY payload`, { skip: POSIX_ONLY }, async (t) => {
    const fixture = makeFixture();
    t.after(() => fs.rmSync(fixture.appOutDir, { recursive: true, force: true }));
    const config = createBuilderConfig({ WEBGPT_MAC_PACKAGE_VARIANT: variant });
    await config.afterPack(context(fixture.appOutDir, variant === "arm64" ? 3 : 1));

    const keep = variant === "arm64" ? "darwin-arm64" : "darwin-x64";
    const drop = variant === "arm64" ? "darwin-x64" : "darwin-arm64";
    assert.equal(exists(fixture.nodePtyRoot, `prebuilds/${keep}/pty.node`), true);
    assert.equal(exists(fixture.nodePtyRoot, `prebuilds/${drop}`), false);
    assert.equal(exists(fixture.resources, `node-pty-helper/${keep}/spawn-helper`), true);
    assert.equal(exists(fixture.resources, `node-pty-helper/${drop}`), false);
    assert.doesNotThrow(() => verifyMacNativeArtifact(fixture.appRoot, variant));
  });
}

test("macOS Universal afterPack retains both Darwin PTY payloads", { skip: POSIX_ONLY }, async (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.appOutDir, { recursive: true, force: true }));
  const config = createBuilderConfig({ WEBGPT_MAC_PACKAGE_VARIANT: "universal" });
  await config.afterPack(context(fixture.appOutDir, 3));

  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    assert.equal(exists(fixture.nodePtyRoot, `prebuilds/${arch}/pty.node`), true);
    assert.equal(exists(fixture.resources, `node-pty-helper/${arch}/spawn-helper`), true);
  }
  assert.doesNotThrow(() => verifyMacNativeArtifact(fixture.appRoot, "universal"));
});

test("mac package variant defaults to Universal and rejects unsupported or mismatched single-arch builds", async (t) => {
  assert.doesNotThrow(() => createBuilderConfig({}));
  assert.throws(
    () => createBuilderConfig({ WEBGPT_MAC_PACKAGE_VARIANT: "mips64" }),
    /WEBGPT_MAC_PACKAGE_VARIANT must be arm64, x64, or universal/,
  );

  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.appOutDir, { recursive: true, force: true }));
  const arm = createBuilderConfig({ WEBGPT_MAC_PACKAGE_VARIANT: "arm64" });
  await assert.rejects(
    () => arm.afterPack(context(fixture.appOutDir, 1)),
    /macOS package variant arm64 does not match builder architecture x64/,
  );
});
