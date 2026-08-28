const test = require("node:test");
const assert = require("node:assert/strict");

const { createStartupPreflight } = require("../src/startup-preflight.cjs");

test("startup preflight returns one immutable validated snapshot", async () => {
  const calls = { runtime: 0, tunnel: 0, node: 0, key: 0 };
  const settings = {
    workspacePath: "/workspace",
    runtimePath: "/runtime",
    tunnelClientPath: "/tunnel-client",
    nodePath: "/node",
    tunnelId: "tunnel_example",
    profile: "webgpt-bridge",
  };
  const nodeRuntime = Object.freeze({
    path: "/node",
    version: "v22.23.1",
    identity: Object.freeze({ path: "/node", size: 1, mtimeMs: 2, dev: 3, ino: 4 }),
    source: "settings",
  });
  const preflight = createStartupPreflight({
    validateRuntime(value) {
      calls.runtime += 1;
      assert.strictEqual(value, settings);
      return { mode: "bundled", workspacePath: value.workspacePath, runtimePath: value.runtimePath };
    },
    isDirectory: (value) => value === "/workspace" || value === "/runtime",
    isFile: (value) => value === "/runtime/dist/server.js" || value === "/tunnel-client",
    resolveTunnelClient({ customPath, isFile }) {
      calls.tunnel += 1;
      return isFile(customPath) ? customPath : "";
    },
    async resolveNodeRuntime(input) {
      calls.node += 1;
      assert.strictEqual(input.settings, settings);
      return nodeRuntime;
    },
    async readRuntimeKey() {
      calls.key += 1;
      return "runtime-key-value";
    },
    appToolsBin: "/tools/bin",
    resolveDesktopGitHubCli: () => "/tools/bin/gh",
  });

  const result = await preflight.prepare({ settings });

  assert.deepEqual(calls, { runtime: 1, tunnel: 1, node: 1, key: 1 });
  assert.equal(result.node, "/node");
  assert.strictEqual(result.nodeRuntime, nodeRuntime);
  assert.equal(result.tunnelClient, "/tunnel-client");
  assert.equal(result.runtimeKey, "runtime-key-value");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.settings), true);
  assert.equal(Object.isFrozen(result.runtime), true);
  assert.equal(settings.nodePath, "/node");
});
