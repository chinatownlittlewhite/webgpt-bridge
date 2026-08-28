const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function api() {
  const modulePath = path.join(__dirname, "..", "src", "system-proxy.cjs");
  assert.equal(fs.existsSync(modulePath), true, "system-proxy helper must exist");
  return require(modulePath);
}

test("explicit proxy wins and always preserves loopback NO_PROXY", () => {
  const { resolveSystemProxyEnvironment } = api();
  let scutilCalls = 0;
  const env = resolveSystemProxyEnvironment({
    explicitProxy: "http://127.0.0.1:12001",
    platform: "darwin",
    spawnSync: () => { scutilCalls += 1; return { status: 0, stdout: "" }; },
  });
  assert.deepEqual(env, {
    HTTP_PROXY: "http://127.0.0.1:12001",
    HTTPS_PROXY: "http://127.0.0.1:12001",
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
  assert.equal(scutilCalls, 0);
});

test("macOS system HTTPS proxy is used only when explicit proxy is empty", () => {
  const { resolveSystemProxyEnvironment } = api();
  const output = `\n<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : localhost\n  }\n  HTTPEnable : 1\n  HTTPPort : 8080\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 8443\n  HTTPSProxy : proxy.example.test\n}`;
  const env = resolveSystemProxyEnvironment({
    explicitProxy: "",
    platform: "darwin",
    spawnSync: (command, argv) => {
      assert.equal(command, "/usr/sbin/scutil");
      assert.deepEqual(argv, ["--proxy"]);
      return { status: 0, stdout: output };
    },
  });
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:8080");
  assert.equal(env.HTTPS_PROXY, "http://proxy.example.test:8443");
  assert.match(env.NO_PROXY, /127\.0\.0\.1/);
  assert.match(env.NO_PROXY, /localhost/);
  assert.match(env.NO_PROXY, /::1/);
  assert.match(env.NO_PROXY, /\*\.local/);
});

test("non-macOS or disabled system proxy returns no proxy environment", () => {
  const { resolveSystemProxyEnvironment } = api();
  assert.deepEqual(resolveSystemProxyEnvironment({ explicitProxy: "", platform: "linux" }), {});
  assert.deepEqual(resolveSystemProxyEnvironment({
    explicitProxy: "",
    platform: "darwin",
    spawnSync: () => ({ status: 0, stdout: "<dictionary> { HTTPEnable : 0 HTTPSEnable : 0 }" }),
  }), {});
});
