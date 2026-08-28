const test = require("node:test");
const assert = require("node:assert/strict");

const { createNodeRuntimeResolver } = require("../src/node-runtime-resolver.cjs");

function identity(path) {
  return Object.freeze({ path, size: 123, mtimeMs: 456, dev: 1, ino: 2 });
}

test("explicit invalid configured Node fails instead of falling back", async () => {
  const probes = [];
  const resolver = createNodeRuntimeResolver({
    preferredCandidates: () => ["/bad/node", "/good/node"],
    fileIdentity: async (candidate) => identity(candidate),
    probeVersion: async (candidate) => {
      probes.push(candidate);
      return candidate === "/bad/node" ? "v18.20.0" : "v22.23.1";
    },
  });

  await assert.rejects(
    () => resolver.resolve({ settings: { nodePath: "/bad/node" }, env: {} }),
    (error) => error?.code === "NODE_CONFIGURED_RUNTIME_INVALID",
  );
  assert.deepEqual(probes, ["/bad/node"], "explicit configured Node must not silently fall back");
});

test("known unchanged identity does not execute --version twice", async () => {
  let probes = 0;
  const resolver = createNodeRuntimeResolver({
    preferredCandidates: () => ["/node"],
    fileIdentity: async (candidate) => identity(candidate),
    probeVersion: async () => {
      probes += 1;
      return "v22.23.1";
    },
  });

  const first = await resolver.resolve({ settings: { nodePath: "/node" }, env: {} });
  const second = await resolver.resolve({ settings: { nodePath: "/node" }, env: {} });

  assert.equal(probes, 1);
  assert.equal(first.version, second.version);
  assert.equal(first.path, "/node");
  assert.equal(first.source, "settings");
  assert.deepEqual(first.identity, second.identity);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.identity), true);
});

test("trusted bundled manifest verifies once by digest and never executes --version", async () => {
  let probes = 0;
  let hashes = 0;
  const bundledPath = "/bundled/node";
  const resolver = createNodeRuntimeResolver({
    preferredCandidates: () => [bundledPath],
    fileIdentity: async (candidate) => identity(candidate),
    hashFile: async (candidate) => {
      hashes += 1;
      assert.equal(candidate, bundledPath);
      return "abcdef";
    },
    probeVersion: async () => {
      probes += 1;
      throw new Error("bundled manifest should avoid --version");
    },
  });
  const bundledManifest = Object.freeze({
    path: bundledPath,
    version: "v22.23.2",
    nodeSha256: "abcdef",
  });

  const first = await resolver.resolve({ settings: {}, env: {}, bundledManifest });
  const second = await resolver.resolve({ settings: {}, env: {}, bundledManifest });

  assert.equal(probes, 0);
  assert.equal(hashes, 1, "unchanged FileIdentity should reuse verified bundled evidence");
  assert.equal(first.path, bundledPath);
  assert.equal(first.version, "v22.23.2");
  assert.equal(first.source, "bundled");
  assert.strictEqual(second, first);
});
