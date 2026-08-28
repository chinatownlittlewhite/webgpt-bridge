const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { createTunnelProfileManager } = require("../src/tunnel-profile-manager.cjs");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "wgb-tunnel-profile-"));
  const clientPath = path.join(root, process.platform === "win32" ? "tunnel-client.exe" : "tunnel-client");
  const profileDir = path.join(root, "profiles");
  await fsp.writeFile(clientPath, "fixture-client", { mode: 0o700 });
  return {
    root,
    clientPath,
    profileDir,
    input: {
      clientPath,
      profileDir,
      profile: "webgpt-bridge",
      tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
      mcpServerUrl: "http://127.0.0.1:8787/mcp",
      healthListenAddr: "127.0.0.1:8080",
      runtimeKeyRef: "env:CONTROL_PLANE_API_KEY",
      runtimeKeyValue: "must-never-enter-profile-metadata",
    },
  };
}

async function allTextFiles(root) {
  const texts = [];
  async function visit(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) texts.push(await fsp.readFile(full, "utf8"));
    }
  }
  await visit(root);
  return texts.join("\n");
}

test("unchanged Host-owned profile skips init and secret values never enter cache metadata", async () => {
  const fx = await fixture();
  const calls = [];
  try {
    const manager = createTunnelProfileManager({
      runInit: async ({ args }) => {
        calls.push([...args]);
        await fsp.mkdir(fx.profileDir, { recursive: true });
        await fsp.writeFile(path.join(fx.profileDir, "webgpt-bridge.yaml"), "config_version: 1\n", "utf8");
      },
    });

    const first = await manager.ensure(fx.input);
    const second = await manager.ensure({ ...fx.input, runtimeKeyValue: "rotated-secret-value" });

    assert.equal(calls.length, 1);
    assert.equal(first.cacheHit, false);
    assert.equal(second.cacheHit, true);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.healthBaseUrl, "http://127.0.0.1:8080");
    assert.equal(Object.isFrozen(first), true);
    assert.ok(calls[0].includes("--profile-dir"));
    assert.ok(calls[0].includes("--health-listen-addr"));
    assert.ok(calls[0].includes("--control-plane-api-key-ref"));
    assert.ok(calls[0].includes("env:CONTROL_PLANE_API_KEY"));
    assert.equal(calls[0].includes("--force"), false, "first Host-owned materialization must not require replacement");

    const persisted = await allTextFiles(fx.profileDir);
    assert.doesNotMatch(persisted, /must-never-enter-profile-metadata|rotated-secret-value/);
  } finally {
    await fsp.rm(fx.root, { recursive: true, force: true });
  }
});

test("changed profile fingerprint uses controlled init --force exactly once", async () => {
  const fx = await fixture();
  const calls = [];
  try {
    const manager = createTunnelProfileManager({
      runInit: async ({ args }) => {
        calls.push([...args]);
        await fsp.mkdir(fx.profileDir, { recursive: true });
        await fsp.writeFile(path.join(fx.profileDir, "webgpt-bridge.yaml"), "config_version: 1\n", "utf8");
      },
    });

    await manager.ensure(fx.input);
    const changed = await manager.ensure({
      ...fx.input,
      tunnelId: "tunnel_abcdef0123456789abcdef0123456789",
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].includes("--force"), false);
    assert.equal(calls[1].includes("--force"), true);
    assert.equal(changed.cacheHit, false);
  } finally {
    await fsp.rm(fx.root, { recursive: true, force: true });
  }
});

test("failed init does not publish a reusable success fingerprint", async () => {
  const fx = await fixture();
  let calls = 0;
  try {
    const manager = createTunnelProfileManager({
      runInit: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("init failed"), { code: "TEST_INIT_FAILED" });
        await fsp.mkdir(fx.profileDir, { recursive: true });
        await fsp.writeFile(path.join(fx.profileDir, "webgpt-bridge.yaml"), "config_version: 1\n", "utf8");
      },
    });

    await assert.rejects(() => manager.ensure(fx.input), /init failed/);
    const retry = await manager.ensure(fx.input);
    assert.equal(calls, 2);
    assert.equal(retry.cacheHit, false);
  } finally {
    await fsp.rm(fx.root, { recursive: true, force: true });
  }
});
