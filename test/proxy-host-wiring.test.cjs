const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("desktop resolves one proxy environment and shares it with Tunnel and network terminal commands", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.cjs"), "utf8");
  assert.match(main, /require\("\.\/system-proxy\.cjs"\)/);
  assert.match(main, /resolveSystemProxyEnvironment\(\{[\s\S]{0,240}explicitProxy:\s*settings\.httpsProxy[\s\S]{0,240}platform:\s*process\.platform/);
  assert.match(main, /startRuntimeBroker[\s\S]{0,300}proxyEnv/);
  assert.match(main, /createLocalTerminalBroker\(\{[\s\S]{0,700}networkEnv:\s*proxyEnv/);
  assert.match(main, /startRuntimeTunnel[\s\S]{0,500}proxyEnv/);
  assert.doesNotMatch(main, /settings\.httpsProxy\s*\?\s*\{\s*HTTPS_PROXY/);
});
