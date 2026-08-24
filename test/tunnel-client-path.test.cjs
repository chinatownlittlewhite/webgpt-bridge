const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

function api() {
  return require("../src/tunnel-client-path.cjs");
}

test("uses a valid custom tunnel-client override before the bundled client", () => {
  const { resolveTunnelClientPath } = api();
  const result = resolveTunnelClientPath({
    customPath: "/custom/tunnel-client",
    bundledPath: "/app/tunnel-client",
    isFile: (value) => value === "/custom/tunnel-client" || value === "/app/tunnel-client",
  });
  assert.equal(result, "/custom/tunnel-client");
});

test("falls back to the bundled tunnel-client when no custom override is configured", () => {
  const { resolveTunnelClientPath } = api();
  const result = resolveTunnelClientPath({
    customPath: "",
    bundledPath: "/app/tunnel-client",
    isFile: (value) => value === "/app/tunnel-client",
  });
  assert.equal(result, "/app/tunnel-client");
});

test("builds the packaged tunnel-client path for macOS and Windows", () => {
  const { bundledTunnelClientPath } = api();
  assert.equal(
    bundledTunnelClientPath({ resourcesPath: "/Applications/WebGPT Bridge.app/Contents/Resources", platform: "darwin" }),
    path.join("/Applications/WebGPT Bridge.app/Contents/Resources", "tunnel-client", "tunnel-client"),
  );
  assert.equal(
    bundledTunnelClientPath({ resourcesPath: "C:\\Program Files\\WebGPT Bridge\\resources", platform: "win32", pathImpl: path.win32 }),
    "C:\\Program Files\\WebGPT Bridge\\resources\\tunnel-client\\tunnel-client.exe",
  );
});
