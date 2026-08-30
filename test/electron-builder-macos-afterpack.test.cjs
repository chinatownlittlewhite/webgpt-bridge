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
    for (const arch of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
      const dir = path.join(base, arch);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "spawn-helper"), `helper-${arch}`);
      fs.writeFileSync(path.join(dir, "pty.node"), `pty-${arch}`);
      if (arch.startsWith("darwin-")) fs.chmodSync(path.join(dir, "spawn-helper"), 0o644);
    }
    const packageRoot = path.dirname(base);
    const agentRoot = path.resolve(packageRoot, "..", "..");
    fs.mkdirSync(path.join(agentRoot, "node_modules", "@modelcontextprotocol", "client"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "node_modules", "@modelcontextprotocol", "client", "index.js"), "dev");
    fs.mkdirSync(path.join(agentRoot, "native", "windows-host"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "native", "windows-host", "host.exe"), "host");
    fs.mkdirSync(path.join(packageRoot, "deps"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "deps", "source.cc"), "source");
    fs.mkdirSync(path.join(packageRoot, "lib"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "lib", "unused.js.map"), "map");
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
  }
  return { appOutDir, appRoot };
}

function context(appOutDir, electronPlatformName, arch = 1) {
  return {
    appOutDir,
    electronPlatformName,
    arch,
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
    const agentRoot = path.join(fixture.appRoot, "Contents", "Resources", "app.asar.unpacked", "agent-runtime");
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "@modelcontextprotocol", "client")), false);
    assert.equal(fs.existsSync(path.join(agentRoot, "native", "windows-host")), false);
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "node-pty", "prebuilds", "win32-x64")), false);
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "node-pty", "prebuilds", "darwin-arm64", "pty.node")), true);
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "node-pty", "prebuilds", "darwin-x64", "pty.node")), true);
  } finally {
    fs.rmSync(fixture.appOutDir, { recursive: true, force: true });
  }
});

test("macOS universal merge rule covers original node-pty payload and staged short helpers", () => {
  const rule = createBuilderConfig({}).mac.x64ArchFiles;
  assert.equal(typeof rule, "string");
  assert.match(rule, /node-pty\/prebuilds\/darwin-/);
  assert.match(rule, /node-pty-helper\/darwin-/);
});

test("Windows x64 afterPack prunes Darwin and ARM64 PTY payload while retaining Windows Host runtime", async () => {
  const fixture = makePackFixture({ includePayload: false });
  try {
    const agentRoot = path.join(fixture.appOutDir, "resources", "app.asar.unpacked", "agent-runtime");
    for (const arch of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
      const dir = path.join(agentRoot, "node_modules", "node-pty", "prebuilds", arch);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "pty.node"), arch);
    }
    fs.mkdirSync(path.join(agentRoot, "native", "windows-host", "bin", "release"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "native", "windows-host", "bin", "release", "windows-host.exe"), "host");
    fs.mkdirSync(path.join(agentRoot, "node_modules", "@modelcontextprotocol", "client"), { recursive: true });
    fs.writeFileSync(path.join(agentRoot, "node_modules", "@modelcontextprotocol", "client", "index.js"), "dev");

    const config = createBuilderConfig({});
    assert.equal(typeof config.afterPack, "function");
    await config.afterPack(context(fixture.appOutDir, "win32", 1));

    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "node-pty", "prebuilds", "win32-x64", "pty.node")), true);
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "node-pty", "prebuilds", "win32-arm64")), false);
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "node-pty", "prebuilds", "darwin-arm64")), false);
    assert.equal(fs.existsSync(path.join(agentRoot, "native", "windows-host", "bin", "release", "windows-host.exe")), true);
    assert.equal(fs.existsSync(path.join(agentRoot, "node_modules", "@modelcontextprotocol", "client")), false);
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
