const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop resolves one proxy environment and shares it with Tunnel and network terminal commands", () => {
  const runtimeHost = fs.readFileSync(path.join(__dirname, "..", "src", "host", "runtime-host.cjs"), "utf8");
  const brokerServer = fs.readFileSync(path.join(__dirname, "..", "src", "host", "broker-server.cjs"), "utf8");
  assert.match(runtimeHost, /require\("\.\.\/system-proxy\.cjs"\)/);
  assert.match(runtimeHost, /resolveSystemProxyEnvironment\(\{[\s\S]{0,240}explicitProxy:\s*settings\.httpsProxy[\s\S]{0,240}platform/);
  assert.match(runtimeHost, /startBroker\(preflight\)[\s\S]{0,300}proxyEnv:\s*preflight\.proxyEnv/);
  assert.match(brokerServer, /createLocalTerminalBroker\(\{[\s\S]{0,700}networkEnv:\s*proxyEnv/);
  assert.match(runtimeHost, /startTunnel\(preflight\)[\s\S]{0,500}\{\s*\.\.\.env,\s*\.\.\.proxyEnv/);
  assert.doesNotMatch(runtimeHost, /settings\.httpsProxy\s*\?\s*\{\s*HTTPS_PROXY/);
});
