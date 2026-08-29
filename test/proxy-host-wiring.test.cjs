const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop resolves one proxy environment and shares it with Tunnel and network terminal commands", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  const runtimeHost = fs.readFileSync(path.join(__dirname, "..", "src", "host", "runtime-host.cjs"), "utf8");
  const broker = fs.readFileSync(path.join(__dirname, "..", "src", "host", "broker-server.cjs"), "utf8");
  assert.match(main, /createRuntimeHost/);
  assert.match(runtimeHost, /require\("\.\.\/system-proxy\.cjs"\)/);
  assert.match(runtimeHost, /resolveSystemProxyEnvironment\(\{[\s\S]{0,240}explicitProxy:\s*settings\.httpsProxy[\s\S]{0,240}platform/);
  assert.match(runtimeHost, /startBroker[\s\S]{0,300}proxyEnv/);
  assert.match(broker, /createLocalTerminalBroker\(\{[\s\S]{0,700}networkEnv:\s*proxyEnv/);
  assert.match(runtimeHost, /startTunnel[\s\S]{0,500}proxyEnv/);
  assert.doesNotMatch(runtimeHost, /settings\.httpsProxy\s*\?\s*\{\s*HTTPS_PROXY/);
});
