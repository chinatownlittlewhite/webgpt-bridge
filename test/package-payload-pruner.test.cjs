const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { prunePackagedAgentRuntime } = require("../scripts/package-payload-pruner.cjs");

function write(root, relative, content = relative) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-package-prune-"));
  const resourcesRoot = path.join(root, "resources");
  const agentRoot = path.join(resourcesRoot, "app.asar.unpacked", "agent-runtime");

  write(agentRoot, "dist/server.js", "runtime");
  write(agentRoot, "package.json", "{}");
  write(agentRoot, "node_modules/@modelcontextprotocol/server/dist/index.js", "server");
  write(agentRoot, "node_modules/@modelcontextprotocol/client/dist/index.js", "dev-client");
  write(agentRoot, "node_modules/example/dist/runtime.js", "runtime");
  write(agentRoot, "node_modules/example/dist/runtime.js.map", "map");
  write(agentRoot, "node_modules/example/dist/runtime.test.js", "test");
  write(agentRoot, "node_modules/example/dist/runtime.test.js.map", "test-map");
  write(agentRoot, "node_modules/eventsource/dist/index.cjs", "runtime");
  write(agentRoot, "node_modules/eventsource/src/index.ts", "source");
  write(agentRoot, "node_modules/eventsource-parser/dist/index.cjs", "runtime");
  write(agentRoot, "node_modules/eventsource-parser/src/index.ts", "source");
  write(agentRoot, "node_modules/zod/index.cjs", "runtime");
  write(agentRoot, "node_modules/zod/src/index.ts", "source");
  write(agentRoot, "node_modules/zod/src/v3/tests/basic.test.ts", "test");
  write(agentRoot, "node_modules/zod/src/v4/classic/tests/basic.test.ts", "test");
  write(agentRoot, "node_modules/zod/src/v4/core/tests/basic.test.ts", "test");
  write(agentRoot, "node_modules/zod/src/v4/mini/tests/basic.test.ts", "test");
  write(agentRoot, "node_modules/isexe/dist/index.js", "runtime");
  write(agentRoot, "node_modules/isexe/test/basic.js", "test");

  write(agentRoot, "native/windows-host/bin/release/windows-host.exe", "host");

  for (const arch of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
    write(agentRoot, `node_modules/node-pty/prebuilds/${arch}/pty.node`, arch);
    write(agentRoot, `node_modules/node-pty/prebuilds/${arch}/spawn-helper`, arch);
  }
  write(agentRoot, "node_modules/node-pty/deps/winpty/source.cc", "deps");
  write(agentRoot, "node_modules/node-pty/third_party/conpty/source.cc", "third-party");
  write(agentRoot, "node_modules/node-pty/src/index.ts", "source");
  write(agentRoot, "node_modules/node-pty/scripts/prebuild.js", "script");
  write(agentRoot, "node_modules/node-pty/binding.gyp", "gyp");
  write(agentRoot, "node_modules/node-pty/lib/index.js", "runtime");

  return { root, resourcesRoot, agentRoot };
}

function exists(agentRoot, relative) {
  return fs.existsSync(path.join(agentRoot, relative));
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test("darwin pruning removes Windows/dev payload while preserving both Darwin PTY architectures", () => {
  const fixture = makeFixture();
  try {
    const result = prunePackagedAgentRuntime({
      resourcesRoot: fixture.resourcesRoot,
      platform: "darwin",
      arch: "arm64",
    });

    assert.equal(exists(fixture.agentRoot, "node_modules/@modelcontextprotocol/client"), false);
    assert.equal(exists(fixture.agentRoot, "native/windows-host"), false);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/win32-x64"), false);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/win32-arm64"), false);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/darwin-arm64/pty.node"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/darwin-x64/pty.node"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/@modelcontextprotocol/server/dist/index.js"), true);
    assert.equal(exists(fixture.agentRoot, "dist/server.js"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/lib/index.js"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/eventsource/dist/index.cjs"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/eventsource/src/index.ts"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/eventsource-parser/dist/index.cjs"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/eventsource-parser/src/index.ts"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/zod/index.cjs"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/zod/src/index.ts"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/isexe/dist/index.js"), true);

    for (const relative of [
      "node_modules/node-pty/deps",
      "node_modules/node-pty/third_party",
      "node_modules/node-pty/src",
      "node_modules/node-pty/scripts",
      "node_modules/node-pty/binding.gyp",
      "node_modules/example/dist/runtime.js.map",
      "node_modules/example/dist/runtime.test.js",
      "node_modules/example/dist/runtime.test.js.map",
      "node_modules/zod/src/v3/tests",
      "node_modules/zod/src/v4/classic/tests",
      "node_modules/zod/src/v4/core/tests",
      "node_modules/zod/src/v4/mini/tests",
      "node_modules/isexe/test",
    ]) {
      assert.equal(exists(fixture.agentRoot, relative), false, `${relative} should be pruned`);
    }
    assert.ok(result.removedBytes > 0);
    assert.ok(result.removedPaths.includes("node_modules/@modelcontextprotocol/client"));
    assert.equal(Object.isFrozen(result), true);
  } finally {
    cleanup(fixture);
  }
});

test("Windows x64 pruning retains Host/native x64 payload and removes Darwin plus ARM64 prebuilds", () => {
  const fixture = makeFixture();
  try {
    prunePackagedAgentRuntime({
      resourcesRoot: fixture.resourcesRoot,
      platform: "win32",
      arch: "x64",
    });

    assert.equal(exists(fixture.agentRoot, "node_modules/@modelcontextprotocol/client"), false);
    assert.equal(exists(fixture.agentRoot, "native/windows-host/bin/release/windows-host.exe"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/win32-x64/pty.node"), true);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/win32-arm64"), false);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/darwin-arm64"), false);
    assert.equal(exists(fixture.agentRoot, "node_modules/node-pty/prebuilds/darwin-x64"), false);
    assert.equal(exists(fixture.agentRoot, "dist/server.js"), true);
  } finally {
    cleanup(fixture);
  }
});

test("pruning is idempotent, does not follow symlinks, and fails closed on unsupported targets", (t) => {
  if (process.platform === "win32") t.skip("symlink fixture requires POSIX-compatible test permissions");
  const fixture = makeFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "webgpt-package-prune-outside-"));
  try {
    const outsideMap = write(outside, "keep.map", "outside");
    fs.symlinkSync(outside, path.join(fixture.agentRoot, "node_modules", "linked-outside"), "dir");

    const first = prunePackagedAgentRuntime({
      resourcesRoot: fixture.resourcesRoot,
      platform: "darwin",
      arch: "x64",
    });
    const second = prunePackagedAgentRuntime({
      resourcesRoot: fixture.resourcesRoot,
      platform: "darwin",
      arch: "x64",
    });

    assert.ok(first.removedBytes > 0);
    assert.equal(second.removedBytes, 0);
    assert.deepEqual(second.removedPaths, []);
    assert.equal(fs.readFileSync(outsideMap, "utf8"), "outside");
    assert.equal(fs.lstatSync(path.join(fixture.agentRoot, "node_modules", "linked-outside")).isSymbolicLink(), true);

    assert.throws(
      () => prunePackagedAgentRuntime({ resourcesRoot: fixture.resourcesRoot, platform: "linux", arch: "x64" }),
      (error) => error?.code === "PACKAGE_PAYLOAD_INVALID",
    );
    assert.throws(
      () => prunePackagedAgentRuntime({ resourcesRoot: fixture.resourcesRoot, platform: "darwin", arch: "ia32" }),
      (error) => error?.code === "PACKAGE_PAYLOAD_INVALID",
    );
    assert.throws(
      () => prunePackagedAgentRuntime({ resourcesRoot: fixture.resourcesRoot, platform: "win32", arch: "arm64" }),
      (error) => error?.code === "PACKAGE_PAYLOAD_INVALID",
    );
    assert.throws(
      () => prunePackagedAgentRuntime({ resourcesRoot: path.join(fixture.root, "missing"), platform: "darwin", arch: "arm64" }),
      (error) => error?.code === "PACKAGE_PAYLOAD_INVALID",
    );
  } finally {
    cleanup(fixture);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
